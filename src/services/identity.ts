import * as Crypto from 'expo-crypto';
import { getDB, getIdentity, saveIdentity } from '../db/database';
import type { Identity } from '../types';

let cachedIdentity: Identity | null = null;

export function ensureIdentity(): Identity {
  if (cachedIdentity) return cachedIdentity;

  getDB();
  const existing = getIdentity();
  if (existing) {
    cachedIdentity = existing;
    return existing;
  }

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
