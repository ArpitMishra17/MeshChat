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
} from '../types';

// --- Protocol constants ---

export const PROTOCOL_VERSION = 0x02;
export const HEADER_SIZE = 30;

export const TYPE_HELLO = 0x01;
export const TYPE_MESSAGE = 0x02;
export const TYPE_ACK = 0x03;
export const TYPE_POSITION = 0x04;      // reserved — Phase 4
export const TYPE_SYNC_OFFER = 0x05;    // reserved — Phase 6
export const TYPE_SYNC_REQ = 0x06;      // reserved — Phase 6

export const FLAG_ENCRYPTED = 0x01;     // Phase 2
export const FLAG_HAS_POSITION = 0x02;  // Phase 4

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
const REASSEMBLY_TTL_MS = 10_000;

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
      const nameBytes = strToBytes(payload.displayName);
      const pubBytes = payload.publicKey;
      if (pubBytes.length !== 32) {
        throw new ProtocolError(`handshake public key must be 32 bytes, got ${pubBytes.length}`);
      }
      const out = new Uint8Array(32 + 1 + nameBytes.length);
      let p = 0;
      out.set(pubBytes, p); p += 32;
      out[p++] = nameBytes.length;
      out.set(nameBytes, p);
      return out;
    }
    case 'message': {
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
  }
}

export function decodeBody(type: number, bytes: Uint8Array): BLEPayload {
  switch (type) {
    case TYPE_HELLO: {
      // Phase 2 — [pubkey: 32][nameLen: 1][name]. The deviceId (fingerprint)
      // is NOT in the wire body; it is derived from the pubkey by the caller
      // (ble.ts) via `fingerprintHexFromPubKey`. We leave deviceId empty here
      // to keep protocol.ts free of crypto dependencies.
      if (bytes.length < 33) {
        throw new ProtocolError(`HELLO body too short: ${bytes.length} < 33`);
      }
      const publicKey = bytes.subarray(0, 32);
      const nameLen = bytes[32];
      const displayName = bytesToStr(bytes.subarray(33, 33 + nameLen));
      return { type: 'handshake', deviceId: '', displayName, publicKey };
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
    default:
      throw new ProtocolError(
        `Unsupported/reserved packet type: 0x${type.toString(16)}`,
      );
  }
}

function bodyType(payload: BLEPayload): number {
  switch (payload.type) {
    case 'handshake': return TYPE_HELLO;
    case 'message': return TYPE_MESSAGE;
    case 'ack': return TYPE_ACK;
  }
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
 * Copy raw header bytes and zero the TTL byte (byte[3]) to produce the AAD
 * for AES-GCM. The copy ensures the original packet bytes are not modified.
 * TTL must be excluded from AAD because relays decrement it at each hop;
 * every other header field is immutable and is authenticated.
 */
export function headerToAAD(headerBytes: Uint8Array): Uint8Array {
  if (headerBytes.length < HEADER_SIZE) {
    throw new ProtocolError(`header bytes must be >= ${HEADER_SIZE}, got ${headerBytes.length}`);
  }
  const aad = new Uint8Array(HEADER_SIZE);
  aad.set(headerBytes.subarray(0, HEADER_SIZE));
  aad[3] = 0; // zero TTL
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

// --- Reassembly ---

interface ReassemblyBuffer {
  totalLen: number;
  seqTotal: number;
  msgSeq: number;
  chunks: Map<number, Uint8Array>;
  createdAt: number;
}

const reassemblyBuffers = new Map<string, ReassemblyBuffer>();

function sweepStaleBuffers(): void {
  const now = Date.now();
  for (const [key, buf] of reassemblyBuffers) {
    if (now - buf.createdAt > REASSEMBLY_TTL_MS) {
      console.warn(
        `[Protocol] Discarding stale reassembly buffer for ${key} ` +
          `(${now - buf.createdAt}ms old)`,
      );
      reassemblyBuffers.delete(key);
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
 */
export function decodeBLEChunkRaw(
  base64Value: string,
  sourceKey: string = 'default',
): { header: PacketHeader; headerBytes: Uint8Array; payload: Uint8Array } | null {
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
    if (!assembled) return null;
    return decodePacketToRaw(assembled);
  }

  return null;
}

function decodePacketToRaw(
  bytes: Uint8Array,
): { header: PacketHeader; headerBytes: Uint8Array; payload: Uint8Array } | null {
  try {
    const { header, payload } = decodePacket(bytes);
    // The raw header bytes (first HEADER_SIZE) are needed for AAD computation
    // (Phase 2 encryption). Return a subarray view; `headerToAAD` copies
    // before zeroing the ttl byte, so the original packet bytes are untouched.
    const headerBytes = bytes.subarray(0, HEADER_SIZE);
    return { header, headerBytes, payload };
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
}

export function _resetMsgSeq(): void {
  msgSeqCounter = 0;
}
