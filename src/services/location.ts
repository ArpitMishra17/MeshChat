/**
 * Phase 4 — Geographic routing: the pure, transport-agnostic core.
 *
 * No BLE, no DB, no crypto, no expo native modules — just the location
 * table, the haversine distance, and the greedy-forwarding decision. This
 * is the part of GPS routing that is cheaply unit-testable without
 * hardware, mirroring the split between `relay.ts` (pure decision) and
 * `messageRouter.ts` (side effects) in Phase 3.
 *
 * Algorithm (PLAN.md Phase 4 "Forwarding decision"):
 *   For a unicast packet (MESSAGE/ACK with a specific dst):
 *     1. Look up the destination in the location table.
 *        Unknown/stale → fall back to flooding.
 *     2. Compute haversine distance from each connected neighbor's
 *        last-known position to the destination. Neighbors with no known
 *        position are skipped.
 *     3. Greedy: forward only to the neighbor strictly closer to the
 *        destination than this node ("progress" rule).
 *     4. Local minimum (no neighbor is closer): fall back to flooding for
 *        this packet and mark it flood-mode so downstream nodes don't flip
 *        back to greedy.
 *   Broadcast packets always flood. ACKs are treated like unicast MESSAGEs
 *   (greedy when the destination position is known, flood when not).
 *
 * Reference: GPSR (Greedy Perimeter Stateless Routing, Karp & Kung 2000).
 * Full perimeter/face routing around local minima is out of scope; we use
 * the honest, simple fallback to flooding, documented in the report.
 */

import type { PacketHeader } from './protocol';
import { FLAG_FLOOD_MODE } from './protocol';

/** A WGS-84 coordinate with a freshness timestamp (ms since epoch). */
export interface GeoCoord {
  lat: number;
  lon: number;
}

export interface PositionEntry extends GeoCoord {
  timestamp: number;
}

/** Entries older than this are considered stale (PLAN.md: ~10 min). */
export const LOCATION_TTL_MS = 10 * 60 * 1000;

/** Earth radius in meters (mean radius, WGS-84). */
export const EARTH_RADIUS_M = 6_371_000;

/**
 * Location table: `fingerprint hex → {lat, lon, timestamp}`.
 *
 * Pure in-memory store with staleness eviction. Updated from received
 * POSITION beacons and HELLO-with-position; read by the forwarding
 * decision. Entries stale after `LOCATION_TTL_MS`; expired lazily on
 * `get`/`has` and swept on `prune`.
 *
 * JS `Map` iterates in insertion order; we evict stale entries
 * opportunistically, which is cheap and keeps the table bounded by the
 * number of distinct peers ever seen (capped in practice by the mesh size).
 */
export class LocationTable {
  private entries = new Map<string, PositionEntry>();
  private readonly ttlMs: number;
  private now: () => number;

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? LOCATION_TTL_MS;
    this.now = opts?.now ?? (() => Date.now());
  }

  /**
   * Record (or refresh) `fingerprintHex`'s position. `timestamp` is the
   * arrival time (robust against sender clock skew); the beacon's own
   * timestamp is informational and not used for staleness.
   */
  set(fingerprintHex: string, lat: number, lon: number, timestamp?: number): void {
    this.entries.set(fingerprintHex, {
      lat,
      lon,
      timestamp: timestamp ?? this.now(),
    });
  }

  /** The fresh position for `fingerprintHex`, or null if unknown/stale. */
  get(fingerprintHex: string): PositionEntry | null {
    const e = this.entries.get(fingerprintHex);
    if (!e) return null;
    if (this.now() - e.timestamp > this.ttlMs) {
      this.entries.delete(fingerprintHex);
      return null;
    }
    return e;
  }

  /** True if `fingerprintHex` has a fresh position. */
  has(fingerprintHex: string): boolean {
    return this.get(fingerprintHex) !== null;
  }

  /** Remove all stale entries. Call periodically (e.g. on each beacon). */
  prune(): void {
    for (const [key, e] of this.entries) {
      if (this.now() - e.timestamp > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  /** Number of entries currently cached (including any not yet swept). */
  get size(): number {
    return this.entries.size;
  }

  /** Test/maintenance: drop everything. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Great-circle distance between two WGS-84 points, in meters (haversine).
 *
 * Used by the greedy decision to compare "how far is each neighbor from
 * the destination" against "how far am I from the destination". Precision
 * is more than sufficient for BLE-scale meshes (tens to hundreds of meters).
 */
export function haversineMeters(a: GeoCoord, b: GeoCoord): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  // Clamp to [0,1] to avoid NaN from floating-point drift past asin's domain.
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return EARTH_RADIUS_M * c;
}

/** Why a unicast packet fell back to flooding. */
export type FloodReason =
  | 'no-destination-position' // dst not in the location table (or stale)
  | 'no-self-position'        // we have no GPS fix → can't judge progress
  | 'no-neighbor-positions'   // no neighbor has a known position to route to
  | 'local-minimum'           // no neighbor is strictly closer than us
  | 'flood-mode';             // header already marked flood-mode by an upstream relay

/**
 * The greedy-forwarding decision for one unicast packet.
 *
 * - `greedy` — forward to the single neighbor strictly closest to the
 *   destination (and closer than this node). `progressMeters` is how much
 *   closer that neighbor is than us — the headline metric for the report.
 * - `flood` — fall back to flooding. The caller sets FLAG_FLOOD_MODE on
 *   the forwarded packet (except for the `flood-mode` reason, where it's
 *   already set) so downstream relays don't re-enter greedy.
 */
export type ForwardDecision =
  | { strategy: 'greedy'; targetFingerprintHex: string; progressMeters: number }
  | { strategy: 'flood'; reason: FloodReason };

/** A neighbor with a known fresh position, for the greedy decision. */
export interface NeighborPosition {
  fingerprintHex: string;
  position: PositionEntry;
}

/**
 * Decide whether to forward a unicast packet greedily or flood it.
 *
 * Pure: takes the packet header (for dst + flood-mode flag), this node's
 * fingerprint + position, the destination's position, and the list of
 * neighbors that have known positions. Returns the decision; the caller
 * (messageRouter) performs the actual send.
 *
 * The "progress" rule: a neighbor qualifies iff it is *strictly* closer to
 * the destination than this node. Among qualifiers, the closest is chosen
 * (maximising progress per hop — the standard greedy choice). If no
 * neighbor qualifies, we are at a local minimum → flood.
 */
export function greedyForwardDecision(opts: {
  header: PacketHeader;
  myFingerprintHex: string;
  myPosition: PositionEntry | null;
  destinationPosition: PositionEntry | null;
  neighbors: NeighborPosition[];
}): ForwardDecision {
  // Already in flood-mode (an upstream relay hit a local minimum) — keep
  // flooding; don't oscillate back to greedy. PLAN.md Phase 4 step 4.
  if (opts.header.flags & FLAG_FLOOD_MODE) {
    return { strategy: 'flood', reason: 'flood-mode' };
  }

  // No position for the destination → can't route geographically. This is
  // the common case for a peer we've never met or whose fix went stale.
  if (!opts.destinationPosition) {
    return { strategy: 'flood', reason: 'no-destination-position' };
  }

  // No GPS fix of our own → we can't compute our own distance to the
  // destination, so we can't judge whether a neighbor makes progress.
  // Flood (nodes without a fix are flooding-only relays per PLAN.md).
  if (!opts.myPosition) {
    return { strategy: 'flood', reason: 'no-self-position' };
  }

  if (opts.neighbors.length === 0) {
    return { strategy: 'flood', reason: 'no-neighbor-positions' };
  }

  const dst = opts.destinationPosition;
  const myDist = haversineMeters(opts.myPosition, dst);

  // Find the neighbor strictly closer to the destination than this node.
  let best: NeighborPosition | null = null;
  let bestDist = Infinity;
  for (const n of opts.neighbors) {
    const d = haversineMeters(n.position, dst);
    if (d < myDist && d < bestDist) {
      best = n;
      bestDist = d;
    }
  }

  if (!best) {
    // Local minimum: no neighbor is closer than us. The well-known greedy
    // dead-end. Fall back to flooding (GPSR would switch to perimeter
    // routing here; that is out of scope — see report).
    return { strategy: 'flood', reason: 'local-minimum' };
  }

  // progressMeters: how much closer the chosen neighbor is than us. This is
  // the demo's headline number: "greedy → forwarded only to B (progress 220 m)".
  return {
    strategy: 'greedy',
    targetFingerprintHex: best.fingerprintHex,
    progressMeters: myDist - bestDist,
  };
}

// --- App-singleton access ------------------------------------------------
//
// One shared location table for the app: ble.ts writes to it (from received
// POSITION beacons and HELLO-with-position), messageRouter reads it (for the
// greedy forwarding decision). Imported as `getLocationTable()` so the
// dependency is explicit and tests can construct their own instances.

let appLocationTable: LocationTable | null = null;

export function getLocationTable(): LocationTable {
  if (!appLocationTable) {
    appLocationTable = new LocationTable();
  }
  return appLocationTable;
}

/** Test-only: reset the app singleton between tests. */
export function _resetLocationTable(): void {
  appLocationTable = null;
}
