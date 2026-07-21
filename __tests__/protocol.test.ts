/**
 * Phase 1 unit tests for the v2 protocol layer.
 *
 * The protocol layer is pure TypeScript (only type-only imports from
 * ../types) — no BLE, no expo native modules — so these tests run under a
 * plain node Jest environment with no hardware. This is where silent
 * corruption bugs live, per PLAN.md Phase 1 task 3.
 */

import {
  PROTOCOL_VERSION,
  HEADER_SIZE,
  DEFAULT_TTL,
  TYPE_HELLO,
  TYPE_MESSAGE,
  TYPE_ACK,
  TYPE_POSITION,
  FLAG_ENCRYPTED,
  FLAG_HAS_POSITION,
  BROADCAST_DST,
  FINGERPRINT_SIZE,
  MSGID_SIZE,
  ProtocolError,
  ProtocolVersionError,
  encodePacket,
  decodePacket,
  encodeBody,
  decodeBody,
  encodeBLEPayload,
  encodeRawPacket,
  decodeBLEChunk,
  decodeBLEChunkFull,
  decodeBLEChunkRaw,
  buildHeaderBytes,
  headerToAAD,
  _clearReassemblyBuffers,
  _resetMsgSeq,
} from '../src/services/protocol';
import type { HandshakePayload, MessagePayload, AckPayload } from '../src/types';

// --- pure hex helpers (avoid importing ids.ts, which pulls expo-crypto) ---

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// 8-byte fingerprint / msgId constants.
const SRC = hexToBytes('0102030405060708');
const DST = hexToBytes('0807060504030201');
const MSGID = hexToBytes('1122334455667788');

// Phase 2 — HELLO carries the 32-byte X25519 public key. deviceId (fingerprint)
// is derived from the pubkey by the receiver, NOT sent on the wire.
const PEER_PUBKEY = hexToBytes(
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
);

const handshake: HandshakePayload = {
  type: 'handshake',
  deviceId: '', // not on the wire — derived from publicKey by the receiver
  displayName: 'alice',
  publicKey: PEER_PUBKEY,
};

const message: MessagePayload = {
  type: 'message',
  id: 'a1b2c3d4e5f60718',
  senderDeviceId: '0102030405060708', // Phase 2 — fingerprint (16 hex chars)
  senderDisplayName: 'alice',
  text: 'hello world',
  timestamp: 0,
};

const ack: AckPayload = { type: 'ack', messageId: 'a1b2c3d4e5f60718' };

beforeEach(() => {
  _clearReassemblyBuffers();
  _resetMsgSeq();
});

// =====================================================================
// encodePacket / decodePacket — the pure core
// =====================================================================

describe('encodePacket / decodePacket round-trip', () => {
  it('round-trips a MESSAGE preserving every header field', () => {
    const body = encodeBody(message);
    const packet = encodePacket({
      type: TYPE_MESSAGE,
      flags: 0,
      ttl: 5,
      msgId: MSGID,
      src: SRC,
      dst: DST,
      payload: body,
    });

    // Total length is header + body.
    expect(packet.length).toBe(HEADER_SIZE + body.length);

    const { header, payload } = decodePacket(packet);
    expect(header.version).toBe(PROTOCOL_VERSION);
    expect(header.type).toBe(TYPE_MESSAGE);
    expect(header.flags).toBe(0);
    expect(header.ttl).toBe(5);
    expect(bytesToHex(header.msgId)).toBe('1122334455667788');
    expect(bytesToHex(header.src)).toBe('0102030405060708');
    expect(bytesToHex(header.dst)).toBe('0807060504030201');
    expect(header.payloadLen).toBe(body.length);
    expect(payload.length).toBe(body.length);

    const decoded = decodeBody(header.type, payload) as MessagePayload;
    expect(decoded.type).toBe('message');
    expect(decoded.id).toBe(message.id);
    expect(decoded.senderDeviceId).toBe(message.senderDeviceId);
    expect(decoded.senderDisplayName).toBe(message.senderDisplayName);
    expect(decoded.text).toBe(message.text);
  });

  it('round-trips a HELLO', () => {
    const body = encodeBody(handshake);
    const packet = encodePacket({
      type: TYPE_HELLO, ttl: DEFAULT_TTL, msgId: MSGID, src: SRC, dst: BROADCAST_DST, payload: body,
    });
    const { header, payload } = decodePacket(packet);
    expect(header.type).toBe(TYPE_HELLO);
    expect(bytesToHex(header.dst)).toBe('0000000000000000'); // broadcast
    const decoded = decodeBody(header.type, payload) as HandshakePayload;
    // Phase 2 — deviceId is NOT on the wire; it's derived from publicKey.
    // decodeBody leaves it empty; the caller (ble.ts) fills it in.
    expect(decoded.deviceId).toBe('');
    expect(decoded.displayName).toBe(handshake.displayName);
    expect(bytesToHex(decoded.publicKey)).toBe(bytesToHex(PEER_PUBKEY));
  });

  it('round-trips an ACK', () => {
    const body = encodeBody(ack);
    const packet = encodePacket({
      type: TYPE_ACK, ttl: DEFAULT_TTL, msgId: MSGID, src: SRC, dst: DST, payload: body,
    });
    const { header, payload } = decodePacket(packet);
    expect(header.type).toBe(TYPE_ACK);
    const decoded = decodeBody(header.type, payload) as AckPayload;
    expect(decoded.messageId).toBe(ack.messageId);
  });

  it('preserves arbitrary flags (Phase 2 encrypted / Phase 4 position)', () => {
    const body = encodeBody(message);
    const flags = FLAG_ENCRYPTED | FLAG_HAS_POSITION;
    const packet = encodePacket({
      type: TYPE_MESSAGE, flags, ttl: 3, msgId: MSGID, src: SRC, dst: DST, payload: body,
    });
    const { header } = decodePacket(packet);
    expect(header.flags).toBe(flags);
    expect(header.ttl).toBe(3);
  });

  it('handles unicode text (TextEncoder/TextDecoder, P0.8)', () => {
    const unicode: MessagePayload = {
      ...message,
      text: 'héllo 世界 🌍 — \n\ttab',
    };
    const body = encodeBody(unicode);
    const packet = encodePacket({
      type: TYPE_MESSAGE, ttl: 5, msgId: MSGID, src: SRC, dst: DST, payload: body,
    });
    const { header, payload } = decodePacket(packet);
    const decoded = decodeBody(header.type, payload) as MessagePayload;
    expect(decoded.text).toBe(unicode.text);
  });
});

// =====================================================================
// EncodeContext defaults (encodeBLEPayload)
// =====================================================================

describe('encodeBLEPayload context defaults', () => {
  it('defaults ttl=DEFAULT_TTL, flags=0, dst=broadcast when omitted', () => {
    // Small payload with a generous MTU → single non-fragmented chunk, so the
    // header is directly inspectable. The defaults under test (ttl/flags/dst)
    // are independent of chunking.
    const frags = encodeBLEPayload(message, { src: SRC, msgId: MSGID, mtu: 512 });
    expect(frags.length).toBe(1);
    const decoded = decodeBLEChunkFull(frags[0], 'k');
    expect(decoded).not.toBeNull();
    expect(decoded!.header.ttl).toBe(DEFAULT_TTL);
    expect(decoded!.header.flags).toBe(0);
    expect(bytesToHex(decoded!.header.dst)).toBe('0000000000000000');
    expect(bytesToHex(decoded!.header.msgId)).toBe('1122334455667788');
    expect(decoded!.header.version).toBe(PROTOCOL_VERSION);
  });
});

// =====================================================================
// Fragmentation
// =====================================================================

describe('fragmentation', () => {
  it('emits a single fragment when the packet fits one chunk', () => {
    const frags = encodeBLEPayload(ack, { src: SRC, msgId: MSGID, mtu: 512 });
    expect(frags.length).toBe(1);
    // A non-fragmented chunk's first byte is the version (0x02), distinct
    // from the 0xF0+ fragment markers — that is how the receiver tells a
    // whole packet apart from a fragment.
    const raw = atob(frags[0]);
    expect(raw.charCodeAt(0)).toBe(PROTOCOL_VERSION);
    const decoded = decodeBLEChunk(frags[0], 'k');
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe('ack');
  });

  it('fragments a large message and reassembles it across chunks', () => {
    const big: MessagePayload = { ...message, text: 'x'.repeat(500) };
    // MTU 23 → 20-byte chunks → many fragments for a ~540-byte packet.
    const frags = encodeBLEPayload(big, { src: SRC, msgId: MSGID, mtu: 23 });
    expect(frags.length).toBeGreaterThan(1);

    let result: ReturnType<typeof decodeBLEChunk> = null;
    for (const frag of frags) {
      result = decodeBLEChunk(frag, 'big');
    }
    expect(result).not.toBeNull();
    expect(result!.type).toBe('message');
    expect((result as MessagePayload).text).toBe('x'.repeat(500));
  });

  it('reassembles correctly with a realistic MTU (512)', () => {
    const big: MessagePayload = { ...message, text: 'y'.repeat(400) };
    const frags = encodeBLEPayload(big, { src: SRC, msgId: MSGID, mtu: 512 });
    // ~440-byte packet vs ~509-byte chunk → single fragment.
    expect(frags.length).toBe(1);
    const decoded = decodeBLEChunk(frags[0], 'k');
    expect((decoded as MessagePayload).text).toBe('y'.repeat(400));
  });

  it('round-trips through separate sourceKeys without cross-talk', () => {
    const a: MessagePayload = { ...message, text: 'AAAA' };
    const b: MessagePayload = { ...message, text: 'BBBB' };
    const fragsA = encodeBLEPayload(a, { src: SRC, msgId: MSGID, mtu: 23 });
    const fragsB = encodeBLEPayload(b, { src: SRC, msgId: MSGID, mtu: 23 });

    let resA: ReturnType<typeof decodeBLEChunk> = null;
    let resB: ReturnType<typeof decodeBLEChunk> = null;
    // Interleave feeds on different sourceKeys.
    for (let i = 0; i < Math.max(fragsA.length, fragsB.length); i++) {
      if (i < fragsA.length) resA = decodeBLEChunk(fragsA[i], 'peerA');
      if (i < fragsB.length) resB = decodeBLEChunk(fragsB[i], 'peerB');
    }
    expect((resA as MessagePayload).text).toBe('AAAA');
    expect((resB as MessagePayload).text).toBe('BBBB');
  });
});

// =====================================================================
// Truncation & malformed input
// =====================================================================

describe('truncation and malformed input', () => {
  it('throws on a header shorter than HEADER_SIZE', () => {
    expect(() => decodePacket(hexToBytes('0102'))).toThrow(ProtocolError);
    // 29 bytes (version 0x02 + 28 zero bytes) — one byte short of a header.
    const short = '02'.padEnd(HEADER_SIZE * 2 - 2, '0');
    expect(() => decodePacket(hexToBytes(short))).toThrow(ProtocolError);
  });

  it('throws ProtocolVersionError on a non-v2 version byte', () => {
    // version 0x01 (would be a v1 HANDSHAKE first byte).
    const bytes = new Uint8Array(HEADER_SIZE + 2);
    bytes[0] = 0x01; bytes[1] = TYPE_HELLO;
    expect(() => decodePacket(bytes)).toThrow(ProtocolVersionError);
  });

  it('throws when declared payloadLen exceeds available bytes', () => {
    const body = encodeBody(ack);
    const packet = encodePacket({
      type: TYPE_ACK, ttl: 5, msgId: MSGID, src: SRC, dst: DST, payload: body,
    });
    // Strip the last few payload bytes so the declared length no longer fits.
    const truncated = packet.subarray(0, packet.length - 3);
    expect(() => decodePacket(truncated)).toThrow(ProtocolError);
  });

  it('decodeBody throws on a reserved type', () => {
    expect(() => decodeBody(TYPE_POSITION, new Uint8Array(0))).toThrow(ProtocolError);
  });

  it('decodeBLEChunkFull drops a v1-style packet (first byte 0x01) without throwing', () => {
    // v1 HANDSHAKE first byte 0x01 → version mismatch → dropped.
    const v1 = new Uint8Array([0x01, 0x05, 0x61, 0x6c, 0x69, 0x63, 0x65]);
    expect(decodeBLEChunkFull(b64(v1), 'k')).toBeNull();
  });

  it('decodeBLEChunkFull drops a v1-style ACK (first byte 0x03) without throwing', () => {
    const v1 = new Uint8Array([0x03, 0x10, 0x61, 0x31]);
    expect(decodeBLEChunkFull(b64(v1), 'k')).toBeNull();
  });

  it('decodeBLEChunkFull drops a v1-style MESSAGE (first byte 0x02, colliding with version)', () => {
    // Version byte 0x02 passes, but the next byte (v1 id-length = 0x10) is not
    // a valid v2 type → decodeBody throws → dropped.
    const v1 = new Uint8Array([0x02, 0x10, 0x61, 0x31, 0x62, 0x32]);
    expect(decodeBLEChunkFull(b64(v1), 'k')).toBeNull();
  });

  it('decodeBLEChunk returns null on empty input', () => {
    expect(decodeBLEChunk('', 'k')).toBeNull();
    expect(decodeBLEChunkFull('', 'k')).toBeNull();
  });
});

// =====================================================================
// encodePacket input validation
// =====================================================================

describe('encodePacket input validation', () => {
  const body = encodeBody(ack);

  it('rejects a msgId of the wrong length', () => {
    expect(() =>
      encodePacket({ type: TYPE_ACK, ttl: 5, msgId: hexToBytes('1122'), src: SRC, dst: DST, payload: body }),
    ).toThrow(ProtocolError);
  });

  it('rejects a src of the wrong length', () => {
    expect(() =>
      encodePacket({ type: TYPE_ACK, ttl: 5, msgId: MSGID, src: hexToBytes('0102'), dst: DST, payload: body }),
    ).toThrow(ProtocolError);
  });

  it('rejects a dst of the wrong length', () => {
    expect(() =>
      encodePacket({ type: TYPE_ACK, ttl: 5, msgId: MSGID, src: SRC, dst: hexToBytes('0102'), payload: body }),
    ).toThrow(ProtocolError);
  });

  it('rejects a payload larger than 65535 bytes', () => {
    const tooBig = new Uint8Array(0x10000);
    expect(() =>
      encodePacket({ type: TYPE_MESSAGE, ttl: 5, msgId: MSGID, src: SRC, dst: DST, payload: tooBig }),
    ).toThrow(ProtocolError);
  });
});

// =====================================================================
// Fragment reassembly edge cases (P0.6)
// =====================================================================

describe('fragment reassembly safety (P0.6)', () => {
  // Helpers to build raw fragment frames with a controlled msgSeq, so we can
  // simulate interleaving / stale fragments precisely.
  function fragStart(totalLen: number, seqTotal: number, msgSeq: number, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(5 + data.length);
    out[0] = 0xf0; out[1] = (totalLen >> 8) & 0xff; out[2] = totalLen & 0xff;
    out[3] = seqTotal; out[4] = msgSeq; out.set(data, 5);
    return out;
  }
  function fragCont(seqNum: number, msgSeq: number, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(3 + data.length);
    out[0] = 0xf1; out[1] = seqNum; out[2] = msgSeq; out.set(data, 3);
    return out;
  }
  function fragEnd(seqNum: number, msgSeq: number, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(3 + data.length);
    out[0] = 0xf2; out[1] = seqNum; out[2] = msgSeq; out.set(data, 3);
    return out;
  }

  it('rejects a fragment whose msgSeq does not match the in-flight buffer', () => {
    // Build a real packet split into two chunks, so the END reassembles validly.
    const packet = encodePacket({
      type: TYPE_ACK, ttl: 5, msgId: MSGID, src: SRC, dst: DST, payload: encodeBody(ack),
    });
    const chunk0 = packet.subarray(0, 10);
    const chunk1 = packet.subarray(10);

    // START (msgSeq=5) for sourceKey 'k'.
    expect(decodeBLEChunkFull(b64(fragStart(packet.length, 2, 5, chunk0)), 'k')).toBeNull();
    // A stale CONTINUE with the WRONG msgSeq must be rejected (returns null)
    // and must NOT corrupt the buffer for the correct END that follows.
    const stale = new Uint8Array(10); // junk data
    expect(decodeBLEChunkFull(b64(fragCont(1, 99, stale)), 'k')).toBeNull();
    // END with the correct msgSeq=5 completes the message.
    const result = decodeBLEChunkFull(b64(fragEnd(1, 5, chunk1)), 'k');
    expect(result).not.toBeNull();
    expect(result!.payload.type).toBe('ack');
    expect((result!.payload as AckPayload).messageId).toBe(ack.messageId);
  });

  it('returns null for a CONTINUE/END with no START in flight', () => {
    const packet = encodePacket({
      type: TYPE_ACK, ttl: 5, msgId: MSGID, src: SRC, dst: DST, payload: encodeBody(ack),
    });
    const chunk1 = packet.subarray(10);
    expect(decodeBLEChunkFull(b64(fragEnd(1, 5, chunk1)), 'orphan')).toBeNull();
  });

  it('sweeps reassembly buffers older than 10s (stale-buffer cleanup)', () => {
    const packet = encodePacket({
      type: TYPE_ACK, ttl: 5, msgId: MSGID, src: SRC, dst: DST, payload: encodeBody(ack),
    });
    const chunk0 = packet.subarray(0, 10);

    jest.useFakeTimers();
    jest.setSystemTime(0);

    // Start an incomplete fragment for sourceKey 'old' (no END will arrive).
    expect(decodeBLEChunkFull(b64(fragStart(packet.length, 2, 5, chunk0)), 'old')).toBeNull();

    // Advance past the 10s reassembly TTL.
    jest.setSystemTime(11_000);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Feed a fragment for a DIFFERENT sourceKey — the sweep that runs at the
    // top of fragment processing must evict the stale 'old' buffer.
    expect(decodeBLEChunkFull(b64(fragStart(packet.length, 2, 6, chunk0)), 'new')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Discarding stale reassembly buffer for old'),
    );

    // 'old' is gone: a late CONTINUE for it finds no buffer.
    const stale = new Uint8Array(10);
    expect(decodeBLEChunkFull(b64(fragCont(1, 5, stale)), 'old')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Received fragment without start'));

    warnSpy.mockRestore();
    jest.useRealTimers();
  });
});

// =====================================================================
// Header exposure via decodeBLEChunkFull (Phase 3 will consume these)
// =====================================================================

describe('decodeBLEChunkFull header exposure', () => {
  it('exposes src/dst/ttl/msgId/flags from the decoded packet', () => {
    const frags = encodeBLEPayload(message, {
      src: SRC, dst: DST, msgId: MSGID, ttl: 4, flags: FLAG_ENCRYPTED, mtu: 512,
    });
    expect(frags.length).toBe(1);
    const decoded = decodeBLEChunkFull(frags[0], 'k');
    expect(decoded).not.toBeNull();
    expect(decoded!.header.type).toBe(TYPE_MESSAGE);
    expect(decoded!.header.ttl).toBe(4);
    expect(decoded!.header.flags).toBe(FLAG_ENCRYPTED);
    expect(bytesToHex(decoded!.header.src)).toBe('0102030405060708');
    expect(bytesToHex(decoded!.header.dst)).toBe('0807060504030201');
    expect(bytesToHex(decoded!.header.msgId)).toBe('1122334455667788');
    expect(decoded!.header.payloadLen).toBe(encodeBody(message).length);
    expect(MSGID_SIZE).toBe(8);
    expect(FINGERPRINT_SIZE).toBe(8);
  });
});
