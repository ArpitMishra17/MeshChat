import * as SQLite from 'expo-sqlite';
import type { Identity, Peer, Conversation, Message, MessageStatus } from '../types';
import { generateMessageId, generateConversationId } from '../services/ids';

let db: SQLite.SQLiteDatabase;

export function getDB(): SQLite.SQLiteDatabase {
  if (!db) {
    db = SQLite.openDatabaseSync('meshchat.db');
    initSchema();
  }
  return db;
}

/**
 * Phase 2 — schema creation. Tables are created *after* `runMigrations`
 * so a wipe-and-recreate migration (user_version < 2) can DROP the old
 * tables before the new schema is laid down.
 */
function initSchema() {
  runMigrations();

  db.execSync(`
    CREATE TABLE IF NOT EXISTS identity (
      device_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  db.execSync(`
    CREATE TABLE IF NOT EXISTS peers (
      device_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      rssi INTEGER,
      ble_id TEXT,
      public_key TEXT,
      key_pinned INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.execSync(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      peer_device_id TEXT NOT NULL,
      peer_display_name TEXT NOT NULL,
      last_message TEXT,
      last_message_at INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  db.execSync(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_device_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sending',
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      hops INTEGER,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
  `);

  db.execSync(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);
  `);
}

/**
 * Sequential migrations keyed off `PRAGMA user_version`.
 *
 * v2 (Phase 2) is a **wipe-and-recreate**: identity changed from UUID to
 * X25519 fingerprint, so every `device_id` column is now a different format.
 * Pre-release, this is acceptable — PLAN.md explicitly allows it. The
 * private key in `expo-secure-store` survives the wipe, so `createIdentity`
 * reuses it and the user keeps their cryptographic identity.
 *
 * `delivered_at` (the v1 migration) is now baked into the CREATE TABLE for
 * v2+ installs, so the v1 ALTER is no longer needed.
 *
 * v3 (Phase 3) adds the `hops` column to messages — the hop count a message
 * travelled to reach us (`DEFAULT_TTL - header.ttl` on arrival). Additive
 * ALTER for existing v2 installs; baked into CREATE TABLE for fresh installs.
 */
function runMigrations() {
  const versionRow = db.getAllSync<{ user_version: number }>('PRAGMA user_version');
  let version = versionRow[0]?.user_version ?? 0;

  if (version < 2) {
    db.execSync('DROP TABLE IF EXISTS messages');
    db.execSync('DROP TABLE IF EXISTS conversations');
    db.execSync('DROP TABLE IF EXISTS peers');
    db.execSync('DROP TABLE IF EXISTS identity');
    version = 2;
  }

  if (version < 3) {
    // Phase 3 — hop indicator for delivered messages. `hops` is nullable:
    // messages we originate never have a hop count; received messages get
    // the value computed by the relay engine on arrival.
    db.execSync('ALTER TABLE messages ADD COLUMN hops INTEGER');
    version = 3;
  }

  db.runSync(`PRAGMA user_version = ${version}`);
}

// --- Identity ---
//
// Only `device_id` (fingerprint), `display_name`, and `created_at` are
// stored here. The private key lives in `expo-secure-store`; the public
// key is derived from it at runtime and never persisted to SQLite.

export function getIdentity(): Identity | null {
  const rows = db.getAllSync<any>('SELECT * FROM identity LIMIT 1');
  if (rows.length === 0) return null;
  const row = rows[0];
  // publicKey is not stored in SQLite — the caller (identity.ts) fills it in
  // from the keypair. We return a zero-length array as a placeholder; the
  // real value is set by ensureIdentity().
  return {
    deviceId: row.device_id,
    displayName: row.display_name,
    createdAt: row.created_at,
    publicKey: new Uint8Array(0),
  };
}

export function saveIdentity(identity: Identity): void {
  db.runSync(
    'INSERT OR REPLACE INTO identity (device_id, display_name, created_at) VALUES (?, ?, ?)',
    [identity.deviceId, identity.displayName, identity.createdAt],
  );
}

export function updateDisplayName(name: string): void {
  db.runSync('UPDATE identity SET display_name = ?', [name]);
}

// --- Peers ---
//
// Phase 2 — peers are keyed on `device_id` (the fingerprint, 16 hex chars),
// NOT on the display name. This fixes P0.3 for good: renames and MAC
// rotation no longer fork or merge peer rows. `public_key` stores the
// peer's 32-byte X25519 pubkey as 64 hex chars for trust-on-first-use.

export function upsertPeer(peer: Peer): void {
  db.runSync(
    `INSERT INTO peers (device_id, display_name, last_seen, rssi, ble_id, public_key, key_pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       display_name = excluded.display_name,
       last_seen = excluded.last_seen,
       rssi = excluded.rssi,
       ble_id = excluded.ble_id,
       public_key = COALESCE(excluded.public_key, peers.public_key),
       key_pinned = peers.key_pinned`,
    [
      peer.deviceId,
      peer.displayName,
      peer.lastSeen,
      peer.rssi,
      peer.bleId,
      peer.publicKey,
      peer.keyPinned ? 1 : 0,
    ],
  );
}

/**
 * Pin a peer's public key (trust-on-first-use). The first pubkey seen for
 * a fingerprint is pinned; `checkPeerKeyChange` detects a different key
 * on a subsequent connection.
 */
export function pinPeerKey(deviceId: string, publicKey: string): void {
  db.runSync(
    'UPDATE peers SET public_key = ?, key_pinned = 1 WHERE device_id = ?',
    [publicKey, deviceId],
  );
}

/**
 * Check whether the peer's stored public key matches the one just received.
 * Returns:
 *   - 'match'   — keys match (or no key was pinned yet → pin it)
 *   - 'changed' — a different key was pinned previously (TOFU violation)
 *   - 'unknown' — peer not in the DB (first contact)
 */
export function checkPeerKeyChange(deviceId: string, publicKey: string): 'match' | 'changed' | 'unknown' {
  const rows = db.getAllSync<any>(
    'SELECT public_key, key_pinned FROM peers WHERE device_id = ? LIMIT 1',
    [deviceId],
  );
  if (rows.length === 0) return 'unknown';
  const row = rows[0];
  if (!row.public_key || row.key_pinned === 0) {
    // First contact — pin the key.
    pinPeerKey(deviceId, publicKey);
    return 'match';
  }
  return row.public_key === publicKey ? 'match' : 'changed';
}

export function getAllPeers(): Peer[] {
  const rows = db.getAllSync<any>(
    `SELECT * FROM peers ORDER BY last_seen DESC`,
  );
  return rows.map(row => ({
    deviceId: row.device_id,
    displayName: row.display_name,
    lastSeen: row.last_seen,
    rssi: row.rssi,
    bleId: row.ble_id,
    publicKey: row.public_key ?? null,
    keyPinned: row.key_pinned === 1,
  }));
}

/**
 * Phase 3 — Look up a single peer by fingerprint (device_id). Used by the
 * relay engine and ble.ts to recover a peer's stored public key so an
 * end-to-end shared AES key can be re-derived for a peer that isn't currently
 * connected (multi-hop: the destination may be several hops away, but we must
 * have met them before to encrypt to them).
 */
export function getPeerByFingerprint(fingerprintHex: string): Peer | null {
  const rows = db.getAllSync<any>(
    'SELECT * FROM peers WHERE device_id = ? LIMIT 1',
    [fingerprintHex],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    deviceId: row.device_id,
    displayName: row.display_name,
    lastSeen: row.last_seen,
    rssi: row.rssi,
    bleId: row.ble_id,
    publicKey: row.public_key ?? null,
    keyPinned: row.key_pinned === 1,
  };
}

// --- Conversations ---

export function getOrCreateConversation(
  peerDeviceId: string,
  peerDisplayName: string,
): Conversation {
  const rows = db.getAllSync<any>(
    'SELECT * FROM conversations WHERE peer_device_id = ? LIMIT 1',
    [peerDeviceId],
  );
  if (rows.length > 0) {
    const row = rows[0];
    return {
      id: row.id,
      peerDeviceId: row.peer_device_id,
      peerDisplayName: row.peer_display_name,
      lastMessage: row.last_message,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
    };
  }

  const id = generateConversationId();
  const now = Date.now();
  db.runSync(
    'INSERT INTO conversations (id, peer_device_id, peer_display_name, created_at) VALUES (?, ?, ?, ?)',
    [id, peerDeviceId, peerDisplayName, now],
  );
  return {
    id,
    peerDeviceId,
    peerDisplayName,
    lastMessage: null,
    lastMessageAt: null,
    createdAt: now,
  };
}

export function getAllConversations(): Conversation[] {
  const rows = db.getAllSync<any>(
    'SELECT * FROM conversations ORDER BY last_message_at DESC, created_at DESC',
  );
  return rows.map(row => ({
    id: row.id,
    peerDeviceId: row.peer_device_id,
    peerDisplayName: row.peer_display_name,
    lastMessage: row.last_message,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
  }));
}

function updateConversationLastMessage(
  conversationId: string,
  text: string,
  timestamp: number,
): void {
  db.runSync(
    'UPDATE conversations SET last_message = ?, last_message_at = ? WHERE id = ?',
    [text, timestamp, conversationId],
  );
}

// --- Messages ---

export function insertMessage(
  conversationId: string,
  senderDeviceId: string,
  text: string,
  status: MessageStatus = 'sending',
  messageId?: string,
  hops: number | null = null,
): Message {
  const id = messageId || generateMessageId();
  const now = Date.now();
  db.runSync(
    'INSERT OR IGNORE INTO messages (id, conversation_id, sender_device_id, text, status, created_at, hops) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, conversationId, senderDeviceId, text, status, now, hops],
  );
  updateConversationLastMessage(conversationId, text, now);
  return { id, conversationId, senderDeviceId, text, status, createdAt: now, deliveredAt: null, hops };
}

export function updateMessageStatus(messageId: string, status: MessageStatus): void {
  db.runSync('UPDATE messages SET status = ? WHERE id = ?', [status, messageId]);
}

/**
 * P0.5 — Flip a message to `delivered` and stamp the delivery time. Distinct
 * from `updateMessageStatus` so the delivered_at column is only ever written
 * here, alongside the status transition that warrants it.
 */
export function markMessageDelivered(messageId: string): void {
  db.runSync(
    'UPDATE messages SET status = ?, delivered_at = ? WHERE id = ?',
    ['delivered', Date.now(), messageId],
  );
}

export function getMessages(conversationId: string): Message[] {
  const rows = db.getAllSync<any>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId],
  );
  return rows.map(row => ({
    id: row.id,
    conversationId: row.conversation_id,
    senderDeviceId: row.sender_device_id,
    text: row.text,
    status: row.status as MessageStatus,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? null,
    hops: row.hops ?? null,
  }));
}

export function messageExists(messageId: string): boolean {
  const rows = db.getAllSync('SELECT 1 FROM messages WHERE id = ? LIMIT 1', [messageId]);
  return rows.length > 0;
}
