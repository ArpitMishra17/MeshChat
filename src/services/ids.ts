import * as Crypto from 'expo-crypto';

/**
 * P0.2 / P0.8 — Cryptographically-random, fixed-width, wire-safe identifiers.
 *
 * Previous implementation used `Date.now().toString(36) + "_" + Math.random()...`
 * (~25 chars) and then truncated to 12 chars on the wire, so ACKs could never
 * match the stored 25-char row. We now use 16 hex chars (64 bits of entropy)
 * everywhere — same id on the wire and in the DB — and never truncate.
 */
export function generateMessageId(): string {
  return bytesToHex(Crypto.getRandomBytes(8));
}

export function generateConversationId(): string {
  return bytesToHex(Crypto.getRandomBytes(8));
}

/**
 * Phase 1 — random 64-bit packet id. This is the transport-level dedup key
 * carried in the v2 packet header (msgId field), used by the flooding engine
 * in Phase 3 to avoid re-processing a packet seen before. It is distinct from
 * the application-level message id (`generateMessageId`) which is what ACKs
 * match against — a single MESSAGE packet has both: header.msgId for transport
 * dedup, and a message id inside the payload body for delivery tracking.
 */
export function generatePacketId(): Uint8Array {
  return Crypto.getRandomBytes(8);
}

/**
 * Phase 1 — derive a stable 8-byte node identifier (the "fingerprint") from a
 * deviceId, for the v2 packet header's `src` / `dst` fields.
 *
 * This is a PLACEHOLDER for Phase 2. Phase 2 replaces identity with a long-term
 * X25519 keypair and derives the fingerprint as SHA-256(pubkey) truncated to 8
 * bytes — same 8-byte width, so the header layout is unchanged. Until then we
 * need *some* deterministic 8-byte derivation of the existing UUID deviceId so
 * that two peers compute the same `dst` for a given conversation.
 *
 * FNV-1a 64-bit is used because it is synchronous and dependency-free (the
 * alternative, `Crypto.digestStringAsync`, is async and would force the whole
 * encode path to become async). It is not cryptographic, but it does not need
 * to be at this stage — it only has to be a stable, well-distributed 8-byte
 * tag. Phase 2's SHA-256 truncation is the real thing.
 */
export function fingerprintFromDeviceId(deviceId: string): Uint8Array {
  // FNV-1a 64-bit. Constants per the spec.
  let h = 14695981039346656037n;          // offset basis (0xcbf29ce484222325)
  const prime = 1099511628211n;           // 0x100000001b3
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < deviceId.length; i++) {
    h = (h ^ BigInt(deviceId.charCodeAt(i))) & mask;
    h = (h * prime) & mask;
  }
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(h & 0xffn);
    h >>= 8n;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Parse a hex string into a Uint8Array. Rejects odd lengths and non-hex chars.
 * Used by tests and by fingerprint comparisons; not on any hot path.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex char in: ${hex}`);
    }
    out[i] = byte;
  }
  return out;
}
