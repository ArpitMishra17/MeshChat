/**
 * MeshChat Protocol v2 — versioned packets with addressing + TTL.
 *
 * Header (30 bytes fixed, laid out per PLAN.md Phase 1):
 *   [0]      version     = 0x02
 *   [1]      type        (HELLO / MESSAGE / ACK / POSITION / SYNC_*)
 *   [2]      flags       bit0 = encrypted (Phase 2), bit1 = has-position (Phase 4)
 *   [3]      ttl         decremented at each relay hop; packet dropped at 0 (Phase 3)
 *   [4..11]  msgId       8 bytes — random 64-bit id (dedup key for flooding)
 *   [12..19] src         8 bytes — sender fingerprint (Phase 2: pubkey hash)
 *   [20..27] dst         8 bytes — destination fingerprint; 0x00*8 = broadcast
 *   [28..29] payloadLen  2 bytes, big-endian
 *   [30..]   payload     (type-specific body, `payloadLen` bytes)
 *
 * NOTE on size: PLAN.md says "20-byte fixed header" but the field list it
 * gives sums to 30 (1+1+1+1+8+8+8+2). This implementation follows the field
 * list — HEADER_SIZE is 30. The discrepancy is a miscount in the plan; every
 * field and width listed there is honoured exactly.
 *
 * Packet types (header.type):
 *   0x01 HELLO       mutual handshake (pubkey + name + optional position)
 *   0x02 MESSAGE     chat message (payload encrypted from Phase 2)
 *   0x03 ACK         end-to-end delivery receipt, routed back like a MESSAGE
 *   0x04 POSITION    position beacon (Phase 4, reserved now)
 *   0x05 SYNC_OFFER  history sync (Phase 6, reserved now)
 *   0x06 SYNC_REQ    history sync (Phase 6, reserved now)
 *   0x07 CTRL        typing / read / reaction signals (best effort, never ACKed)
 *   0x08 MESSAGE_EXT MESSAGE + reply-to and/or attachment descriptor
 *   0x09 MEDIA       one chunk of an attachment
 *
 * Version negotiation: a v2 node receiving a v1 packet whose first byte is
 * 0x01 (v1 HANDSHAKE) or 0x03 (v1 ACK) sees version != 0x02 and drops it. A
 * v1 MESSAGE's first byte is 0x02, which collides with v2's version byte; the
 * next byte (v1's id-length, 0x10) is not a valid v2 type, so it is dropped
 * by type validation. No backward compatibility is provided — all test phones
 * update together (PLAN.md Phase 1, task 2).
 *
 * Fragmentation: the existing 0xF0 / 0xF1 / 0xF2 scheme (with the P0.6
 * fixes — per-buffer msgSeq tag + 10 s sweep) now wraps the *whole* v2 packet
 * (header + body), not just the serialized body. The scheme itself is
 * unchanged, so a v2 single-chunk packet's first byte is 0x02 (version),
 * which is distinct from the 0xF0+ fragment markers.
 *
 * The pure core (`encodePacket` / `decodePacket` and the body serializers)
 * has zero non-type imports — it is the part of the app that is cheaply
 * unit-testable without BLE hardware or expo native modules.
 */

import type {
  BLEPayload,
  HandshakePayload,
  MessagePayload,
  AckPayload,
  PositionPayload,
  ControlPayload,
  MediaChunkPayload,
  MediaKind,
  MediaMeta,
} from '../types';

// --- Protocol constants ---

export const PROTOCOL_VERSION = 0x02;
export const HEADER_SIZE = 30;

export const TYPE_HELLO = 0x01;
export const TYPE_MESSAGE = 0x02;
export const TYPE_ACK = 0x03;
export const TYPE_POSITION = 0x04;      // Phase 4 — geo position beacon
export const TYPE_SYNC_OFFER = 0x05;    // reserved — Phase 6
export const TYPE_SYNC_REQ = 0x06;      // reserved — Phase 6
export const TYPE_CTRL = 0x07;          // typing / read / reaction signals (encrypted, best effort)
export const TYPE_MESSAGE_EXT = 0x08;   // MESSAGE + reply-to and/or attachment descriptor
export const TYPE_MEDIA = 0x09;         // one chunk of an attachment

/** Attachment chunk size; keeps a chunk packet under the 255-fragment limit even at the 18-byte fallback chunk size. */
export const MEDIA_CHUNK_BYTES = 2800;
export const MAX_MEDIA_BYTES = 80 * 1024;
export const MAX_READ_IDS_PER_PACKET = 8;

export const FLAG_ENCRYPTED = 0x01;     // Phase 2
export const FLAG_HAS_POSITION = 0x02;  // Phase 4 — HELLO/POSITION carry geo coords
/**
 * Phase 4 — set by a relay that fell back to flooding for a unicast packet
 * (local minimum / unknown destination position). Downstream relays seeing
 * this bit skip the greedy check and keep flooding, so greedy/flood don't
 * oscillate. Excluded from the AES-GCM AAD (see `headerToAAD`) because relays
 * must be free to set it — only TTL and this routing bit are relay-mutable.
 */
export const FLAG_FLOOD_MODE = 0x04;

/** Default TTL for originated packets (Phase 3 floods with this). */
export const DEFAULT_TTL = 5;

export const FINGERPRINT_SIZE = 8;
export const MSGID_SIZE = 8;

/** All-zero dst = broadcast (delivered locally AND relayed by every node). */
export const BROADCAST_DST = new Uint8Array(FINGERPRINT_SIZE);

// Fragment markers (unchanged from v1 fragmentation scheme).
const TYPE_FRAG_START = 0xf0;
const TYPE_FRAG_CONTINUE = 0xf1;
const TYPE_FRAG_END = 0xf2;

// Conservative fallback when no MTU is known (peripheral-notify path).
const DEFAULT_CHUNK_SIZE = 18;
// P0.6 — reassembly buffers older than this are assumed orphaned (lost END).
export const REASSEMBLY_TTL_MS = 10_000;
/** Fragment markers, exported for the wire inspector's legend. */
export const FRAGMENT_MARKERS = [0xf0, 0xf1, 0xf2] as const;

// --- Errors ---

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Thrown when a packet's version byte is not PROTOCOL_VERSION. */
export class ProtocolVersionError extends ProtocolError {
  readonly receivedVersion: number;
  constructor(version: number) {
    super(
      `Unsupported protocol version: 0x${version.toString(16)} ` +
        `(expected 0x${PROTOCOL_VERSION.toString(16)})`,
    );
    this.name = 'ProtocolVersionError';
    this.receivedVersion = version;
  }
}

// --- Header / packet types ---

export interface PacketHeader {
  version: number;
  type: number;
  flags: number;
  ttl: number;
  msgId: Uint8Array;   // 8 bytes
  src: Uint8Array;     // 8 bytes
  dst: Uint8Array;     // 8 bytes
  payloadLen: number;
}

export interface DecodedPacket {
  header: PacketHeader;
  payload: Uint8Array; // body bytes, length === header.payloadLen
}

export interface PacketInput {
  type: number;
  /** Flags byte; defaults to 0 when omitted at the higher level. */
  flags?: number;
  ttl: number;
  /** 8-byte random packet id (flooding dedup key). */
  msgId: Uint8Array;
  /** 8-byte sender fingerprint. */
  src: Uint8Array;
  /** 8-byte destination fingerprint (use BROADCAST_DST for broadcast). */
  dst: Uint8Array;
  /** Type-specific body bytes. */
  payload: Uint8Array;
}

// --- UTF-8 (P0.8: TextEncoder/TextDecoder, available in Hermes on RN 0.83) ---

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function strToBytes(s: string): Uint8Array {
  return textEncoder.encode(s);
}

function bytesToStr(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

// --- Base64 ---

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --- Body (de)serialization — pure, no header type byte ---
//
// The v1 protocol prepended a 1-byte type to the payload body. In v2 the type
// lives in the header, so the body is just the type-specific fields. Length
// prefixes stay 1 byte (displayName / id / sender fields are well under 255
// bytes; message text is the un-prefixed tail and is bounded by payloadLen).
// Exported so the pure core is unit-testable in isolation.

export function encodeBody(payload: BLEPayload): Uint8Array {
  switch (payload.type) {
    case 'handshake': {
      // Phase 2 — HELLO carries the 32-byte X25519 public key + display
      // name. The fingerprint (deviceId) is derived from the pubkey by the
      // receiver, so it is not sent on the wire.
      // Phase 4 — if the sender has a GPS fix, the position is appended
      // (16 bytes: latE6, lonE6, ts) and FLAG_HAS_POSITION is set on the
      // packet header by the caller. The body is self-describing: a
      // receiver parses the position iff trailing bytes remain after the
      // name, so decodeBody needs no flags argument.
      const nameBytes = strToBytes(payload.displayName);
      const pubBytes = payload.publicKey;
      if (pubBytes.length !== 32) {
        throw new ProtocolError(`handshake public key must be 32 bytes, got ${pubBytes.length}`);
      }
      const posBytes = payload.position ? encodePositionBlock(payload.position) : null;
      const out = new Uint8Array(32 + 1 + nameBytes.length + (posBytes ? posBytes.length : 0));
      let p = 0;
      out.set(pubBytes, p); p += 32;
      out[p++] = nameBytes.length;
      out.set(nameBytes, p); p += nameBytes.length;
      if (posBytes) { out.set(posBytes, p); }
      return out;
    }
    case 'message': {
      if (hasMessageExt(payload)) return encodeMessageExtBody(payload);
      // P0.2 — ids are wire-safe 16-hex-char strings, never truncated.
      // Phase 2 — this body is encrypted end-to-end before framing; the
      // encrypted bytes become the packet payload (see encodeRawPacket).
      const idBytes = strToBytes(payload.id);
      const senderIdBytes = strToBytes(payload.senderDeviceId);
      const senderNameBytes = strToBytes(payload.senderDisplayName);
      const textBytes = strToBytes(payload.text);
      const out = new Uint8Array(
        1 + idBytes.length + 1 + senderIdBytes.length +
        1 + senderNameBytes.length + textBytes.length,
      );
      let p = 0;
      out[p++] = idBytes.length;
      out.set(idBytes, p); p += idBytes.length;
      out[p++] = senderIdBytes.length;
      out.set(senderIdBytes, p); p += senderIdBytes.length;
      out[p++] = senderNameBytes.length;
      out.set(senderNameBytes, p); p += senderNameBytes.length;
      out.set(textBytes, p);
      return out;
    }
    case 'ack': {
      const idBytes = strToBytes(payload.messageId);
      const out = new Uint8Array(1 + idBytes.length);
      let p = 0;
      out[p++] = idBytes.length;
      out.set(idBytes, p);
      return out;
    }
    case 'position': {
      // Phase 4 — [latE6: 4 signed BE][lonE6: 4 signed BE][timestamp: 8 BE].
      return encodePositionBlock(payload);
    }
    case 'control':
      return encodeControlBody(payload);
    case 'media':
      return encodeMediaBody(payload);
  }
}

export function decodeBody(type: number, bytes: Uint8Array): BLEPayload {
  switch (type) {
    case TYPE_HELLO: {
      // Phase 2 — [pubkey: 32][nameLen: 1][name]. The deviceId (fingerprint)
      // is NOT in the wire body; it is derived from the pubkey by the caller
      // (ble.ts) via `fingerprintHexFromPubKey`. We leave deviceId empty here
      // to keep protocol.ts free of crypto dependencies.
      // Phase 4 — [pubkey: 32][nameLen: 1][name][?latE6: 4][lonE6: 4][ts: 8].
      // The position block is present iff >= 16 trailing bytes remain after
      // the name (self-describing, so no flags argument is needed).
      if (bytes.length < 33) {
        throw new ProtocolError(`HELLO body too short: ${bytes.length} < 33`);
      }
      const publicKey = bytes.subarray(0, 32);
      const nameLen = bytes[32];
      const nameEnd = 33 + nameLen;
      const displayName = bytesToStr(bytes.subarray(33, nameEnd));
      let position: PositionPayload | null = null;
      if (bytes.length - nameEnd >= POSITION_BLOCK_SIZE) {
        position = decodePositionBlock(bytes.subarray(nameEnd));
      }
      return { type: 'handshake', deviceId: '', displayName, publicKey, position };
    }
    case TYPE_MESSAGE: {
      let offset = 0;
      const idLen = bytes[offset++];
      const id = bytesToStr(bytes.subarray(offset, offset + idLen));
      offset += idLen;
      const senderLen = bytes[offset++];
      const senderDeviceId = bytesToStr(bytes.subarray(offset, offset + senderLen));
      offset += senderLen;
      const senderNameLen = bytes[offset++];
      const senderDisplayName = bytesToStr(bytes.subarray(offset, offset + senderNameLen));
      offset += senderNameLen;
      const text = bytesToStr(bytes.subarray(offset));
      return {
        type: 'message',
        id,
        senderDeviceId,
        senderDisplayName,
        text,
        timestamp: Date.now(),
      };
    }
    case TYPE_ACK: {
      let offset = 0;
      const idLen = bytes[offset++];
      const messageId = bytesToStr(bytes.subarray(offset, offset + idLen));
      return { type: 'ack', messageId };
    }
    case TYPE_POSITION: {
      // Phase 4 — [latE6: 4][lonE6: 4][timestamp: 8].
      if (bytes.length < POSITION_BLOCK_SIZE) {
        throw new ProtocolError(`POSITION body too short: ${bytes.length} < ${POSITION_BLOCK_SIZE}`);
      }
      return decodePositionBlock(bytes);
    }
    case TYPE_MESSAGE_EXT:
      return decodeMessageExtBody(bytes);
    case TYPE_CTRL:
      return decodeControlBody(bytes);
    case TYPE_MEDIA:
      return decodeMediaBody(bytes);
    default:
      throw new ProtocolError(
        `Unsupported/reserved packet type: 0x${type.toString(16)}`,
      );
  }
}

function bodyType(payload: BLEPayload): number {
  switch (payload.type) {
    case 'handshake': return TYPE_HELLO;
    case 'message': return hasMessageExt(payload) ? TYPE_MESSAGE_EXT : TYPE_MESSAGE;
    case 'ack': return TYPE_ACK;
    case 'position': return TYPE_POSITION;
    case 'control': return TYPE_CTRL;
    case 'media': return TYPE_MEDIA;
  }
}

// --- Features batch: CTRL / MESSAGE_EXT / MEDIA bodies ---
//
// The new bodies are parsed with BodyReader, which bounds-checks every read
// and throws ProtocolError instead of returning undefined / NaN. The legacy
// MESSAGE / ACK decoders are deliberately left on their original code path so
// existing bytes and behaviour do not change.

const EXT_FLAG_REPLY = 0x01;
const EXT_FLAG_MEDIA = 0x04;
const EXT_KNOWN_FLAGS = EXT_FLAG_REPLY | EXT_FLAG_MEDIA;

const MEDIA_KIND_IMAGE = 1;
const MEDIA_KIND_AUDIO = 2;

const CTRL_TYPING = 0x01;
const CTRL_READ = 0x02;
const CTRL_REACTION = 0x03;

const MAX_EMOJI_BYTES = 16;

/** A MESSAGE needs the extended wire type when it carries reply-to or an attachment. */
function hasMessageExt(payload: MessagePayload): boolean {
  return !!payload.replyTo || !!payload.media;
}

class BodyReader {
  private readonly buf: Uint8Array;
  private readonly label: string;
  private pos = 0;

  constructor(buf: Uint8Array, label: string) {
    this.buf = buf;
    this.label = label;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  u8(what: string): number {
    this.need(1, what);
    return this.buf[this.pos++];
  }

  u16(what: string): number {
    this.need(2, what);
    const p = this.pos;
    this.pos += 2;
    return (this.buf[p] << 8) | this.buf[p + 1];
  }

  u32(what: string): number {
    this.need(4, what);
    const p = this.pos;
    this.pos += 4;
    // Multiply the high byte instead of shifting so the result stays unsigned.
    return this.buf[p] * 0x1000000 + ((this.buf[p + 1] << 16) | (this.buf[p + 2] << 8) | this.buf[p + 3]);
  }

  bytes(n: number, what: string): Uint8Array {
    this.need(n, what);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** 1-byte length prefix followed by UTF-8; `min` rejects empty ids. */
  str8(what: string, min: number): string {
    const len = this.u8(`${what} length`);
    if (len < min) {
      throw new ProtocolError(`${this.label}: ${what} must be at least ${min} byte(s), got ${len}`);
    }
    return bytesToStr(this.bytes(len, what));
  }

  rest(): Uint8Array {
    const out = this.buf.subarray(this.pos);
    this.pos = this.buf.length;
    return out;
  }

  end(): void {
    if (this.remaining !== 0) {
      throw new ProtocolError(`${this.label}: ${this.remaining} unexpected trailing byte(s)`);
    }
  }

  private need(n: number, what: string): void {
    if (this.remaining < n) {
      throw new ProtocolError(
        `${this.label}: truncated ${what} (need ${n}, have ${this.remaining})`,
      );
    }
  }
}

class BodyWriter {
  private readonly parts: Uint8Array[] = [];
  private size = 0;

  u8(v: number, what: string): void {
    this.uint(v, 1, what);
  }

  u16(v: number, what: string): void {
    this.uint(v, 2, what);
  }

  u32(v: number, what: string): void {
    this.uint(v, 4, what);
  }

  raw(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.size += bytes.length;
  }

  /** 1-byte length prefix followed by the bytes; `min` rejects empty ids. */
  lenBytes(bytes: Uint8Array, what: string, min: number): void {
    if (bytes.length < min || bytes.length > 0xff) {
      throw new ProtocolError(`${what} must be ${min}..255 bytes, got ${bytes.length}`);
    }
    this.u8(bytes.length, `${what} length`);
    this.raw(bytes);
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let p = 0;
    for (const part of this.parts) {
      out.set(part, p);
      p += part.length;
    }
    return out;
  }

  private uint(v: number, width: number, what: string): void {
    const max = Math.pow(2, 8 * width) - 1;
    if (!Number.isInteger(v) || v < 0 || v > max) {
      throw new ProtocolError(`${what} out of range: ${v}`);
    }
    const out = new Uint8Array(width);
    let rem = v;
    for (let i = width - 1; i >= 0; i--) {
      out[i] = rem % 256;
      rem = Math.floor(rem / 256);
    }
    this.raw(out);
  }
}

function encodeMessageExtBody(payload: MessagePayload): Uint8Array {
  const w = new BodyWriter();
  w.lenBytes(strToBytes(payload.id), 'message id', 1);
  w.lenBytes(strToBytes(payload.senderDeviceId), 'sender id', 0);
  w.lenBytes(strToBytes(payload.senderDisplayName), 'sender name', 0);
  let flags = 0;
  if (payload.replyTo) flags |= EXT_FLAG_REPLY;
  if (payload.media) flags |= EXT_FLAG_MEDIA;
  w.u8(flags, 'extFlags');
  if (payload.replyTo) w.lenBytes(strToBytes(payload.replyTo), 'replyTo id', 1);
  if (payload.media) writeMediaMeta(w, payload.media);
  // Text is the un-prefixed tail, so it may be empty (media-only message).
  w.raw(strToBytes(payload.text));
  return w.toBytes();
}

function decodeMessageExtBody(bytes: Uint8Array): MessagePayload {
  const r = new BodyReader(bytes, 'MESSAGE_EXT');
  const id = r.str8('message id', 1);
  const senderDeviceId = r.str8('sender id', 0);
  const senderDisplayName = r.str8('sender name', 0);
  const flags = r.u8('extFlags');
  if ((flags & ~EXT_KNOWN_FLAGS) !== 0) {
    throw new ProtocolError(`MESSAGE_EXT: unknown extFlags 0x${flags.toString(16)}`);
  }
  const msg: MessagePayload = {
    type: 'message',
    id,
    senderDeviceId,
    senderDisplayName,
    text: '',
    timestamp: Date.now(),
  };
  if (flags & EXT_FLAG_REPLY) msg.replyTo = r.str8('replyTo id', 1);
  if (flags & EXT_FLAG_MEDIA) msg.media = readMediaMeta(r);
  msg.text = bytesToStr(r.rest());
  return msg;
}

function writeMediaMeta(w: BodyWriter, meta: MediaMeta): void {
  let kindCode: number;
  if (meta.kind === 'image') kindCode = MEDIA_KIND_IMAGE;
  else if (meta.kind === 'audio') kindCode = MEDIA_KIND_AUDIO;
  else throw new ProtocolError(`unknown media kind: ${String(meta.kind)}`);
  if (!(meta.size >= 1)) throw new ProtocolError(`media size must be >= 1, got ${meta.size}`);
  if (!(meta.chunks >= 1)) throw new ProtocolError(`media chunks must be >= 1, got ${meta.chunks}`);
  w.u8(kindCode, 'media kind');
  w.u32(meta.size, 'media size');
  w.u16(meta.chunks, 'media chunks');
  w.lenBytes(strToBytes(meta.mime), 'media mime', 1);
  // Optional fields are always present on the wire; 0 means "not applicable".
  w.u32(meta.durationMs ?? 0, 'media durationMs');
  w.u16(meta.width ?? 0, 'media width');
  w.u16(meta.height ?? 0, 'media height');
}

function readMediaMeta(r: BodyReader): MediaMeta {
  const kindCode = r.u8('media kind');
  let kind: MediaKind;
  if (kindCode === MEDIA_KIND_IMAGE) kind = 'image';
  else if (kindCode === MEDIA_KIND_AUDIO) kind = 'audio';
  else throw new ProtocolError(`unknown media kind code: ${kindCode}`);
  const size = r.u32('media size');
  if (size === 0) throw new ProtocolError('media size must be >= 1');
  const chunks = r.u16('media chunks');
  if (chunks === 0) throw new ProtocolError('media chunks must be >= 1');
  const mime = r.str8('media mime', 1);
  const durationMs = r.u32('media durationMs');
  const width = r.u16('media width');
  const height = r.u16('media height');
  const meta: MediaMeta = { kind, size, chunks, mime };
  if (durationMs > 0) meta.durationMs = durationMs;
  if (width > 0) meta.width = width;
  if (height > 0) meta.height = height;
  return meta;
}

function encodeControlBody(payload: ControlPayload): Uint8Array {
  const w = new BodyWriter();
  switch (payload.sub) {
    case 'typing':
      w.u8(CTRL_TYPING, 'ctrl sub');
      w.u8(payload.typing ? 1 : 0, 'typing state');
      return w.toBytes();
    case 'read':
      if (payload.ids.length < 1 || payload.ids.length > MAX_READ_IDS_PER_PACKET) {
        throw new ProtocolError(
          `read receipt must carry 1..${MAX_READ_IDS_PER_PACKET} ids, got ${payload.ids.length}`,
        );
      }
      w.u8(CTRL_READ, 'ctrl sub');
      w.u8(payload.ids.length, 'read count');
      for (const id of payload.ids) w.lenBytes(strToBytes(id), 'read id', 1);
      return w.toBytes();
    case 'reaction': {
      const emoji = strToBytes(payload.emoji);
      if (emoji.length < 1 || emoji.length > MAX_EMOJI_BYTES) {
        throw new ProtocolError(`emoji must be 1..${MAX_EMOJI_BYTES} bytes, got ${emoji.length}`);
      }
      w.u8(CTRL_REACTION, 'ctrl sub');
      w.lenBytes(strToBytes(payload.messageId), 'reaction message id', 1);
      w.u8(payload.add ? 1 : 0, 'reaction op');
      w.raw(emoji);
      return w.toBytes();
    }
    default:
      throw new ProtocolError('unknown control sub-type');
  }
}

function decodeControlBody(bytes: Uint8Array): ControlPayload {
  const r = new BodyReader(bytes, 'CTRL');
  const sub = r.u8('ctrl sub');
  switch (sub) {
    case CTRL_TYPING: {
      const state = r.u8('typing state');
      if (state > 1) throw new ProtocolError(`CTRL typing: invalid state ${state}`);
      r.end();
      return { type: 'control', sub: 'typing', typing: state === 1 };
    }
    case CTRL_READ: {
      const n = r.u8('read count');
      if (n < 1 || n > MAX_READ_IDS_PER_PACKET) {
        throw new ProtocolError(`CTRL read: count ${n} outside 1..${MAX_READ_IDS_PER_PACKET}`);
      }
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push(r.str8('read id', 1));
      r.end();
      return { type: 'control', sub: 'read', ids };
    }
    case CTRL_REACTION: {
      const messageId = r.str8('reaction message id', 1);
      const op = r.u8('reaction op');
      if (op > 1) throw new ProtocolError(`CTRL reaction: invalid op ${op}`);
      const emoji = r.rest();
      if (emoji.length < 1 || emoji.length > MAX_EMOJI_BYTES) {
        throw new ProtocolError(`CTRL reaction: emoji must be 1..${MAX_EMOJI_BYTES} bytes, got ${emoji.length}`);
      }
      return {
        type: 'control',
        sub: 'reaction',
        messageId,
        emoji: bytesToStr(emoji),
        add: op === 1,
      };
    }
    default:
      throw new ProtocolError(`unknown CTRL sub-type: 0x${sub.toString(16)}`);
  }
}

function encodeMediaBody(payload: MediaChunkPayload): Uint8Array {
  if (payload.data.length < 1 || payload.data.length > MEDIA_CHUNK_BYTES) {
    throw new ProtocolError(
      `media chunk must be 1..${MEDIA_CHUNK_BYTES} bytes, got ${payload.data.length}`,
    );
  }
  const w = new BodyWriter();
  w.lenBytes(strToBytes(payload.messageId), 'media message id', 1);
  w.u16(payload.index, 'media chunk index');
  w.raw(payload.data);
  return w.toBytes();
}

function decodeMediaBody(bytes: Uint8Array): MediaChunkPayload {
  const r = new BodyReader(bytes, 'MEDIA');
  const messageId = r.str8('media message id', 1);
  const index = r.u16('media chunk index');
  const data = r.rest();
  if (data.length < 1 || data.length > MEDIA_CHUNK_BYTES) {
    throw new ProtocolError(`MEDIA: chunk must be 1..${MEDIA_CHUNK_BYTES} bytes, got ${data.length}`);
  }
  // Copy so a stored chunk does not pin the whole BLE packet buffer.
  return { type: 'media', messageId, index, data: data.slice() };
}

// --- Phase 4: position block (shared by HELLO and POSITION) ---
//
// Layout (16 bytes, big-endian):
//   [0..3]   latE6  — signed 32-bit, latitude × 1e6 (microdegrees)
//   [4..7]   lonE6  — signed 32-bit, longitude × 1e6
//   [8..15]  timestamp — unsigned 64-bit, ms since epoch (sender's clock)
//
// latE6 range: ±180_000_000, fits in int32. The position provider truncates
// to ~3 decimal places (millidegrees, ~110 m) before encoding for privacy,
// so the low 3 digits of latE6 are always zero on the wire. Decoding
// reconstructs the float by dividing by 1e6.

export const POSITION_BLOCK_SIZE = 16;

function encodePositionBlock(pos: { lat: number; lon: number; timestamp: number }): Uint8Array {
  const out = new Uint8Array(POSITION_BLOCK_SIZE);
  const latE6 = Math.round(pos.lat * 1e6);
  const lonE6 = Math.round(pos.lon * 1e6);
  // Signed 32-bit big-endian via unsigned shift (two's complement).
  out[0] = (latE6 >>> 24) & 0xff;
  out[1] = (latE6 >>> 16) & 0xff;
  out[2] = (latE6 >>> 8) & 0xff;
  out[3] = latE6 & 0xff;
  out[4] = (lonE6 >>> 24) & 0xff;
  out[5] = (lonE6 >>> 16) & 0xff;
  out[6] = (lonE6 >>> 8) & 0xff;
  out[7] = lonE6 & 0xff;
  // 64-bit timestamp (ms). JS bitwise is 32-bit, so write hi/lo as numbers.
  const ts = Math.floor(pos.timestamp);
  const hi = Math.floor(ts / 0x100000000);
  const lo = ts >>> 0;
  out[8] = (hi >>> 24) & 0xff;
  out[9] = (hi >>> 16) & 0xff;
  out[10] = (hi >>> 8) & 0xff;
  out[11] = hi & 0xff;
  out[12] = (lo >>> 24) & 0xff;
  out[13] = (lo >>> 16) & 0xff;
  out[14] = (lo >>> 8) & 0xff;
  out[15] = lo & 0xff;
  return out;
}

function decodePositionBlock(bytes: Uint8Array): PositionPayload {
  // Signed 32-bit reconstruction: << 24 sign-extends in JS's 32-bit math.
  const latE6 = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  const lonE6 = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  const hi = (bytes[8] * 0x1000000) + (bytes[9] << 16) + (bytes[10] << 8) + bytes[11];
  const lo = (bytes[12] * 0x1000000) + (bytes[13] << 16) + (bytes[14] << 8) + bytes[15];
  const timestamp = hi * 0x100000000 + lo;
  return {
    type: 'position',
    lat: latE6 / 1e6,
    lon: lonE6 / 1e6,
    timestamp,
  };
}

// --- Pure packet encode / decode (the unit-testable core) ---

export function encodePacket(input: PacketInput): Uint8Array {
  if (input.msgId.length !== MSGID_SIZE) {
    throw new ProtocolError(`msgId must be ${MSGID_SIZE} bytes, got ${input.msgId.length}`);
  }
  if (input.src.length !== FINGERPRINT_SIZE) {
    throw new ProtocolError(`src must be ${FINGERPRINT_SIZE} bytes, got ${input.src.length}`);
  }
  if (input.dst.length !== FINGERPRINT_SIZE) {
    throw new ProtocolError(`dst must be ${FINGERPRINT_SIZE} bytes, got ${input.dst.length}`);
  }
  if (input.payload.length > 0xffff) {
    throw new ProtocolError(`payload too large: ${input.payload.length} > 65535`);
  }
  const flags = input.flags ?? 0;
  const out = new Uint8Array(HEADER_SIZE + input.payload.length);
  let p = 0;
  out[p++] = PROTOCOL_VERSION;
  out[p++] = input.type;
  out[p++] = flags;
  out[p++] = input.ttl;
  out.set(input.msgId, p); p += MSGID_SIZE;
  out.set(input.src, p); p += FINGERPRINT_SIZE;
  out.set(input.dst, p); p += FINGERPRINT_SIZE;
  out[p++] = (input.payload.length >> 8) & 0xff;
  out[p++] = input.payload.length & 0xff;
  out.set(input.payload, p);
  return out;
}

export function decodePacket(bytes: Uint8Array): DecodedPacket {
  if (bytes.length < HEADER_SIZE) {
    throw new ProtocolError(`Truncated header: ${bytes.length} < ${HEADER_SIZE}`);
  }
  const version = bytes[0];
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolVersionError(version);
  }
  const type = bytes[1];
  const flags = bytes[2];
  const ttl = bytes[3];
  const msgId = bytes.subarray(4, 4 + MSGID_SIZE);
  const srcOff = 4 + MSGID_SIZE;
  const src = bytes.subarray(srcOff, srcOff + FINGERPRINT_SIZE);
  const dstOff = srcOff + FINGERPRINT_SIZE;
  const dst = bytes.subarray(dstOff, dstOff + FINGERPRINT_SIZE);
  const payloadLen = (bytes[HEADER_SIZE - 2] << 8) | bytes[HEADER_SIZE - 1];
  if (bytes.length < HEADER_SIZE + payloadLen) {
    throw new ProtocolError(
      `Truncated payload: have ${bytes.length - HEADER_SIZE}, declared ${payloadLen}`,
    );
  }
  const payload = bytes.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);
  return {
    header: { version, type, flags, ttl, msgId, src, dst, payloadLen },
    payload,
  };
}

// --- Phase 2: AAD helpers ---
//
// The encrypted MESSAGE payload binds the packet header as Additional
// Authenticated Data (AAD) so a relay cannot alter src/dst/msgId without
// the ciphertext failing to authenticate. TTL is excluded (relays
// decrement it) — we zero byte[3] of the header before using it as AAD.

/**
 * Build the raw 30-byte header from individual fields. Used by ble.ts to
 * compute the AAD *before* encrypting the payload (the encrypted length is
 * deterministic: nonce + plaintext + tag, so payloadLen is known up front).
 */
export function buildHeaderBytes(input: {
  type: number;
  flags: number;
  ttl: number;
  msgId: Uint8Array;
  src: Uint8Array;
  dst: Uint8Array;
  payloadLen: number;
}): Uint8Array {
  if (input.msgId.length !== MSGID_SIZE) {
    throw new ProtocolError(`msgId must be ${MSGID_SIZE} bytes`);
  }
  if (input.src.length !== FINGERPRINT_SIZE) {
    throw new ProtocolError(`src must be ${FINGERPRINT_SIZE} bytes`);
  }
  if (input.dst.length !== FINGERPRINT_SIZE) {
    throw new ProtocolError(`dst must be ${FINGERPRINT_SIZE} bytes`);
  }
  const out = new Uint8Array(HEADER_SIZE);
  let p = 0;
  out[p++] = PROTOCOL_VERSION;
  out[p++] = input.type;
  out[p++] = input.flags;
  out[p++] = input.ttl;
  out.set(input.msgId, p); p += MSGID_SIZE;
  out.set(input.src, p); p += FINGERPRINT_SIZE;
  out.set(input.dst, p); p += FINGERPRINT_SIZE;
  out[p++] = (input.payloadLen >> 8) & 0xff;
  out[p++] = input.payloadLen & 0xff;
  return out;
}

/**
 * Copy raw header bytes and produce the AAD for AES-GCM by zeroing the
 * relay-mutable fields. The copy ensures the original packet bytes are not
 * modified.
 *
 * Two header fields are relay-mutable and therefore excluded from the AAD:
 *   - **TTL** (byte[3]) — relays decrement it at each hop.
 *   - **FLAG_FLOOD_MODE** (bit 2 of byte[2], the flags byte) — Phase 4: a
 *     relay that falls back to flooding sets this bit so downstream nodes
 *     keep flooding instead of oscillating back to greedy.
 *
 * Every other header field (version, type, FLAG_ENCRYPTED, FLAG_HAS_POSITION,
 * msgId, src, dst, payloadLen) is immutable and authenticated — a relay
 * cannot alter src/dst/msgId or flip the encrypted flag without the
 * ciphertext failing to authenticate at the destination.
 */
export function headerToAAD(headerBytes: Uint8Array): Uint8Array {
  if (headerBytes.length < HEADER_SIZE) {
    throw new ProtocolError(`header bytes must be >= ${HEADER_SIZE}, got ${headerBytes.length}`);
  }
  const aad = new Uint8Array(HEADER_SIZE);
  aad.set(headerBytes.subarray(0, HEADER_SIZE));
  aad[3] = 0; // zero TTL
  aad[2] = aad[2] & ~FLAG_FLOOD_MODE; // clear flood-mode (routing metadata)
  return aad;
}

// --- Fragmentation (wraps the whole v2 packet) ---

export interface EncodeContext {
  /** 8-byte sender fingerprint. */
  src: Uint8Array;
  /** 8-byte destination fingerprint; omit (or pass BROADCAST_DST) for broadcast. */
  dst?: Uint8Array;
  /** Random 8-byte packet id (flooding dedup key). */
  msgId: Uint8Array;
  /** Hop limit. Defaults to DEFAULT_TTL. */
  ttl?: number;
  /** Flags byte. Defaults to 0 (Phase 2 sets FLAG_ENCRYPTED). */
  flags?: number;
  /** Negotiated ATT MTU (central path). Omit on the peripheral-notify path. */
  mtu?: number;
}

function resolveChunkSize(mtu?: number): number {
  if (!mtu || mtu <= 3) return DEFAULT_CHUNK_SIZE;
  return mtu - 3;
}

/**
 * Monotonic per-process counter for fragment `msgSeq` tags. Wrapping at 0xff
 * is fine — collisions only matter within the ~10 s reassembly window, and a
 * fresh message that reuses an old msgSeq has already evicted the old buffer
 * on its FRAG_START.
 */
let msgSeqCounter = 0;
function nextMsgSeq(): number {
  msgSeqCounter = (msgSeqCounter + 1) & 0xff;
  return msgSeqCounter;
}

function fragment(packet: Uint8Array, mtu?: number): string[] {
  const chunkSize = resolveChunkSize(mtu);

  // Fits in one chunk — send raw (no fragment header). The first byte is the
  // version (0x02), distinct from the 0xF0+ fragment markers, so the receiver
  // treats it as a non-fragmented packet.
  if (packet.length <= chunkSize) {
    return [bytesToBase64(packet)];
  }

  // First chunk carries a 5-byte header (type + totalLen(2) + seqTotal + msgSeq);
  // continue/end carry 3 bytes (type + seqNum + msgSeq).
  const firstDataSize = chunkSize - 5;
  const contDataSize = chunkSize - 3;

  if (firstDataSize <= 0 || contDataSize <= 0) {
    // MTU too small to fragment — fall back to the default chunk size rather
    // than emitting zero-length data chunks.
    return fragment(packet, DEFAULT_CHUNK_SIZE + 3);
  }

  const dataChunks: Uint8Array[] = [];
  let pos = 0;
  dataChunks.push(packet.subarray(pos, pos + firstDataSize));
  pos += firstDataSize;
  while (pos < packet.length) {
    dataChunks.push(packet.subarray(pos, pos + contDataSize));
    pos += contDataSize;
  }

  const seqTotal = dataChunks.length;
  const totalLen = packet.length;
  // P0.6 — tag every fragment of this message so a stale fragment from a
  // previous (aborted) message cannot be misassembled into this one.
  const msgSeq = nextMsgSeq();
  const fragments: string[] = [];

  for (let i = 0; i < dataChunks.length; i++) {
    const data = dataChunks[i];
    let fragBytes: Uint8Array;
    if (i === 0) {
      fragBytes = new Uint8Array(5 + data.length);
      let p = 0;
      fragBytes[p++] = TYPE_FRAG_START;
      fragBytes[p++] = (totalLen >> 8) & 0xff;
      fragBytes[p++] = totalLen & 0xff;
      fragBytes[p++] = seqTotal;
      fragBytes[p++] = msgSeq;
      fragBytes.set(data, p);
    } else if (i === dataChunks.length - 1) {
      fragBytes = new Uint8Array(3 + data.length);
      let p = 0;
      fragBytes[p++] = TYPE_FRAG_END;
      fragBytes[p++] = i;
      fragBytes[p++] = msgSeq;
      fragBytes.set(data, p);
    } else {
      fragBytes = new Uint8Array(3 + data.length);
      let p = 0;
      fragBytes[p++] = TYPE_FRAG_CONTINUE;
      fragBytes[p++] = i;
      fragBytes[p++] = msgSeq;
      fragBytes.set(data, p);
    }
    fragments.push(bytesToBase64(fragBytes));
  }

  return fragments;
}

/**
 * Phase 3 — Re-fragment an already-assembled v2 packet for forwarding.
 *
 * Relays decrement the TTL byte (byte[3]) of the raw packet and re-send it to
 * their neighbors. Because TTL is excluded from the AES-GCM AAD
 * (`headerToAAD` zeroes it), mutating the TTL does NOT invalidate the
 * ciphertext — the destination still decrypts successfully. The rest of the
 * header (src/dst/msgId/flags/payloadLen) and the encrypted payload are
 * preserved byte-for-byte, so the transport-level `msgId` dedup key is stable
 * across hops.
 *
 * Callers should pass a *copy* of the packet bytes if they intend to mutate
 * TTL (subarray views share the underlying buffer with `headerBytes`).
 */
export function fragmentPacket(packet: Uint8Array, mtu?: number): string[] {
  return fragment(packet, mtu);
}

// --- Reassembly ---

interface ReassemblyBuffer {
  totalLen: number;
  seqTotal: number;
  msgSeq: number;
  chunks: Map<number, Uint8Array>;
  createdAt: number;
}

const reassemblyBuffers = new Map<string, ReassemblyBuffer>();
let reassemblyCompleted = 0;
let reassemblyDiscarded = 0;

/**
 * Live view of fragment reassembly for the wire inspector: buffers currently
 * waiting on fragments, plus cumulative completed / discarded counts.
 */
export function getReassemblyStats(): {
  inFlight: { received: number; total: number; ageMs: number }[];
  completed: number;
  discarded: number;
} {
  const now = Date.now();
  return {
    inFlight: Array.from(reassemblyBuffers.values()).map(b => ({
      received: b.chunks.size,
      total: b.seqTotal,
      ageMs: now - b.createdAt,
    })),
    completed: reassemblyCompleted,
    discarded: reassemblyDiscarded,
  };
}

function sweepStaleBuffers(): void {
  const now = Date.now();
  for (const [key, buf] of reassemblyBuffers) {
    if (now - buf.createdAt > REASSEMBLY_TTL_MS) {
      console.warn(
        `[Protocol] Discarding stale reassembly buffer for ${key} ` +
          `(${now - buf.createdAt}ms old)`,
      );
      reassemblyBuffers.delete(key);
      reassemblyDiscarded += 1;
    }
  }
}

function reassemble(buffer: ReassemblyBuffer): Uint8Array | null {
  const out = new Uint8Array(buffer.totalLen);
  let offset = 0;
  for (let i = 0; i < buffer.seqTotal; i++) {
    const chunk = buffer.chunks.get(i);
    if (!chunk) {
      console.warn(`[Protocol] Missing fragment ${i}`);
      return null;
    }
    // Defensive: a malformed sender could over-claim seqTotal; never write
    // past the declared total length.
    const writeLen = Math.min(chunk.length, buffer.totalLen - offset);
    if (writeLen <= 0) break;
    out.set(chunk.subarray(0, writeLen), offset);
    offset += writeLen;
  }
  return out.subarray(0, buffer.totalLen);
}

// --- High-level BLE-facing API ---
//
// `encodeBLEPayload` ties together body serialization, packet framing, and
// fragmentation. `decodeBLEChunk` is the inverse: defragment, decode the
// packet, deserialize the body. Both keep the same base64-in / base64-out
// shape the BLE layer had under v1, so only the encode-call construction
// (passing src/dst/msgId) changes in ble.ts.
//
// Phase 2 adds two lower-level entry points for encrypted MESSAGE traffic:
//  - `encodeRawPacket(type, rawPayload, ctx)` frames pre-serialized (or
//    pre-encrypted) bytes without running `encodeBody`.
//  - `decodeBLEChunkRaw(base64, sourceKey)` stops after packet decode and
//    returns the raw header + payload bytes, so ble.ts can decrypt before
//    `decodeBody` runs.

export function encodeBLEPayload(payload: BLEPayload, ctx: EncodeContext): string[] {
  const body = encodeBody(payload);
  return encodeRawPacket(bodyType(payload), body, ctx);
}

/**
 * Frame raw payload bytes (already serialized or encrypted) as a v2 packet
 * and fragment it. Used by Phase 2's encrypted MESSAGE path: ble.ts
 * encrypts the message body, then calls this with `type = TYPE_MESSAGE`
 * and `flags |= FLAG_ENCRYPTED`.
 */
export function encodeRawPacket(
  type: number,
  rawPayload: Uint8Array,
  ctx: EncodeContext,
): string[] {
  const packet = encodePacket({
    type,
    flags: ctx.flags ?? 0,
    ttl: ctx.ttl ?? DEFAULT_TTL,
    msgId: ctx.msgId,
    src: ctx.src,
    dst: ctx.dst ?? BROADCAST_DST,
    payload: rawPayload,
  });
  return fragment(packet, ctx.mtu);
}

export function decodeBLEChunk(
  base64Value: string,
  sourceKey: string = 'default',
): BLEPayload | null {
  const decoded = decodeBLEChunkFull(base64Value, sourceKey);
  return decoded ? decoded.payload : null;
}

/**
 * Like `decodeBLEChunk` but also returns the decoded header. Phase 3's relay
 * engine needs src/dst/ttl/msgId to make routing decisions; Phase 1 only uses
 * the payload, but exposing the header keeps the surface stable.
 */
export function decodeBLEChunkFull(
  base64Value: string,
  sourceKey: string = 'default',
): { header: PacketHeader; payload: BLEPayload } | null {
  const raw = decodeBLEChunkRaw(base64Value, sourceKey);
  if (!raw) return null;
  try {
    const body = decodeBody(raw.header.type, raw.payload);
    return { header: raw.header, payload: body };
  } catch (e) {
    if (e instanceof ProtocolError) {
      console.warn('[Protocol] Dropping malformed body:', e.message);
    } else {
      console.warn('[Protocol] Failed to decode body:', e instanceof Error ? e.message : e);
    }
    return null;
  }
}

/**
 * Phase 2 — Reassemble fragments and decode the packet, but return the raw
 * payload bytes (before body deserialization). This lets ble.ts decrypt an
 * encrypted MESSAGE payload before running `decodeBody`.
 *
 * Returns the header struct, the raw 30-byte header bytes (for AAD
 * computation via `headerToAAD`), and the raw payload bytes.
 *
 * Phase 3 — also returns `packetBytes`: the full assembled packet
 * (header + payload). The relay engine needs the whole packet to decrement
 * TTL and re-fragment it for forwarding without re-encoding (re-encoding
 * would change the msgId dedup key). `headerBytes` and `payload` are subarray
 * views into the same buffer, so callers that mutate TTL must copy first.
 */
export function decodeBLEChunkRaw(
  base64Value: string,
  sourceKey: string = 'default',
): { header: PacketHeader; headerBytes: Uint8Array; payload: Uint8Array; packetBytes: Uint8Array } | null {
  const bytes = base64ToBytes(base64Value);
  if (bytes.length === 0) return null;

  const firstByte = bytes[0];

  // Non-fragmented packet — decode directly. (Version 0x02 is distinct from
  // the 0xF0+ fragment markers.)
  if (
    firstByte !== TYPE_FRAG_START &&
    firstByte !== TYPE_FRAG_CONTINUE &&
    firstByte !== TYPE_FRAG_END
  ) {
    return decodePacketToRaw(bytes);
  }

  // Opportunistic sweep — cheap and prevents unbounded growth (P0.6).
  sweepStaleBuffers();

  if (firstByte === TYPE_FRAG_START) {
    const totalLen = (bytes[1] << 8) | bytes[2];
    const seqTotal = bytes[3];
    const msgSeq = bytes[4];
    const data = bytes.subarray(5);
    // A new FRAG_START always supersedes any in-flight buffer for this source
    // (the previous message was either completed or abandoned).
    reassemblyBuffers.set(sourceKey, {
      totalLen,
      seqTotal,
      msgSeq,
      chunks: new Map([[0, data]]),
      createdAt: Date.now(),
    });
    return null;
  }

  // CONTINUE / END
  const seqNum = bytes[1];
  const msgSeq = bytes[2];
  const data = bytes.subarray(3);
  const buffer = reassemblyBuffers.get(sourceKey);
  if (!buffer) {
    console.warn('[Protocol] Received fragment without start');
    return null;
  }

  // P0.6 — reject fragments from a different message in flight.
  if (buffer.msgSeq !== msgSeq) {
    console.warn(
      `[Protocol] Discarding fragment seq=${seqNum} msgSeq=${msgSeq} ` +
        `(buffer has msgSeq=${buffer.msgSeq})`,
    );
    return null;
  }

  buffer.chunks.set(seqNum, data);

  if (firstByte === TYPE_FRAG_END) {
    const assembled = reassemble(buffer);
    reassemblyBuffers.delete(sourceKey);
    if (!assembled) {
      reassemblyDiscarded += 1;
      return null;
    }
    reassemblyCompleted += 1;
    return decodePacketToRaw(assembled);
  }

  return null;
}

function decodePacketToRaw(
  bytes: Uint8Array,
): { header: PacketHeader; headerBytes: Uint8Array; payload: Uint8Array; packetBytes: Uint8Array } | null {
  try {
    const { header, payload } = decodePacket(bytes);
    // The raw header bytes (first HEADER_SIZE) are needed for AAD computation
    // (Phase 2 encryption). Return a subarray view; `headerToAAD` copies
    // before zeroing the ttl byte, so the original packet bytes are untouched.
    const headerBytes = bytes.subarray(0, HEADER_SIZE);
    // Phase 3 — the full assembled packet, for the relay engine to forward.
    // `headerBytes` and `payload` are views into this same buffer.
    return { header, headerBytes, payload, packetBytes: bytes };
  } catch (e) {
    // P1 task 2 — version mismatch (v1 packet) / truncation / malformed body.
    // Log and drop rather than propagating: a single bad chunk must not kill
    // the BLE monitor callback that received it.
    if (e instanceof ProtocolVersionError) {
      console.warn(`[Protocol] Dropping packet: ${e.message}`);
    } else if (e instanceof ProtocolError) {
      console.warn('[Protocol] Dropping malformed packet:', e.message);
    } else {
      console.warn('[Protocol] Failed to decode packet:', e instanceof Error ? e.message : e);
    }
    return null;
  }
}

// --- Test helpers (not used on production paths) ---

export function _clearReassemblyBuffers(): void {
  reassemblyBuffers.clear();
  reassemblyCompleted = 0;
  reassemblyDiscarded = 0;
}

export function _resetMsgSeq(): void {
  msgSeqCounter = 0;
}
