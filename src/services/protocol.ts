/**
 * Binary protocol for BLE message encoding/decoding.
 * Inspired by BitChat's compact packet format.
 *
 * Packet format:
 *   [type: 1 byte] [payload bytes...]
 *
 * Types:
 *   0x01 = handshake:  [nameLen: 1] [name: utf8] [idLen: 1] [id: utf8]
 *   0x02 = message:    [idLen: 1] [id: utf8] [senderLen: 1] [senderId: utf8]
 *                      [senderNameLen: 1] [senderName: utf8] [text: utf8 rest]
 *   0x03 = ack:        [idLen: 1] [id: utf8]
 *
 * Fragmentation (for payloads > chunkSize):
 *   0xF0 = fragmentStart:    [totalLen: 2 BE] [seqTotal: 1] [msgSeq: 1] [data...]
 *   0xF1 = fragmentContinue: [seqNum: 1] [msgSeq: 1] [data...]
 *   0xF2 = fragmentEnd:      [seqNum: 1] [msgSeq: 1] [data...]
 *
 * P0.2 — ids are 16 hex chars everywhere (no truncation on the wire).
 * P0.6 — a 1-byte msgSeq tags every fragment of a message so a stale
 *        FRAG_CONTINUE from message N cannot land in message N+1's buffer.
 *        Reassembly buffers also carry a timestamp and are swept after 10 s.
 * P0.7 — encodePayload accepts the negotiated MTU so chunks fill the link
 *        instead of being stuck at 18 bytes.
 * P0.8 — UTF-8 codec is TextEncoder/TextDecoder (Hermes ships both on
 *        RN 0.83), replacing the hand-rolled CESU-8 codec.
 */

import type {
  BLEPayload,
  HandshakePayload,
  MessagePayload,
  AckPayload,
} from '../types';

const TYPE_HANDSHAKE = 0x01;
const TYPE_MESSAGE = 0x02;
const TYPE_ACK = 0x03;
const TYPE_FRAG_START = 0xf0;
const TYPE_FRAG_CONTINUE = 0xf1;
const TYPE_FRAG_END = 0xf2;

// Conservative fallback when no MTU is known (peripheral-notify path).
const DEFAULT_CHUNK_SIZE = 18;

// P0.6 — buffers older than this are assumed orphaned (lost FRAG_END).
const REASSEMBLY_TTL_MS = 10_000;

// --- UTF-8 (P0.8) ---

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

// --- Serialize payload to bytes ---

function serializePayload(payload: BLEPayload): Uint8Array {
  switch (payload.type) {
    case 'handshake': {
      const nameBytes = strToBytes(payload.displayName);
      const idBytes = strToBytes(payload.deviceId);
      const out = new Uint8Array(1 + 1 + nameBytes.length + 1 + idBytes.length);
      let p = 0;
      out[p++] = TYPE_HANDSHAKE;
      out[p++] = nameBytes.length;
      out.set(nameBytes, p); p += nameBytes.length;
      out[p++] = idBytes.length;
      out.set(idBytes, p);
      return out;
    }
    case 'message': {
      // P0.2 — no truncation. The id and senderDeviceId are wire-safe hex
      // already (16 chars); the sender name is variable-length.
      const idBytes = strToBytes(payload.id);
      const senderIdBytes = strToBytes(payload.senderDeviceId);
      const senderNameBytes = strToBytes(payload.senderDisplayName);
      const textBytes = strToBytes(payload.text);
      const out = new Uint8Array(
        1 + 1 + idBytes.length + 1 + senderIdBytes.length + 1 + senderNameBytes.length + textBytes.length,
      );
      let p = 0;
      out[p++] = TYPE_MESSAGE;
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
      const out = new Uint8Array(1 + 1 + idBytes.length);
      let p = 0;
      out[p++] = TYPE_ACK;
      out[p++] = idBytes.length;
      out.set(idBytes, p);
      return out;
    }
  }
}

// --- Deserialize bytes to payload ---

function deserializePayload(bytes: Uint8Array): BLEPayload {
  const type = bytes[0];
  let offset = 1;

  switch (type) {
    case TYPE_HANDSHAKE: {
      const nameLen = bytes[offset++];
      const displayName = bytesToStr(bytes.subarray(offset, offset + nameLen));
      offset += nameLen;
      const idLen = bytes[offset++];
      const deviceId = bytesToStr(bytes.subarray(offset, offset + idLen));
      return { type: 'handshake', deviceId, displayName };
    }
    case TYPE_MESSAGE: {
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
      const idLen = bytes[offset++];
      const messageId = bytesToStr(bytes.subarray(offset, offset + idLen));
      return { type: 'ack', messageId };
    }
    default:
      throw new Error(`Unknown packet type: 0x${type.toString(16)}`);
  }
}

// --- Fragmentation ---

export interface EncodeOptions {
  /**
   * P0.7 — Negotiated ATT MTU. The BLE spec reserves 3 bytes for the ATT
   * header, so the usable payload per write is `mtu - 3`. Pass the value
   * from `device.requestMTU(...).mtu` on the central path; omit (or pass 0)
   * on the peripheral-notify path, which falls back to DEFAULT_CHUNK_SIZE.
   */
  mtu?: number;
}

function resolveChunkSize(mtu?: number): number {
  if (!mtu || mtu <= 3) return DEFAULT_CHUNK_SIZE;
  return mtu - 3;
}

export function encodePayload(payload: BLEPayload, options?: EncodeOptions): string[] {
  const bytes = serializePayload(payload);
  const chunkSize = resolveChunkSize(options?.mtu);

  // If it fits in one chunk, send directly (no fragment header).
  if (bytes.length <= chunkSize) {
    return [bytesToBase64(bytes)];
  }

  // Fragment: split into chunks. The first chunk carries a 5-byte header
  // (type + totalLen(2) + seqTotal + msgSeq); continue/end carry 3 bytes
  // (type + seqNum + msgSeq).
  const firstDataSize = chunkSize - 5;
  const contDataSize = chunkSize - 3;

  if (firstDataSize <= 0 || contDataSize <= 0) {
    // MTU is too small to fragment — fall back to the default chunk size
    // rather than emitting zero-length data chunks.
    return encodePayload(payload, { mtu: DEFAULT_CHUNK_SIZE + 3 });
  }

  const dataChunks: Uint8Array[] = [];
  let pos = 0;
  dataChunks.push(bytes.subarray(pos, pos + firstDataSize));
  pos += firstDataSize;
  while (pos < bytes.length) {
    dataChunks.push(bytes.subarray(pos, pos + contDataSize));
    pos += contDataSize;
  }

  const seqTotal = dataChunks.length;
  const totalLen = bytes.length;
  // P0.6 — tag every fragment of this message so a stale fragment from a
  // previous (aborted) message cannot be misassembled into this one.
  const msgSeq = (nextMsgSeq() & 0xff);
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

// Monotonic per-process counter; wrapping at 0xff is fine — collisions only
// matter within the ~10 s reassembly window, and a fresh message that reuses
// an old msgSeq has already evicted the old buffer on its FRAG_START.
let msgSeqCounter = 0;
function nextMsgSeq(): number {
  msgSeqCounter = (msgSeqCounter + 1) & 0xff;
  return msgSeqCounter;
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
      console.warn(`[Protocol] Discarding stale reassembly buffer for ${key} (${now - buf.createdAt}ms old)`);
      reassemblyBuffers.delete(key);
    }
  }
}

/**
 * Feed a received base64 chunk. Returns the decoded payload when complete, or
 * null if still assembling.
 */
export function decodeChunk(
  base64Value: string,
  sourceKey: string = 'default',
): BLEPayload | null {
  const bytes = base64ToBytes(base64Value);
  if (bytes.length === 0) return null;

  const type = bytes[0];

  // Non-fragmented packet
  if (type !== TYPE_FRAG_START && type !== TYPE_FRAG_CONTINUE && type !== TYPE_FRAG_END) {
    return deserializePayload(bytes);
  }

  // Opportunistic sweep — cheap and prevents unbounded growth (P0.6).
  sweepStaleBuffers();

  if (type === TYPE_FRAG_START) {
    const totalLen = (bytes[1] << 8) | bytes[2];
    const seqTotal = bytes[3];
    const msgSeq = bytes[4];
    const data = bytes.subarray(5);
    const buffer: ReassemblyBuffer = {
      totalLen,
      seqTotal,
      msgSeq,
      chunks: new Map([[0, data]]),
      createdAt: Date.now(),
    };
    // A new FRAG_START always supersedes any in-flight buffer for this source
    // (the previous message was either completed or abandoned).
    reassemblyBuffers.set(sourceKey, buffer);
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
      `[Protocol] Discarding fragment seq=${seqNum} msgSeq=${msgSeq} (buffer has msgSeq=${buffer.msgSeq})`,
    );
    return null;
  }

  buffer.chunks.set(seqNum, data);

  if (type === TYPE_FRAG_END) {
    // Reassemble
    const assembled: number[] = [];
    for (let i = 0; i < buffer.seqTotal; i++) {
      const chunk = buffer.chunks.get(i);
      if (!chunk) {
        console.warn(`[Protocol] Missing fragment ${i}`);
        reassemblyBuffers.delete(sourceKey);
        return null;
      }
      for (let j = 0; j < chunk.length; j++) assembled.push(chunk[j]);
    }
    reassemblyBuffers.delete(sourceKey);

    // Trim to totalLen (last chunk may have padding)
    const trimmed = new Uint8Array(assembled.slice(0, buffer.totalLen));
    return deserializePayload(trimmed);
  }

  return null;
}

// Exposed for tests / manual reset; not used in production paths.
export function _clearReassemblyBuffers(): void {
  reassemblyBuffers.clear();
}
