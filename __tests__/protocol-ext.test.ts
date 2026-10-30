/**
 * Features-batch tests for the wire protocol additions: TYPE_CTRL (0x07),
 * TYPE_MESSAGE_EXT (0x08) and TYPE_MEDIA (0x09).
 *
 * Covers round-trips, the byte-compatibility guarantee for plain MESSAGE,
 * rejection of malformed input, and truncation / garbage fuzzing: every
 * decoder must either return a value or throw ProtocolError, never anything
 * else (no NaN lengths, no out-of-range reads surfacing as TypeErrors).
 */

import {
  TYPE_MESSAGE,
  TYPE_MESSAGE_EXT,
  TYPE_CTRL,
  TYPE_MEDIA,
  MEDIA_CHUNK_BYTES,
  MAX_READ_IDS_PER_PACKET,
  BROADCAST_DST,
  ProtocolError,
  encodePacket,
  decodePacket,
  encodeBody,
  decodeBody,
  encodeBLEPayload,
  decodeBLEChunkFull,
  _clearReassemblyBuffers,
} from '../src/services/protocol';
import type { BLEPayload, MessagePayload, ControlPayload, MediaChunkPayload } from '../src/types';

// --- fixtures ---

const SRC = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const DST = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);
const MSGID = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);

function msg(extra: Partial<MessagePayload> = {}): MessagePayload {
  return {
    type: 'message',
    id: 'abcdef0123456789',
    senderDeviceId: '0102030405060708',
    senderDisplayName: 'Alice',
    text: 'hello',
    timestamp: 0,
    ...extra,
  };
}

const IMAGE_META = { kind: 'image' as const, size: 12345, chunks: 5, mime: 'image/jpeg', width: 640, height: 480 };
const AUDIO_META = { kind: 'audio' as const, size: 4096, chunks: 2, mime: 'audio/mp4', durationMs: 7000 };

/** Decode `body` as the given type, returning the payload (or throwing). */
function roundTrip(payload: BLEPayload): BLEPayload {
  const body = encodeBody(payload);
  const type =
    payload.type === 'control' ? TYPE_CTRL
    : payload.type === 'media' ? TYPE_MEDIA
    : payload.type === 'message' && (payload.replyTo || payload.media) ? TYPE_MESSAGE_EXT
    : payload.type === 'message' ? TYPE_MESSAGE
    : (() => { throw new Error('unexpected type in roundTrip'); })();
  return decodeBody(type, body);
}

/** Strip the non-deterministic timestamp so decoded messages compare cleanly. */
function withoutTimestamp(p: BLEPayload): BLEPayload {
  if (p.type !== 'message') return p;
  const { timestamp: _ignored, ...rest } = p;
  return { ...rest, timestamp: 0 } as BLEPayload;
}

/** Hand-built legacy MESSAGE body, independent of encodeBody, to pin the layout. */
function legacyMessageBody(id: string, senderId: string, name: string, text: string): Uint8Array {
  const enc = new TextEncoder();
  const parts = [enc.encode(id), enc.encode(senderId), enc.encode(name), enc.encode(text)];
  const out: number[] = [];
  out.push(parts[0].length, ...parts[0]);
  out.push(parts[1].length, ...parts[1]);
  out.push(parts[2].length, ...parts[2]);
  out.push(...parts[3]);
  return Uint8Array.from(out);
}

function ctrlTypingBody(state: number): Uint8Array {
  return Uint8Array.from([0x01, state]);
}

// =====================================================================
// Byte compatibility for plain MESSAGE
// =====================================================================

describe('plain MESSAGE stays byte-identical', () => {
  it('encodes a message without extras with the legacy layout', () => {
    const body = encodeBody(msg());
    expect(Array.from(body)).toEqual(
      Array.from(legacyMessageBody('abcdef0123456789', '0102030405060708', 'Alice', 'hello')),
    );
  });

  it('treats an empty replyTo string as no reply (still TYPE_MESSAGE)', () => {
    const body = encodeBody(msg({ replyTo: '' }));
    expect(Array.from(body)).toEqual(Array.from(encodeBody(msg())));
    const packet = encodeBLEPayload(msg({ replyTo: '' }), { src: SRC, msgId: MSGID, mtu: 512 });
    const decoded = decodeBLEChunkFull(packet[0], 'plain');
    expect(decoded?.header.type).toBe(TYPE_MESSAGE);
  });

  it('uses TYPE_MESSAGE on the wire when no extras are set', () => {
    const packet = encodeBLEPayload(msg(), { src: SRC, msgId: MSGID, mtu: 512 });
    expect(packet.length).toBe(1);
    const { header } = decodePacket(Uint8Array.from(atob(packet[0]), c => c.charCodeAt(0)));
    expect(header.type).toBe(TYPE_MESSAGE);
  });

  it('uses TYPE_MESSAGE_EXT on the wire when a reply or media is present', () => {
    for (const extra of [{ replyTo: 'feedfacefeedface' }, { media: IMAGE_META }]) {
      const packet = encodeBLEPayload(msg(extra), { src: SRC, msgId: MSGID, mtu: 512 });
      const { header } = decodePacket(Uint8Array.from(atob(packet[0]), c => c.charCodeAt(0)));
      expect(header.type).toBe(TYPE_MESSAGE_EXT);
    }
  });
});

// =====================================================================
// Round-trips
// =====================================================================

describe('MESSAGE_EXT round-trip', () => {
  it('reply only', () => {
    const p = msg({ replyTo: 'feedfacefeedface' });
    expect(withoutTimestamp(roundTrip(p))).toEqual(withoutTimestamp({ ...p, timestamp: 0 }));
  });

  it('image attachment only, with empty text', () => {
    const p = msg({ text: '', media: IMAGE_META });
    const out = roundTrip(p) as MessagePayload;
    expect(out.text).toBe('');
    expect(out.media).toEqual(IMAGE_META);
    expect(out.replyTo).toBeUndefined();
  });

  it('audio attachment (duration, no width/height)', () => {
    const p = msg({ text: '', media: AUDIO_META });
    const out = roundTrip(p) as MessagePayload;
    expect(out.media).toEqual(AUDIO_META);
    expect(out.media?.width).toBeUndefined();
    expect(out.media?.height).toBeUndefined();
  });

  it('reply and media together, with a caption', () => {
    const p = msg({ text: 'look at this', replyTo: 'aaaabbbbccccdddd', media: IMAGE_META });
    expect(withoutTimestamp(roundTrip(p))).toEqual(withoutTimestamp(p));
  });

  it('unicode text and emoji', () => {
    const p = msg({ text: 'héllo 👋 世界 🇮🇳', replyTo: 'aaaabbbbccccdddd' });
    expect((roundTrip(p) as MessagePayload).text).toBe('héllo 👋 世界 🇮🇳');
  });

  it('empty text with no attachment is still a valid EXT body', () => {
    const p = msg({ text: '', replyTo: 'aaaabbbbccccdddd' });
    expect((roundTrip(p) as MessagePayload).text).toBe('');
  });

  it('max-length (255 byte) ids and names', () => {
    const longId = 'x'.repeat(255);
    const p = msg({ id: longId, replyTo: 'y'.repeat(255), senderDisplayName: 'n'.repeat(255) });
    const out = roundTrip(p) as MessagePayload;
    expect(out.id).toBe(longId);
    expect(out.replyTo).toBe('y'.repeat(255));
    expect(out.senderDisplayName).toBe('n'.repeat(255));
  });

  it('decodes with a fresh timestamp', () => {
    const before = Date.now();
    const out = roundTrip(msg({ replyTo: 'aaaabbbbccccdddd' })) as MessagePayload;
    expect(out.timestamp).toBeGreaterThanOrEqual(before);
    expect(out.timestamp).toBeLessThanOrEqual(Date.now());
  });
});

describe('CTRL round-trip', () => {
  const cases: ControlPayload[] = [
    { type: 'control', sub: 'typing', typing: true },
    { type: 'control', sub: 'typing', typing: false },
    { type: 'control', sub: 'read', ids: ['abcdef0123456789'] },
    {
      type: 'control',
      sub: 'read',
      ids: Array.from({ length: MAX_READ_IDS_PER_PACKET }, (_, i) => `id${String(i).padStart(14, '0')}`),
    },
    { type: 'control', sub: 'reaction', messageId: 'abcdef0123456789', emoji: '👍', add: true },
    { type: 'control', sub: 'reaction', messageId: 'abcdef0123456789', emoji: '❤️', add: false },
    // Exactly 16 bytes of emoji is the upper bound.
    { type: 'control', sub: 'reaction', messageId: 'm', emoji: '👍👍👍👍', add: true },
  ];

  it.each(cases.map((c, i) => [i, c]))('case %i round-trips', (_i, c) => {
    expect(roundTrip(c as BLEPayload)).toEqual(c);
  });

  it('encodes typing as [0x01][state]', () => {
    expect(Array.from(encodeBody({ type: 'control', sub: 'typing', typing: true }))).toEqual([0x01, 1]);
    expect(Array.from(encodeBody({ type: 'control', sub: 'typing', typing: false }))).toEqual([0x01, 0]);
  });
});

describe('MEDIA round-trip', () => {
  it('single-byte chunk at index 0', () => {
    const p: MediaChunkPayload = { type: 'media', messageId: 'abcdef0123456789', index: 0, data: Uint8Array.of(7) };
    expect(roundTrip(p)).toEqual(p);
  });

  it('full-size chunk at the maximum index', () => {
    const data = new Uint8Array(MEDIA_CHUNK_BYTES);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    const p: MediaChunkPayload = { type: 'media', messageId: 'z'.repeat(255), index: 0xffff, data };
    expect(roundTrip(p)).toEqual(p);
  });

  it('unicode message id is carried as UTF-8 bytes', () => {
    const p: MediaChunkPayload = { type: 'media', messageId: 'id-é', index: 3, data: Uint8Array.of(1, 2) };
    expect(roundTrip(p)).toEqual(p);
  });
});

// =====================================================================
// Rejection of malformed input
// =====================================================================

describe('encoder rejects invalid input', () => {
  it('CTRL read with more than MAX_READ_IDS_PER_PACKET ids', () => {
    const ids = Array.from({ length: MAX_READ_IDS_PER_PACKET + 1 }, (_, i) => `i${i}`);
    expect(() => encodeBody({ type: 'control', sub: 'read', ids })).toThrow(ProtocolError);
  });

  it('CTRL read with zero ids', () => {
    expect(() => encodeBody({ type: 'control', sub: 'read', ids: [] })).toThrow(ProtocolError);
  });

  it('CTRL reaction with emoji longer than 16 bytes', () => {
    expect(() =>
      encodeBody({ type: 'control', sub: 'reaction', messageId: 'm', emoji: '👍👍👍👍👍', add: true }),
    ).toThrow(ProtocolError);
  });

  it('CTRL reaction with empty emoji', () => {
    expect(() =>
      encodeBody({ type: 'control', sub: 'reaction', messageId: 'm', emoji: '', add: true }),
    ).toThrow(ProtocolError);
  });

  it('MEDIA with empty data', () => {
    expect(() =>
      encodeBody({ type: 'media', messageId: 'm', index: 0, data: new Uint8Array(0) }),
    ).toThrow(ProtocolError);
  });

  it('MEDIA with data larger than MEDIA_CHUNK_BYTES', () => {
    expect(() =>
      encodeBody({ type: 'media', messageId: 'm', index: 0, data: new Uint8Array(MEDIA_CHUNK_BYTES + 1) }),
    ).toThrow(ProtocolError);
  });

  it('MEDIA with an out-of-range index', () => {
    expect(() =>
      encodeBody({ type: 'media', messageId: 'm', index: 0x10000, data: Uint8Array.of(1) }),
    ).toThrow(ProtocolError);
  });

  it('MEDIA with an empty message id', () => {
    expect(() =>
      encodeBody({ type: 'media', messageId: '', index: 0, data: Uint8Array.of(1) }),
    ).toThrow(ProtocolError);
  });

  it('MESSAGE_EXT with an id longer than 255 bytes', () => {
    expect(() => encodeBody(msg({ id: 'x'.repeat(256), replyTo: 'r' }))).toThrow(ProtocolError);
  });

  it('MESSAGE_EXT with zero chunks in the media descriptor', () => {
    expect(() => encodeBody(msg({ media: { ...IMAGE_META, chunks: 0 } }))).toThrow(ProtocolError);
  });
});

describe('decoder rejects malformed input', () => {
  it('CTRL with no sub-type', () => {
    expect(() => decodeBody(TYPE_CTRL, new Uint8Array(0))).toThrow(ProtocolError);
  });

  it('CTRL with an unknown sub-type', () => {
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.of(0x09, 0x00))).toThrow(ProtocolError);
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.of(0x00))).toThrow(ProtocolError);
  });

  it('CTRL typing with an invalid state byte', () => {
    expect(() => decodeBody(TYPE_CTRL, ctrlTypingBody(2))).toThrow(ProtocolError);
  });

  it('CTRL typing with trailing bytes', () => {
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.of(0x01, 1, 0))).toThrow(ProtocolError);
  });

  it('CTRL read with n above MAX_READ_IDS_PER_PACKET', () => {
    const n = MAX_READ_IDS_PER_PACKET + 1;
    const bytes = [0x02, n];
    for (let i = 0; i < n; i++) bytes.push(2, 0x61, 0x62);
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.from(bytes))).toThrow(ProtocolError);
  });

  it('CTRL read with n = 0', () => {
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.of(0x02, 0))).toThrow(ProtocolError);
  });

  it('CTRL read with a zero-length id', () => {
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.of(0x02, 1, 0))).toThrow(ProtocolError);
  });

  it('CTRL read that claims more ids than the body carries', () => {
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.of(0x02, 3, 1, 0x61))).toThrow(ProtocolError);
  });

  it('CTRL reaction with emoji longer than 16 bytes', () => {
    const emoji = new TextEncoder().encode('👍'.repeat(5)); // 20 bytes
    const bytes = Uint8Array.from([0x03, 1, 0x6d, 1, ...emoji]);
    expect(() => decodeBody(TYPE_CTRL, bytes)).toThrow(ProtocolError);
  });

  it('CTRL reaction with no emoji bytes', () => {
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.of(0x03, 1, 0x6d, 1))).toThrow(ProtocolError);
  });

  it('CTRL reaction with an invalid op', () => {
    expect(() => decodeBody(TYPE_CTRL, Uint8Array.of(0x03, 1, 0x6d, 7, 0x41))).toThrow(ProtocolError);
  });

  it('MESSAGE_EXT with an id length of zero', () => {
    expect(() => decodeBody(TYPE_MESSAGE_EXT, Uint8Array.of(0, 0, 0, 0))).toThrow(ProtocolError);
  });

  it('MESSAGE_EXT with unknown extFlags bits', () => {
    // flags = 0x02 is not a defined extension bit.
    expect(() => decodeBody(TYPE_MESSAGE_EXT, Uint8Array.of(1, 0x61, 0, 0, 0x02))).toThrow(ProtocolError);
  });

  it('MESSAGE_EXT with a zero-length replyTo id', () => {
    expect(() => decodeBody(TYPE_MESSAGE_EXT, Uint8Array.of(1, 0x61, 0, 0, 0x01, 0))).toThrow(ProtocolError);
  });

  it('MESSAGE_EXT media descriptor with chunks = 0', () => {
    const body = encodeBody(msg({ text: '', media: IMAGE_META }));
    // Locate the chunks field: after id(1+16) sender(1+16) name(1+5) flags(1) kind(1) size(4).
    const chunksOffset = (1 + 16) + (1 + 16) + (1 + 5) + 1 + 1 + 4;
    const bad = Uint8Array.from(body);
    bad[chunksOffset] = 0;
    bad[chunksOffset + 1] = 0;
    expect(() => decodeBody(TYPE_MESSAGE_EXT, bad)).toThrow(ProtocolError);
  });

  it('MESSAGE_EXT media descriptor with an unknown kind', () => {
    const body = encodeBody(msg({ text: '', media: IMAGE_META }));
    const kindOffset = (1 + 16) + (1 + 16) + (1 + 5) + 1;
    const bad = Uint8Array.from(body);
    bad[kindOffset] = 9;
    expect(() => decodeBody(TYPE_MESSAGE_EXT, bad)).toThrow(ProtocolError);
  });

  it('MEDIA with empty data', () => {
    expect(() => decodeBody(TYPE_MEDIA, Uint8Array.of(1, 0x61, 0, 0))).toThrow(ProtocolError);
  });

  it('MEDIA with a zero-length message id', () => {
    expect(() => decodeBody(TYPE_MEDIA, Uint8Array.of(0, 0, 0, 1, 2))).toThrow(ProtocolError);
  });

  it('MEDIA with data longer than MEDIA_CHUNK_BYTES', () => {
    const bytes = new Uint8Array(3 + 1 + MEDIA_CHUNK_BYTES + 1);
    bytes[0] = 1;
    bytes[1] = 0x61;
    bytes.fill(5, 4);
    expect(() => decodeBody(TYPE_MEDIA, bytes)).toThrow(ProtocolError);
  });

  it('MEDIA with a truncated index', () => {
    expect(() => decodeBody(TYPE_MEDIA, Uint8Array.of(1, 0x61, 0))).toThrow(ProtocolError);
  });
});

// =====================================================================
// Truncation and garbage fuzzing
// =====================================================================

const SAMPLES: { type: number; name: string; body: Uint8Array }[] = [
  { type: TYPE_CTRL, name: 'ctrl typing', body: encodeBody({ type: 'control', sub: 'typing', typing: true }) },
  {
    type: TYPE_CTRL,
    name: 'ctrl read x3',
    body: encodeBody({ type: 'control', sub: 'read', ids: ['aaaa', 'bbbbbb', 'cc'] }),
  },
  {
    type: TYPE_CTRL,
    name: 'ctrl reaction',
    body: encodeBody({ type: 'control', sub: 'reaction', messageId: 'abcdef0123456789', emoji: '🙏', add: true }),
  },
  {
    type: TYPE_MESSAGE_EXT,
    name: 'ext reply + media + unicode text',
    body: encodeBody(msg({ text: 'héllo 👋', replyTo: 'feedfacefeedface', media: IMAGE_META })),
  },
  {
    type: TYPE_MESSAGE_EXT,
    name: 'ext audio, empty text',
    body: encodeBody(msg({ text: '', media: AUDIO_META })),
  },
  {
    type: TYPE_MESSAGE_EXT,
    name: 'ext reply only',
    body: encodeBody(msg({ replyTo: 'feedfacefeedface' })),
  },
  {
    type: TYPE_MEDIA,
    name: 'media chunk',
    body: encodeBody({ type: 'media', messageId: 'abcdef0123456789', index: 4, data: Uint8Array.of(1, 2, 3, 4, 5) }),
  },
];

describe('truncation fuzz', () => {
  it.each(SAMPLES.map(s => [s.name, s]))('%s: every prefix throws ProtocolError or decodes sanely', (_name, s) => {
    const sample = s as (typeof SAMPLES)[number];
    for (let len = 0; len < sample.body.length; len++) {
      const prefix = sample.body.subarray(0, len);
      let out: unknown;
      try {
        out = decodeBody(sample.type, prefix);
      } catch (e) {
        expect(e).toBeInstanceOf(ProtocolError);
        continue;
      }
      // Decoded without throwing: must be a well-formed payload object.
      expect(out).toBeTruthy();
      expect(typeof (out as { type: unknown }).type).toBe('string');
    }
  });
});

describe('garbage fuzz', () => {
  // Small deterministic LCG so failures are reproducible.
  function prng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it('random bodies of every new type only ever throw ProtocolError', () => {
    const rand = prng(0xc0ffee);
    for (const type of [TYPE_CTRL, TYPE_MESSAGE_EXT, TYPE_MEDIA]) {
      for (let iter = 0; iter < 2000; iter++) {
        const len = Math.floor(rand() * 48);
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = Math.floor(rand() * 256);
        try {
          decodeBody(type, bytes);
        } catch (e) {
          if (!(e instanceof ProtocolError)) {
            throw new Error(`type 0x${type.toString(16)} threw ${String(e)} for ${Array.from(bytes)}`);
          }
        }
      }
    }
  });
});

// =====================================================================
// End-to-end through the packet layer
// =====================================================================

describe('encodePacket / decodePacket end-to-end', () => {
  it.each([
    ['ctrl typing', TYPE_CTRL, encodeBody({ type: 'control', sub: 'typing', typing: true })],
    ['message ext', TYPE_MESSAGE_EXT, encodeBody(msg({ text: 'hi 👋', replyTo: 'feedfacefeedface', media: IMAGE_META }))],
    [
      'media chunk',
      TYPE_MEDIA,
      encodeBody({ type: 'media', messageId: 'abcdef0123456789', index: 1, data: new Uint8Array(MEDIA_CHUNK_BYTES).fill(0xab) }),
    ],
  ] as const)('%s survives header framing and decodes back', (_name, type, body) => {
    const packet = encodePacket({ type, flags: 0x01, ttl: 3, msgId: MSGID, src: SRC, dst: DST, payload: body });
    const { header, payload } = decodePacket(packet);
    expect(header.type).toBe(type);
    expect(header.ttl).toBe(3);
    expect(Array.from(header.src)).toEqual(Array.from(SRC));
    expect(Array.from(header.dst)).toEqual(Array.from(DST));
    expect(Array.from(payload)).toEqual(Array.from(body));
    expect(decodeBody(header.type, payload)).toBeTruthy();
  });

  it('a media chunk fragmented at MTU 517 reassembles through decodeBLEChunkFull', () => {
    _clearReassemblyBuffers();
    const data = new Uint8Array(MEDIA_CHUNK_BYTES);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;
    const chunk: MediaChunkPayload = { type: 'media', messageId: 'abcdef0123456789', index: 2, data };
    const frags = encodeBLEPayload(chunk, { src: SRC, dst: DST, msgId: MSGID, mtu: 517 });
    expect(frags.length).toBeGreaterThan(1);
    expect(frags.length).toBeLessThanOrEqual(255);

    let result: ReturnType<typeof decodeBLEChunkFull> = null;
    for (const f of frags) {
      result = decodeBLEChunkFull(f, 'e2e-media') ?? result;
    }
    expect(result).not.toBeNull();
    expect(result!.header.type).toBe(TYPE_MEDIA);
    expect(result!.payload).toEqual(chunk);
  });

  it('a CTRL packet decodes through the BLE chunk path', () => {
    _clearReassemblyBuffers();
    const payload: ControlPayload = { type: 'control', sub: 'read', ids: ['abcdef0123456789'] };
    const frags = encodeBLEPayload(payload, { src: SRC, dst: DST, msgId: MSGID, mtu: 512 });
    const decoded = decodeBLEChunkFull(frags[0], 'e2e-ctrl');
    expect(decoded?.header.type).toBe(TYPE_CTRL);
    expect(decoded?.header.dst).toEqual(DST);
    expect(decoded?.payload).toEqual(payload);
    expect(BROADCAST_DST.every(b => b === 0)).toBe(true);
  });
});
