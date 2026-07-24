/**
 * Phase 4 unit tests for the geographic routing core.
 *
 * `location.ts` is pure TypeScript — no BLE, no DB, no crypto, no expo native
 * modules — so it runs under a plain node Jest environment with no hardware.
 * This is where the geographic-routing correctness lives: a wrong greedy
 * decision means either a lost packet (over-aggressive drop) or needless
 * flooding (defeating the whole point of Phase 4).
 *
 * Scenarios mirror PLAN.md Phase 4 "Forwarding decision":
 *   - destination position unknown → flood
 *   - no self position → flood (flooding-only relay)
 *   - a neighbor closer to the destination than us → greedy (pick the closest)
 *   - no neighbor closer (local minimum) → flood
 *   - flood-mode flag set by an upstream relay → keep flooding
 *   - haversine matches known great-circle distances
 *   - location table evicts stale entries
 */

import {
  LocationTable,
  haversineMeters,
  greedyForwardDecision,
  LOCATION_TTL_MS,
  EARTH_RADIUS_M,
  type NeighborPosition,
  type PositionEntry,
} from '../src/services/location';
import {
  TYPE_MESSAGE,
  FLAG_FLOOD_MODE,
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

// --- fixtures ---

const MY_FP = '0102030405060708';
const NEIGHBOR_A_FP = 'aaaaaaaaaaaaaaaa';
const NEIGHBOR_B_FP = 'bbbbbbbbbbbbbbbb';
const DEST_FP = 'cccccccccccccccc';

// SF ~ (37.7749, -122.4194). Use truncated 3-decimal coords (as on the wire).
const SF: PositionEntry = { lat: 37.775, lon: -122.419, timestamp: 0 };
// Oakland ~ (37.8044, -122.2712) — NE of SF, ~13 km.
const OAKLAND: PositionEntry = { lat: 37.804, lon: -122.271, timestamp: 0 };
// Sacramento ~ (38.5816, -121.4944) — NE of Oakland, further from SF.
const SACRAMENTO: PositionEntry = { lat: 38.582, lon: -121.494, timestamp: 0 };
// LA ~ (34.0522, -118.2437) — far SE, ~550 km from SF.
const LA: PositionEntry = { lat: 34.052, lon: -118.244, timestamp: 0 };

function makeHeader(opts: {
  type?: number;
  ttl?: number;
  dst?: Uint8Array;
  src?: Uint8Array;
  flags?: number;
}): PacketHeader {
  return {
    version: 0x02,
    type: opts.type ?? TYPE_MESSAGE,
    flags: opts.flags ?? 0,
    ttl: opts.ttl ?? DEFAULT_TTL,
    msgId: hexToBytes('1122334455667788'),
    src: opts.src ?? hexToBytes(NEIGHBOR_A_FP),
    dst: opts.dst ?? hexToBytes(DEST_FP),
    payloadLen: 10,
  };
}

// =====================================================================
// haversineMeters
// =====================================================================

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(SF, SF)).toBe(0);
  });

  it('is symmetric: dist(a,b) === dist(b,a)', () => {
    expect(haversineMeters(SF, OAKLAND)).toBeCloseTo(haversineMeters(OAKLAND, SF), 1);
  });

  it('matches the known SF→Oakland distance (~13 km)', () => {
    // Great-circle distance SF→Oakland is ~13.3 km.
    const d = haversineMeters(SF, OAKLAND);
    expect(d).toBeGreaterThan(12_000);
    expect(d).toBeLessThan(15_000);
  });

  it('matches the known SF→LA distance (~550 km)', () => {
    const d = haversineMeters(SF, LA);
    expect(d).toBeGreaterThan(540_000);
    expect(d).toBeLessThan(560_000);
  });

  it('satisfies the triangle inequality', () => {
    const dAB = haversineMeters(SF, OAKLAND);
    const dBC = haversineMeters(OAKLAND, SACRAMENTO);
    const dAC = haversineMeters(SF, SACRAMENTO);
    expect(dAC).toBeLessThanOrEqual(dAB + dBC);
  });
});

// =====================================================================
// LocationTable
// =====================================================================

describe('LocationTable', () => {
  it('returns null for an unknown fingerprint', () => {
    const t = new LocationTable();
    expect(t.get('unknown')).toBeNull();
    expect(t.has('unknown')).toBe(false);
  });

  it('stores and returns a position', () => {
    const t = new LocationTable();
    t.set(MY_FP, 37.775, -122.419);
    const pos = t.get(MY_FP);
    expect(pos).not.toBeNull();
    expect(pos!.lat).toBeCloseTo(37.775, 5);
    expect(pos!.lon).toBeCloseTo(-122.419, 5);
    expect(t.has(MY_FP)).toBe(true);
  });

  it('evicts entries older than the TTL (stale → null)', () => {
    let now = 1000;
    const t = new LocationTable({ ttlMs: 5000, now: () => now });
    t.set(MY_FP, 37.775, -122.419);
    expect(t.has(MY_FP)).toBe(true);
    now += 4000;
    expect(t.has(MY_FP)).toBe(true);
    now += 2000; // past TTL
    expect(t.get(MY_FP)).toBeNull();
    expect(t.has(MY_FP)).toBe(false);
  });

  it('prune() removes all stale entries', () => {
    let now = 1000;
    const t = new LocationTable({ ttlMs: 5000, now: () => now });
    t.set('a', 1, 1);
    t.set('b', 2, 2);
    now += 6000; // both stale
    t.prune();
    expect(t.size).toBe(0);
  });

  it('refreshes the timestamp on re-set (keeps a moving peer fresh)', () => {
    let now = 1000;
    const t = new LocationTable({ ttlMs: 5000, now: () => now });
    t.set(MY_FP, 37.775, -122.419);
    now += 4000;
    t.set(MY_FP, 37.776, -122.420); // refresh
    now += 4000; // 8s total, but refreshed at 5s → only 3s since refresh
    expect(t.has(MY_FP)).toBe(true);
  });

  it('default TTL matches PLAN.md (~10 min)', () => {
    expect(LOCATION_TTL_MS).toBe(10 * 60 * 1000);
  });
});

// =====================================================================
// greedyForwardDecision
// =====================================================================

describe('greedyForwardDecision — flood fallbacks', () => {
  it('floods when the destination position is unknown (not in table)', () => {
    const t = new LocationTable();
    const d = greedyForwardDecision({
      header: makeHeader({}),
      myFingerprintHex: MY_FP,
      myPosition: SF,
      destinationPosition: t.get(DEST_FP), // null
      neighbors: [],
    });
    expect(d.strategy).toBe('flood');
    if (d.strategy === 'flood') expect(d.reason).toBe('no-destination-position');
  });

  it('floods when we have no self position (flooding-only relay)', () => {
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon);
    const d = greedyForwardDecision({
      header: makeHeader({}),
      myFingerprintHex: MY_FP,
      myPosition: null, // no GPS fix
      destinationPosition: t.get(DEST_FP),
      neighbors: [{ fingerprintHex: NEIGHBOR_A_FP, position: OAKLAND }],
    });
    expect(d.strategy).toBe('flood');
    if (d.strategy === 'flood') expect(d.reason).toBe('no-self-position');
  });

  it('floods when no neighbor has a known position', () => {
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon);
    const d = greedyForwardDecision({
      header: makeHeader({}),
      myFingerprintHex: MY_FP,
      myPosition: SF,
      destinationPosition: t.get(DEST_FP),
      neighbors: [], // all neighbors skipped (no positions)
    });
    expect(d.strategy).toBe('flood');
    if (d.strategy === 'flood') expect(d.reason).toBe('no-neighbor-positions');
  });

  it('floods when already in flood-mode (upstream relay hit a local minimum)', () => {
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon);
    const d = greedyForwardDecision({
      header: makeHeader({ flags: FLAG_FLOOD_MODE }),
      myFingerprintHex: MY_FP,
      myPosition: SF,
      destinationPosition: t.get(DEST_FP),
      neighbors: [{ fingerprintHex: NEIGHBOR_A_FP, position: OAKLAND }],
    });
    expect(d.strategy).toBe('flood');
    if (d.strategy === 'flood') expect(d.reason).toBe('flood-mode');
  });
});

describe('greedyForwardDecision — greedy selection', () => {
  it('selects the neighbor strictly closer to the destination than us', () => {
    // We are in SF. Destination is Sacramento (NE, ~120 km). Neighbor A is
    // Oakland (between SF and Sacramento, closer to Sac than SF is).
    // → greedy to A.
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon);
    const d = greedyForwardDecision({
      header: makeHeader({}),
      myFingerprintHex: MY_FP,
      myPosition: SF,
      destinationPosition: t.get(DEST_FP),
      neighbors: [{ fingerprintHex: NEIGHBOR_A_FP, position: OAKLAND }],
    });
    expect(d.strategy).toBe('greedy');
    if (d.strategy === 'greedy') {
      expect(d.targetFingerprintHex).toBe(NEIGHBOR_A_FP);
      expect(d.progressMeters).toBeGreaterThan(0);
    }
  });

  it('picks the closest neighbor when multiple qualify (max progress)', () => {
    // SF → Sacramento. Oakland (~13km from SF) and Sacramento-adjacent neighbor.
    // The one closest to Sacramento is picked.
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon);
    // Neighbor near Sacramento (very close to dest).
    const nearDest: PositionEntry = { lat: 38.5, lon: -121.5, timestamp: 0 };
    const d = greedyForwardDecision({
      header: makeHeader({}),
      myFingerprintHex: MY_FP,
      myPosition: SF,
      destinationPosition: t.get(DEST_FP),
      neighbors: [
        { fingerprintHex: NEIGHBOR_A_FP, position: OAKLAND },
        { fingerprintHex: NEIGHBOR_B_FP, position: nearDest },
      ],
    });
    expect(d.strategy).toBe('greedy');
    if (d.strategy === 'greedy') {
      expect(d.targetFingerprintHex).toBe(NEIGHBOR_B_FP);
    }
  });

  it('skips neighbors with no position (not passed in)', () => {
    // Only neighbors WITH positions are passed to the decision; the caller
    // (messageRouter.collectNeighborPositions) filters. Here we verify that
    // an empty neighbors list (all filtered out) → flood, not crash.
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon);
    const d = greedyForwardDecision({
      header: makeHeader({}),
      myFingerprintHex: MY_FP,
      myPosition: SF,
      destinationPosition: t.get(DEST_FP),
      neighbors: [],
    });
    expect(d.strategy).toBe('flood');
  });
});

describe('greedyForwardDecision — local minimum', () => {
  it('floods when no neighbor is closer to the destination than us', () => {
    // We are in Oakland (closer to Sacramento than SF is). Our only neighbor
    // is SF, which is FARTHER from Sacramento than we are. → local minimum.
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon);
    const d = greedyForwardDecision({
      header: makeHeader({}),
      myFingerprintHex: MY_FP,
      myPosition: OAKLAND, // we're closer to dest
      destinationPosition: t.get(DEST_FP),
      neighbors: [{ fingerprintHex: NEIGHBOR_A_FP, position: SF }], // neighbor is farther
    });
    expect(d.strategy).toBe('flood');
    if (d.strategy === 'flood') expect(d.reason).toBe('local-minimum');
  });

  it('does NOT greedy-forward to a neighbor at exactly the same distance (strict <)', () => {
    // Two nodes at the same location: neither is "strictly closer".
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon);
    const d = greedyForwardDecision({
      header: makeHeader({}),
      myFingerprintHex: MY_FP,
      myPosition: OAKLAND,
      destinationPosition: t.get(DEST_FP),
      neighbors: [{ fingerprintHex: NEIGHBOR_A_FP, position: OAKLAND }], // same spot
    });
    expect(d.strategy).toBe('flood');
    if (d.strategy === 'flood') expect(d.reason).toBe('local-minimum');
  });
});

// =====================================================================
// The A→B→C geographic scenario (PLAN.md Phase 4 testing)
// =====================================================================

describe('A→B→C geographic scenario (Phase 4 exit criteria)', () => {
  // Three phones spread across a field. A is at SF, B at Oakland, C at
  // Sacramento. A sends to C. A's neighbor B is closer to C than A is →
  // greedy forward to B only (not flood to all). This is the headline
  // mechanism: 1 targeted transmission vs N-neighbor flood.
  it('A forwards to B only (greedy) — B is closer to C than A is', () => {
    const t = new LocationTable();
    t.set(DEST_FP, SACRAMENTO.lat, SACRAMENTO.lon); // C's position
    const d = greedyForwardDecision({
      header: makeHeader({ src: hexToBytes(MY_FP), dst: hexToBytes(DEST_FP) }),
      myFingerprintHex: MY_FP, // A
      myPosition: SF,           // A at SF
      destinationPosition: t.get(DEST_FP),
      neighbors: [{ fingerprintHex: NEIGHBOR_B_FP, position: OAKLAND }], // B at Oakland
    });
    expect(d.strategy).toBe('greedy');
    if (d.strategy === 'greedy') {
      expect(d.targetFingerprintHex).toBe(NEIGHBOR_B_FP);
      // Progress: how much closer B is to C than A is. SF→Sac ~120km,
      // Oakland→Sac ~107km → progress ~13km. (Rough; the exact number
      // depends on the truncated coords, but it must be positive and
      // in the tens-of-km range.)
      expect(d.progressMeters).toBeGreaterThan(5_000);
      expect(d.progressMeters).toBeLessThan(30_000);
    }
  });

  it('degrades to flooding when C disables GPS (destination position stale)', () => {
    // C's position went stale (GPS off > 10 min). A's table has no fresh entry
    // for C → flood. Message still arrives (via flooding) — the Phase 4
    // "clean fallback to flooding when not" exit criterion.
    const t = new LocationTable();
    // No set(DEST_FP, ...) — C's position is unknown.
    const d = greedyForwardDecision({
      header: makeHeader({ dst: hexToBytes(DEST_FP) }),
      myFingerprintHex: MY_FP,
      myPosition: SF,
      destinationPosition: t.get(DEST_FP), // null
      neighbors: [{ fingerprintHex: NEIGHBOR_B_FP, position: OAKLAND }],
    });
    expect(d.strategy).toBe('flood');
    if (d.strategy === 'flood') expect(d.reason).toBe('no-destination-position');
  });
});
