/**
 * Phase 3 unit tests for the relay engine.
 *
 * The relay decision logic (`decideRelay`, `SeenCache`, `hopCount`,
 * `withTtlDecremented`) is pure TypeScript — no BLE, no DB, no crypto — so it
 * runs under a plain node Jest environment. This is where the mesh's
 * correctness lives: a wrong decision here means either lost messages
 * (over-aggressive drop) or an echo storm (under-aggressive relay).
 *
 * Scenarios mirror PLAN.md Phase 3 "Flooding algorithm" + the testing notes:
 *   - dedup drops a packet seen before (loop-back / duplicate path)
 *   - dst == me  → deliver
 *   - broadcast  → deliver + relay
 *   - unicast, not me, ttl > 0 → relay
 *   - unicast, not me, ttl == 0 → drop (exhausted)
 *   - HELLO is never routed
 *   - the hop count reads `initialTtl - remainingTtl`
 */

import {
  SeenCache,
  decideRelay,
  withTtlDecremented,
  hopCount,
  isBroadcast,
  SEEN_CACHE_MAX_ENTRIES,
  SEEN_CACHE_TTL_MS,
} from '../src/services/relay';
import {
  TYPE_HELLO,
  TYPE_MESSAGE,
  TYPE_ACK,
  TYPE_POSITION,
  BROADCAST_DST,
  DEFAULT_TTL,
  type PacketHeader,
} from '../src/services/protocol';

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
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// --- fixtures ---

const MY_FP = '0102030405060708';
const OTHER_FP = '0807060504030201';
const THIRD_FP = '1122334455667788';

let msgIdCounter = 0;
function freshMsgId(): Uint8Array {
  msgIdCounter += 1;
  return hexToBytes(MY_FP).map((_, i) => (msgIdCounter + i) & 0xff);
}

function makeHeader(opts: {
  type: number;
  ttl?: number;
  dst?: Uint8Array;
  src?: Uint8Array;
  msgId?: Uint8Array;
  flags?: number;
}): PacketHeader {
  return {
    version: 0x02,
    type: opts.type,
    flags: opts.flags ?? 0,
    ttl: opts.ttl ?? DEFAULT_TTL,
    msgId: opts.msgId ?? freshMsgId(),
    src: opts.src ?? hexToBytes(OTHER_FP),
    dst: opts.dst ?? hexToBytes(MY_FP),
    payloadLen: 10,
  };
}

// =====================================================================
// SeenCache
// =====================================================================

describe('SeenCache', () => {
  it('reports a key as seen only after add', () => {
    const cache = new SeenCache();
    expect(cache.has('aa')).toBe(false);
    cache.add('aa');
    expect(cache.has('aa')).toBe(true);
  });

  it('evicts the oldest entry when over the cap (LRU)', () => {
    const cache = new SeenCache({ maxEntries: 3 });
    cache.add('a'); cache.add('b'); cache.add('c');
    expect(cache.has('a')).toBe(true);
    cache.add('d'); // over cap → 'a' evicted (oldest)
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
    expect(cache.size).toBe(3);
  });

  it('refreshes LRU order on re-add (a re-seen key is not evicted next)', () => {
    const cache = new SeenCache({ maxEntries: 3 });
    cache.add('a'); cache.add('b'); cache.add('c');
    // Re-add 'a' → it becomes most-recent; 'b' is now oldest.
    cache.add('a');
    cache.add('d'); // over cap → 'b' evicted
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('expires entries after the TTL', () => {
    let now = 1000;
    const cache = new SeenCache({ ttlMs: 5000, now: () => now });
    cache.add('k');
    expect(cache.has('k')).toBe(true);
    now += 4000;
    expect(cache.has('k')).toBe(true);
    now += 2000; // past TTL
    expect(cache.has('k')).toBe(false);
  });

  it('default cap + TTL match PLAN.md (~500 entries, 10 min)', () => {
    expect(SEEN_CACHE_MAX_ENTRIES).toBe(500);
    expect(SEEN_CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });
});

// =====================================================================
// decideRelay
// =====================================================================

describe('decideRelay — HELLO is never routed', () => {
  it('returns ignore for a HELLO packet (link-local)', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_HELLO, dst: BROADCAST_DST, ttl: 1 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('ignore');
  });

  it('returns ignore for a reserved type (POSITION, Phase 4)', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_POSITION, dst: BROADCAST_DST });
    expect(decideRelay(h, MY_FP, seen).action).toBe('ignore');
  });

  it('does NOT record a HELLO msgId in the seen-cache', () => {
    const seen = new SeenCache();
    const msgId = freshMsgId();
    const h = makeHeader({ type: TYPE_HELLO, msgId, dst: BROADCAST_DST });
    decideRelay(h, MY_FP, seen);
    expect(seen.has(bytesToHex(msgId))).toBe(false);
  });
});

describe('decideRelay — dedup', () => {
  it('drops a MESSAGE whose msgId was already seen', () => {
    const seen = new SeenCache();
    const msgId = freshMsgId();
    const h = makeHeader({ type: TYPE_MESSAGE, msgId, dst: hexToBytes(MY_FP) });
    expect(decideRelay(h, MY_FP, seen).action).toBe('deliver');
    // Second arrival of the same packet (looped back via another path):
    const d = decideRelay(h, MY_FP, seen);
    expect(d.action).toBe('drop');
    if (d.action === 'drop') expect(d.reason).toBe('duplicate');
  });

  it('drops an ACK whose msgId was already seen', () => {
    const seen = new SeenCache();
    const msgId = freshMsgId();
    const h = makeHeader({ type: TYPE_ACK, msgId, dst: hexToBytes(MY_FP) });
    decideRelay(h, MY_FP, seen);
    const d = decideRelay(h, MY_FP, seen);
    expect(d.action).toBe('drop');
    if (d.action === 'drop') expect(d.reason).toBe('duplicate');
  });
});

describe('decideRelay — delivery (dst == me)', () => {
  it('delivers a MESSAGE addressed to my fingerprint', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_MESSAGE, dst: hexToBytes(MY_FP), ttl: 4 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('deliver');
  });

  it('delivers an ACK addressed to my fingerprint', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_ACK, dst: hexToBytes(MY_FP), ttl: 4 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('deliver');
  });
});

describe('decideRelay — broadcast (dst == all-zero)', () => {
  it('delivers AND relays a broadcast MESSAGE', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_MESSAGE, dst: BROADCAST_DST, ttl: 5 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('deliver-and-relay');
  });

  it('delivers AND relays a broadcast ACK', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_ACK, dst: BROADCAST_DST, ttl: 5 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('deliver-and-relay');
  });
});

describe('decideRelay — relay (unicast, not me)', () => {
  it('relays a MESSAGE addressed to someone else when ttl > 0', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_MESSAGE, dst: hexToBytes(THIRD_FP), ttl: 3 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('relay');
  });

  it('drops a MESSAGE addressed to someone else when ttl == 0 (exhausted)', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_MESSAGE, dst: hexToBytes(THIRD_FP), ttl: 0 });
    const d = decideRelay(h, MY_FP, seen);
    expect(d.action).toBe('drop');
    if (d.action === 'drop') expect(d.reason).toBe('ttl-exhausted');
  });

  it('relays an ACK addressed to someone else when ttl > 0', () => {
    const seen = new SeenCache();
    const h = makeHeader({ type: TYPE_ACK, dst: hexToBytes(THIRD_FP), ttl: 2 });
    expect(decideRelay(h, MY_FP, seen).action).toBe('relay');
  });
});

describe('decideRelay — the A→B→C scenario', () => {
  // B is the relay. A sends to C (dst = C's fingerprint). B is not A or C.
  it("B relays A's MESSAGE to C (not B, ttl > 0)", () => {
    const seen = new SeenCache();
    const h = makeHeader({
      type: TYPE_MESSAGE,
      src: hexToBytes('aaaaaaaaaaaaaaaa'.slice(0, 16)),
      dst: hexToBytes('cccccccccccccccc'.slice(0, 16)),
      ttl: 5,
    });
    // B's fingerprint is MY_FP, which is neither A nor C → relay.
    expect(decideRelay(h, MY_FP, seen).action).toBe('relay');
  });

  it("C delivers A's MESSAGE (dst == C)", () => {
    const seen = new SeenCache();
    const cFp = 'cccccccccccccccc';
    const h = makeHeader({
      type: TYPE_MESSAGE,
      src: hexToBytes('aaaaaaaaaaaaaaaa'.slice(0, 16)),
      dst: hexToBytes(cFp),
      ttl: 3, // A→B decremented once, B→C decremented again → 3 remaining at C
    });
    expect(decideRelay(h, cFp, seen).action).toBe('deliver');
  });

  it("B relays C's ACK back to A (dst == A, not B)", () => {
    const seen = new SeenCache();
    const aFp = 'aaaaaaaaaaaaaaaa';
    const h = makeHeader({
      type: TYPE_ACK,
      src: hexToBytes('cccccccccccccccc'.slice(0, 16)),
      dst: hexToBytes(aFp),
      ttl: 4,
    });
    expect(decideRelay(h, MY_FP, seen).action).toBe('relay');
  });

  it("A delivers C's ACK (dst == A)", () => {
    const seen = new SeenCache();
    const aFp = 'aaaaaaaaaaaaaaaa';
    const h = makeHeader({
      type: TYPE_ACK,
      src: hexToBytes('cccccccccccccccc'.slice(0, 16)),
      dst: hexToBytes(aFp),
      ttl: 3,
    });
    expect(decideRelay(h, aFp, seen).action).toBe('deliver');
  });
});

// =====================================================================
// hopCount
// =====================================================================

describe('hopCount', () => {
  it('returns 0 for a self-originated packet (full TTL remaining)', () => {
    expect(hopCount(DEFAULT_TTL, DEFAULT_TTL)).toBe(0);
  });

  it('returns 1 for a direct message (one transmission, ttl decremented once)', () => {
    expect(hopCount(DEFAULT_TTL - 1, DEFAULT_TTL)).toBe(1);
  });

  it('returns 2 for a message via one relay (two transmissions)', () => {
    expect(hopCount(DEFAULT_TTL - 2, DEFAULT_TTL)).toBe(2);
  });

  it('clamps negative results to 0 (defensive against bad input)', () => {
    expect(hopCount(DEFAULT_TTL + 1, DEFAULT_TTL)).toBe(0);
  });
});

// =====================================================================
// withTtlDecremented
// =====================================================================

describe('withTtlDecremented', () => {
  it('returns a copy with byte[3] decremented by one', () => {
    const packet = new Uint8Array(30);
    packet[3] = 5; // TTL
    const out = withTtlDecremented(packet);
    expect(out[3]).toBe(4);
  });

  it('does NOT mutate the original packet bytes', () => {
    const packet = new Uint8Array(30);
    packet[3] = 5;
    withTtlDecremented(packet);
    expect(packet[3]).toBe(5); // unchanged
  });

  it('preserves every other byte (msgId, src, dst, payload)', () => {
    const packet = new Uint8Array(40);
    for (let i = 0; i < 40; i++) packet[i] = (i * 7 + 3) & 0xff;
    packet[3] = 5; // set TTL
    const out = withTtlDecremented(packet);
    for (let i = 0; i < 40; i++) {
      if (i === 3) continue;
      expect(out[i]).toBe(packet[i]);
    }
  });

  it('is a no-op (returns 0) when TTL is already 0', () => {
    const packet = new Uint8Array(30);
    packet[3] = 0;
    const out = withTtlDecremented(packet);
    expect(out[3]).toBe(0);
  });

  it('returns a same-length copy (not a view)', () => {
    const packet = new Uint8Array(37);
    const out = withTtlDecremented(packet);
    expect(out.length).toBe(37);
    expect(out).not.toBe(packet); // different reference
  });
});

// =====================================================================
// isBroadcast
// =====================================================================

describe('isBroadcast', () => {
  it('recognises the all-zero destination as broadcast', () => {
    expect(isBroadcast(BROADCAST_DST)).toBe(true);
    expect(isBroadcast(new Uint8Array(8))).toBe(true);
  });

  it('rejects a non-zero destination', () => {
    expect(isBroadcast(hexToBytes(MY_FP))).toBe(false);
  });

  it('rejects a wrong-length destination', () => {
    expect(isBroadcast(new Uint8Array(7))).toBe(false);
    expect(isBroadcast(new Uint8Array(9))).toBe(false);
  });
});

// =====================================================================
// Loop-back storm prevention (the Phase 3 exit-criteria concern)
// =====================================================================

describe('loop-back storm prevention (A↔B↔C all in range)', () => {
  it('a packet forwarded around a triangle is dropped on second sighting', () => {
    // A broadcasts a MESSAGE; B and C both receive it. B forwards to C; C
    // already saw it (from A directly) → drop. The seen-cache is what stops
    // the echo storm in a fully-meshed triangle.
    const seen = new SeenCache();
    const msgId = freshMsgId();
    const h = makeHeader({ type: TYPE_MESSAGE, msgId, dst: hexToBytes(THIRD_FP), ttl: 5 });

    // First sighting at C (relay — not for C).
    expect(decideRelay(h, MY_FP, seen).action).toBe('relay');
    // C's neighbors forward it back to C — same msgId → drop.
    const d = decideRelay(h, MY_FP, seen);
    expect(d.action).toBe('drop');
    if (d.action === 'drop') expect(d.reason).toBe('duplicate');
  });
});
