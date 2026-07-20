import * as Crypto from 'expo-crypto';
import { getDB, getIdentity, saveIdentity, updateDisplayName as dbUpdateDisplayName } from '../db/database';
import type { Identity } from '../types';

let cachedIdentity: Identity | null = null;

/**
 * Return the current identity, or throw if onboarding hasn't run yet.
 *
 * P0.8 — Previously this auto-created an identity with a random `anon_...`
 * name on first call. That ran from `startPeripheral` and other hot paths,
 * so a launch that bypassed onboarding (e.g. a crash during onboarding)
 * would silently mint a nameless identity. Onboarding is now the only
 * creator — see `createIdentity`.
 */
export function ensureIdentity(): Identity {
  if (cachedIdentity) return cachedIdentity;

  getDB();
  const existing = getIdentity();
  if (!existing) {
    throw new Error('No identity — onboarding has not run');
  }
  cachedIdentity = existing;
  return existing;
}

/**
 * Mint a new identity. Called only from the onboarding screen. Generates a
 * random display name as a placeholder; the user confirms or replaces it
 * before `onComplete` fires.
 */
export function createIdentity(): Identity {
  const identity: Identity = {
    deviceId: Crypto.randomUUID(),
    displayName: `anon_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  };
  saveIdentity(identity);
  cachedIdentity = identity;
  return identity;
}

export function getDeviceId(): string {
  return ensureIdentity().deviceId;
}

export function getDisplayName(): string {
  return ensureIdentity().displayName;
}

/**
 * Update the display name in the DB and refresh the in-memory cache so
 * `ensureIdentity().displayName` reflects the new name immediately (the
 * previous code returned the stale cached name until app restart).
 */
export function updateDisplayName(name: string): void {
  dbUpdateDisplayName(name);
  if (cachedIdentity) {
    cachedIdentity = { ...cachedIdentity, displayName: name };
  }
}
