import * as SecureStore from 'expo-secure-store';
import { getDB, getIdentity, saveIdentity } from '../db/database';
import type { Identity } from '../types';
import {
  initAppCrypto,
  getCrypto,
  fingerprintFromPubKey,
  PUBLIC_KEY_SIZE,
} from './crypto';
import { bytesToHex, hexToBytes } from './ids';

const PRIVATE_KEY_STORAGE_KEY = 'meshchat_x25519_private_key';

let cachedIdentity: Identity | null = null;

/**
 * Return the current identity, or throw if onboarding hasn't run yet.
 *
 * Phase 2 — the private key is loaded from `expo-secure-store` (sync), the
 * public key + fingerprint are derived from it, and the display name is
 * read from SQLite. The crypto service singleton is initialized on first
 * call so other modules can `getCrypto()` without re-reading secure store.
 *
 * P0.8 — Previously this auto-created an identity with a random name on
 * first call (running from `startPeripheral` and other hot paths). Onboarding
 * is now the only creator — see `createIdentity`.
 */
export function ensureIdentity(): Identity {
  if (cachedIdentity) return cachedIdentity;

  const privHex = SecureStore.getItem(PRIVATE_KEY_STORAGE_KEY);
  if (!privHex) {
    throw new Error('No identity — onboarding has not run');
  }

  const privateKey = hexToBytes(privHex);
  const crypto = initAppCrypto(privateKey);
  const publicKey = crypto.getPublicKey();
  const fingerprint = crypto.getFingerprint();
  const deviceId = bytesToHex(fingerprint);

  getDB();
  const existing = getIdentity();
  if (!existing) {
    // DB was wiped (e.g. Phase 2 migration) but the private key persisted in
    // secure store. We can't reconstruct the display name — the caller must
    // re-run onboarding. Treat this as "no identity".
    throw new Error('No identity — onboarding has not run');
  }

  cachedIdentity = {
    deviceId,
    displayName: existing.displayName,
    createdAt: existing.createdAt,
    publicKey,
  };
  return cachedIdentity;
}

/**
 * Mint a new identity. Called only from the onboarding screen. Generates a
 * long-term X25519 keypair, stores the private key in `expo-secure-store`
 * (never SQLite), and saves the fingerprint + display name to the DB.
 *
 * If a private key already exists in secure store (e.g. DB was wiped by a
 * migration but the key survived), it is reused so the user keeps their
 * cryptographic identity across DB resets.
 */
export function createIdentity(): Identity {
  let privateKey: Uint8Array;
  const existingPrivHex = SecureStore.getItem(PRIVATE_KEY_STORAGE_KEY);
  if (existingPrivHex && hexToBytes(existingPrivHex).length === PUBLIC_KEY_SIZE) {
    // Reuse the existing keypair (DB wiped but key persisted).
    privateKey = hexToBytes(existingPrivHex);
  } else {
    // Generate a fresh X25519 keypair. `x25519.utils.randomSecretKey` pulls
    // from `globalThis.crypto` (the expo-crypto polyfill on RN / native
    // `crypto` in tests).
    // Imported lazily so the polyfill is in place before key generation.
    const { x25519 } = require('@noble/curves/ed25519.js');
    privateKey = x25519.utils.randomSecretKey();
    SecureStore.setItem(PRIVATE_KEY_STORAGE_KEY, bytesToHex(privateKey));
  }

  const crypto = initAppCrypto(privateKey);
  const publicKey = crypto.getPublicKey();
  const fingerprint = crypto.getFingerprint();
  const deviceId = bytesToHex(fingerprint);

  const identity: Identity = {
    deviceId,
    displayName: `anon_${bytesToHex(crypto.getPublicKey().slice(0, 3))}`,
    createdAt: Date.now(),
    publicKey,
  };
  saveIdentity(identity);
  cachedIdentity = identity;
  return identity;
}

/** The node's fingerprint (16 hex chars) — replaces the old UUID deviceId. */
export function getDeviceId(): string {
  return ensureIdentity().deviceId;
}

export function getDisplayName(): string {
  return ensureIdentity().displayName;
}

/**
 * Update the display name in the DB and refresh the in-memory cache.
 * The fingerprint (deviceId) is immutable — only the display name changes.
 */
export function updateDisplayName(name: string): void {
  const id = ensureIdentity();
  const updated: Identity = { ...id, displayName: name };
  saveIdentity(updated);
  cachedIdentity = updated;
}

/**
 * Derive a peer's fingerprint (8 bytes) from their public key. Convenience
 * wrapper around the crypto module's standalone function.
 */
export function peerFingerprintFromPubKey(pubKey: Uint8Array): Uint8Array {
  return fingerprintFromPubKey(pubKey);
}

/** Re-export the crypto singleton for modules that only import identity.ts. */
export { getCrypto } from './crypto';
