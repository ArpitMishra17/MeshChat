/**
 * Binary protocol for BLE message encoding/decoding.
 * Inspired by BitChat's compact packet format.
 *
 * Packet format:
 *   [type: 1 byte] [payload bytes...]
 *
 * Types:
 *   0x01 = handshake:  [nameLen: 1] [name: utf8] [idLen: 1] [id: utf8]
 *   0x02 = message:    [idLen: 1] [id: utf8] [senderLen: 1] [sender: utf8] [text: utf8 rest]
 *   0x03 = ack:        [idLen: 1] [id: utf8]
 *
 * Fragmentation (for payloads > chunkSize):
 *   0xF0 = fragmentStart:    [totalLen: 2 bytes BE] [seqTotal: 1] [data...]
 *   0xF1 = fragmentContinue: [seqNum: 1] [data...]
 *   0xF2 = fragmentEnd:      [seqNum: 1] [data...]
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

// Default BLE write chunk size (conservative — works with any MTU)
const CHUNK_SIZE = 18;

// --- Encoding helpers ---

function strToBytes(s: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

function bytesToStr(bytes: number[], offset: number, length: number): string {
  let result = '';
  let i = offset;
  const end = offset + length;
  while (i < end) {
    const b = bytes[i];
    if (b < 0x80) {
      result += String.fromCharCode(b);
      i++;
    } else if (b < 0xe0) {
      result += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else {
      result += String.fromCharCode(
        ((b & 0x0f) << 12) |
          ((bytes[i + 1] & 0x3f) << 6) |
          (bytes[i + 2] & 0x3f),
      );
      i += 3;
    }
  }
  return result;
}

function bytesToBase64(bytes: number[]): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): number[] {
  const binary = atob(b64);
  const bytes: number[] = [];
  for (let i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i));
  }
  return bytes;
}

// --- Serialize payload to bytes ---

function serializePayload(payload: BLEPayload): number[] {
  switch (payload.type) {
    case 'handshake': {
      const nameBytes = strToBytes(payload.displayName);
      const idBytes = strToBytes(payload.deviceId.slice(0, 8));
      return [
        TYPE_HANDSHAKE,
        nameBytes.length,
        ...nameBytes,
        idBytes.length,
        ...idBytes,
      ];
    }
    case 'message': {
      const idBytes = strToBytes(payload.id.slice(0, 12));
      const senderBytes = strToBytes(payload.senderDeviceId.slice(0, 8));
      const textBytes = strToBytes(payload.text);
      return [
        TYPE_MESSAGE,
        idBytes.length,
        ...idBytes,
        senderBytes.length,
        ...senderBytes,
        ...textBytes,
      ];
    }
    case 'ack': {
      const idBytes = strToBytes(payload.messageId.slice(0, 12));
      return [TYPE_ACK, idBytes.length, ...idBytes];
    }
  }
}

// --- Deserialize bytes to payload ---

function deserializePayload(bytes: number[]): BLEPayload {
  const type = bytes[0];
  let offset = 1;

  switch (type) {
    case TYPE_HANDSHAKE: {
      const nameLen = bytes[offset++];
      const displayName = bytesToStr(bytes, offset, nameLen);
      offset += nameLen;
      const idLen = bytes[offset++];
      const deviceId = bytesToStr(bytes, offset, idLen);
      return { type: 'handshake', deviceId, displayName };
    }
    case TYPE_MESSAGE: {
      const idLen = bytes[offset++];
      const id = bytesToStr(bytes, offset, idLen);
      offset += idLen;
      const senderLen = bytes[offset++];
      const senderDeviceId = bytesToStr(bytes, offset, senderLen);
      offset += senderLen;
      const text = bytesToStr(bytes, offset, bytes.length - offset);
      return {
        type: 'message',
        id,
        senderDeviceId,
        text,
        timestamp: Date.now(),
      };
    }
    case TYPE_ACK: {
      const idLen = bytes[offset++];
      const messageId = bytesToStr(bytes, offset, idLen);
      return { type: 'ack', messageId };
    }
    default:
      throw new Error(`Unknown packet type: 0x${type.toString(16)}`);
  }
}

// --- Fragmentation ---

export function encodePayload(payload: BLEPayload): string[] {
  const bytes = serializePayload(payload);

  // If it fits in one chunk, send directly
  if (bytes.length <= CHUNK_SIZE) {
    return [bytesToBase64(bytes)];
  }

  // Fragment: split into chunks
  const dataChunks: number[][] = [];
  // Reserve 3 bytes for fragment header in first chunk, 2 for subsequent
  const firstDataSize = CHUNK_SIZE - 4; // type + totalLen(2) + seqTotal
  const contDataSize = CHUNK_SIZE - 2; // type + seqNum

  let pos = 0;
  // First chunk data
  dataChunks.push(bytes.slice(pos, pos + firstDataSize));
  pos += firstDataSize;

  while (pos < bytes.length) {
    dataChunks.push(bytes.slice(pos, pos + contDataSize));
    pos += contDataSize;
  }

  const seqTotal = dataChunks.length;
  const totalLen = bytes.length;
  const fragments: string[] = [];

  for (let i = 0; i < dataChunks.length; i++) {
    let fragBytes: number[];
    if (i === 0) {
      fragBytes = [
        TYPE_FRAG_START,
        (totalLen >> 8) & 0xff,
        totalLen & 0xff,
        seqTotal,
        ...dataChunks[i],
      ];
    } else if (i === dataChunks.length - 1) {
      fragBytes = [TYPE_FRAG_END, i, ...dataChunks[i]];
    } else {
      fragBytes = [TYPE_FRAG_CONTINUE, i, ...dataChunks[i]];
    }
    fragments.push(bytesToBase64(fragBytes));
  }

  return fragments;
}

// --- Reassembly ---

interface ReassemblyBuffer {
  totalLen: number;
  seqTotal: number;
  chunks: Map<number, number[]>;
}

const reassemblyBuffers = new Map<string, ReassemblyBuffer>();

/**
 * Feed a received base64 chunk. Returns the decoded payload when complete, or null if still assembling.
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

  // Fragment handling
  if (type === TYPE_FRAG_START) {
    const totalLen = (bytes[1] << 8) | bytes[2];
    const seqTotal = bytes[3];
    const data = bytes.slice(4);
    const buffer: ReassemblyBuffer = {
      totalLen,
      seqTotal,
      chunks: new Map([[0, data]]),
    };
    reassemblyBuffers.set(sourceKey, buffer);
    return null;
  }

  const seqNum = bytes[1];
  const data = bytes.slice(2);
  const buffer = reassemblyBuffers.get(sourceKey);
  if (!buffer) {
    console.warn('[Protocol] Received fragment without start');
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
      assembled.push(...chunk);
    }
    reassemblyBuffers.delete(sourceKey);

    // Trim to totalLen (last chunk may have padding)
    const trimmed = assembled.slice(0, buffer.totalLen);
    return deserializePayload(trimmed);
  }

  return null;
}
