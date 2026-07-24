/**
 * Phase 3 — Relay engine: the pure, transport-agnostic core of multi-hop
 * flooding. No BLE, no DB, no crypto — just the seen-cache and the
 * deliver/forward decision. This is the part of the mesh that is cheaply
 * unit-testable without hardware.
 *
 * Algorithm (PLAN.md Phase 3 "Flooding algorithm"):
 *   On receiving a MESSAGE/ACK packet:
 *     1. Dedup: if msgId is in the seen-cache → drop.
 *     2. If dst == myFingerprint → deliver locally.
 *     3. Else if ttl > 0 → decrement ttl, re-send to all neighbors except
 *        the link it arrived on.
 *     4. Broadcast dst (all-zero) → deliver locally AND relay.
 *
 * HELLO is NOT relayed — it is a link-local handshake consumed by ble.ts at
 * the link layer. The relay engine ignores it.
 *
 * ACKs are flooded exactly like MESSAGEs, addressed to the original sender's
 * fingerprint (`header.src` of the ACK is the receiver, `header.dst` is the
 * original sender). That is what makes end-to-end `delivered` status work
 * across hops.
 *
 * The seen-cache is an LRU with a TTL: ~500 entries, 10-min expiry. The
 * `msgId` (8-byte transport id from the v2 header) is the dedup key — it is
 * stable across hops because relays forward the *same* packet bytes (only
 * the TTL byte changes), so a packet looping back via a different path is
 * still recognised as a duplicate.
 */

import {
  BROADCAST_DST,
  TYPE_HELLO,
  TYPE_MESSAGE,
  TYPE_ACK,
  TYPE_POSITION,
  FLAG_FLOOD_MODE,
  FINGERPRINT_SIZE,
} from './protocol';
import type { PacketHeader } from './protocol';
import { bytesToHex, hexToBytes } from './ids';

/** Default cap for the in-memory seen-cache (PLAN.md: ~500 entries). */
export const SEEN_CACHE_MAX_ENTRIES = 500;
/** Default TTL for seen-cache entries (PLAN.md: 10 min). */
export const SEEN_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * LRU-with-TTL dedup cache keyed by the hex encoding of the packet's 8-byte
 * `msgId`. JS `Map` iterates in insertion order, which gives us a cheap LRU:
 * on a hit we re-insert to mark the entry most-recently-used; on overflow we
 * evict the oldest entry. Expired entries are swept opportunistically on
 * `add` and `has`.
 *
 * In-memory only for Phase 3. PLAN.md mentions "persisted best-effort" —
 * cross-restart dedup is a Phase 5 concern (store-and-forward retries must be
 * idempotent across restarts); for the relay demo the in-memory cache is
 * sufficient and keeps the hot path allocation-free.
 */
export class SeenCache {
  private entries = new Map<string, number>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  /** Monotonic clock injection point so tests can advance time deterministically. */
  private now: () => number;

  constructor(opts?: { maxEntries?: number; ttlMs?: number; now?: () => number }) {
    this.maxEntries = opts?.maxEntries ?? SEEN_CACHE_MAX_ENTRIES;
    this.ttlMs = opts?.ttlMs ?? SEEN_CACHE_TTL_MS;
    this.now = opts?.now ?? (() => Date.now());
  }

  /** True if `key` was seen recently (within the TTL). Does not refresh. */
  has(key: string): boolean {
    const ts = this.entries.get(key);
    if (ts === undefined) return false;
    if (this.now() - ts > this.ttlMs) {
      // Expired — drop lazily so the slot can be reclaimed.
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Record `key` as seen now. Evicts the oldest entry if over the cap. */
  add(key: string): void {
    // If already present, refresh insertion order (LRU) by re-inserting.
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, this.now());
    // Evict oldest (first entry) while over capacity.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
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

/** The outcome of `decideRelay` — what the router should do with this packet. */
export type RelayDecision =
  | { action: 'ignore' }
  | { action: 'drop'; reason: 'duplicate' | 'ttl-exhausted' }
  | { action: 'deliver' }
  | { action: 'deliver-and-relay' }
  | { action: 'relay' };

/** True if `dst` is the all-zero broadcast address. */
export function isBroadcast(dst: Uint8Array): boolean {
  if (dst.length !== FINGERPRINT_SIZE) return false;
  for (let i = 0; i < FINGERPRINT_SIZE; i++) {
    if (dst[i] !== 0) return false;
  }
  return true;
}

/**
 * Decide what to do with a freshly-decoded incoming packet.
 *
 * Pure: takes the header, the local fingerprint (hex), and the seen-cache;
 * mutates only the seen-cache (adding the msgId). The caller (messageRouter)
 * performs the actual deliver / forward / drop based on the decision.
 *
 * - HELLO → `ignore` (link-layer concern, never flooded).
 * - Already-seen msgId → `drop` (duplicate).
 * - dst == myFingerprint → `deliver`.
 * - dst == broadcast → `deliver-and-relay`.
 * - Else (unicast, not for us):
 *     - ttl > 0 → `relay` (caller decrements ttl and forwards).
 *     - ttl == 0 → `drop` (ttl-exhausted).
 *
 * Phase 4 — POSITION beacons (type 0x04) are now routable. They are always
 * broadcast (dst = 0x00…00, TTL ~3): every node that receives one updates
 * its location table (`deliver`) and re-floods it (`relay`) so positions
 * propagate beyond direct neighbors. Deduped via the seen-cache like any
 * other flooded packet, so a triangle topology doesn't echo.
 */
export function decideRelay(
  header: PacketHeader,
  myFingerprintHex: string,
  seen: SeenCache,
): RelayDecision {
  // HELLO is link-local — the relay engine never touches it.
  if (header.type === TYPE_HELLO) {
    return { action: 'ignore' };
  }

  // Only MESSAGE, ACK, and POSITION are routable. Any other type (SYNC_* is
  // Phase 6) is dropped by the protocol layer before reaching here, but be
  // defensive.
  if (
    header.type !== TYPE_MESSAGE &&
    header.type !== TYPE_ACK &&
    header.type !== TYPE_POSITION
  ) {
    return { action: 'ignore' };
  }

  const msgIdHex = bytesToHex(header.msgId);
  if (seen.has(msgIdHex)) {
    return { action: 'drop', reason: 'duplicate' };
  }
  // Record immediately so a rapid loop-back (e.g. a neighbor echoing via a
  // second path) is caught before we forward.
  seen.add(msgIdHex);

  const dstHex = bytesToHex(header.dst);

  if (isBroadcast(header.dst)) {
    // Broadcast: deliver locally AND relay to neighbors.
    return { action: 'deliver-and-relay' };
  }

  if (dstHex === myFingerprintHex) {
    // Addressed to us: deliver locally, do not relay.
    return { action: 'deliver' };
  }

  // Unicast, not for us. Forward only if the hop budget allows.
  if (header.ttl > 0) {
    return { action: 'relay' };
  }
  return { action: 'drop', reason: 'ttl-exhausted' };
}

/**
 * Phase 3 — Compute the hop count a packet travelled to reach us.
 *
 * `hops = initialTtl - remainingTtl`. The sender sets `initialTtl` (default
 * DEFAULT_TTL = 5); each relay decrements the TTL byte once. So a direct
 * message arrives with TTL 4 → 1 hop; via one relay with TTL 3 → 2 hops;
 * "via N relays" = hops - 1. Returns 0 for self-originated packets (no hops).
 */
export function hopCount(remainingTtl: number, initialTtl: number): number {
  const h = initialTtl - remainingTtl;
  return h < 0 ? 0 : h;
}

/**
 * Phase 3 / Phase 4 — Return a copy of `packetBytes` with the TTL byte
 * (byte[3]) decremented by one. The caller passes this to `fragmentPacket`
 * for forwarding. A copy is returned (not an in-place mutation) because
 * `packetBytes` is shared with `headerBytes` / `payload` subarray views, and
 * the relay engine may still need the original (e.g. to deliver locally on a
 * broadcast before forwarding).
 *
 * Phase 4 — `opts.setFloodMode` additionally sets FLAG_FLOOD_MODE (bit 2 of
 * byte[2]) so downstream relays keep flooding instead of oscillating back to
 * greedy. This bit is excluded from the AES-GCM AAD (`headerToAAD` clears
 * it), so mutating it does NOT invalidate the ciphertext — the destination
 * still decrypts successfully. All other header bytes are preserved
 * byte-for-byte, so the transport-level `msgId` dedup key is stable across
 * hops.
 *
 * No-op (returns a copy unchanged) if TTL is already 0 — the decision
 * function should have dropped it, but this keeps the helper total.
 */
export function withTtlDecremented(
  packetBytes: Uint8Array,
  opts?: { setFloodMode?: boolean },
): Uint8Array {
  const out = new Uint8Array(packetBytes.length);
  out.set(packetBytes);
  if (out[3] > 0) out[3] -= 1;
  if (opts?.setFloodMode) {
    out[2] = out[2] | FLAG_FLOOD_MODE;
  }
  return out;
}

/** Convenience: build a 0x00…00 broadcast dst as a Uint8Array. */
export function broadcastDst(): Uint8Array {
  return new Uint8Array(BROADCAST_DST); // copy so callers can't mutate the const
}

/** Test helper: parse a 16-char hex fingerprint back to 8 bytes. */
export function fpFromHex(hex: string): Uint8Array {
  return hexToBytes(hex);
}
