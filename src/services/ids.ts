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

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
