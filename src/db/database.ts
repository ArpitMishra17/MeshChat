import * as SQLite from 'expo-sqlite';
import type { Identity, Peer, Conversation, Message, MessageStatus, OutboxEntry } from '../types';
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

  db.execSync(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.execSync(`
    CREATE TABLE IF NOT EXISTS outbox (
      message_id TEXT PRIMARY KEY,
      dst_fingerprint TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );
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
 *
 * v4 (Phase 4) adds the `settings` table (key-value) for the GPS toggle and
 * future app preferences. Additive CREATE TABLE; no data migration needed.
 *
 * v5 (Phase 5) adds the `outbox` table for store-and-forward retries. Additive
 * CREATE TABLE; no data migration needed (existing `sending`/`failed` rows
 * simply have no outbox entry until the router queues them).
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

  if (version < 4) {
    // Phase 4 — key-value settings store (GPS toggle, future preferences).
    // CREATE TABLE IF NOT EXISTS in initSchema also covers fresh installs.
    db.execSync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    version = 4;
  }

  if (version < 5) {
    // Phase 5 — store-and-forward outbox. CREATE TABLE IF NOT EXISTS in
    // initSchema also covers fresh installs.
    db.execSync(`
      CREATE TABLE IF NOT EXISTS outbox (
        message_id TEXT PRIMARY KEY,
        dst_fingerprint TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(id)
      )
    `);
    version = 5;
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

// --- Settings (Phase 4) ---
//
// Simple key-value store for app preferences. Currently used for the GPS
// toggle (`gps_enabled`); future settings can reuse the same table. Values
// are stored as TEXT — callers (de)serialize booleans/numbers as strings.

export function getSetting(key: string): string | null {
  const rows = db.getAllSync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ? LIMIT 1',
    [key],
  );
  return rows.length > 0 ? rows[0].value : null;
}

export function setSetting(key: string, value: string): void {
  db.runSync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

/** Convenience: read a boolean setting with a default. */
export function getBoolSetting(key: string, defaultValue: boolean): boolean {
  const v = getSetting(key);
  if (v === null) return defaultValue;
  return v === '1';
}

/** Convenience: write a boolean setting as '1'/'0'. */
export function setBoolSetting(key: string, value: boolean): void {
  setSetting(key, value ? '1' : '0');
}

// --- Outbox (Phase 5) ---
//
// Store-and-forward: the *originator* of a message queues it here when no
// route exists yet or a send attempt fails. `messageRouter.ts` owns the
// retry scheduling (backoff, give-up); this module is just the persistence
// layer so the queue survives an app restart (PLAN.md: "outbox lives in
// SQLite, drained on next launch").

function mapOutboxRow(row: any): OutboxEntry {
  return {
    messageId: row.message_id,
    dstFingerprintHex: row.dst_fingerprint,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    text: row.text,
    senderDeviceId: row.sender_device_id,
    conversationId: row.conversation_id,
  };
}

/**
 * Queue (or re-queue, on manual retry) a message for background delivery.
 * `attempts`/`nextRetryAt` are supplied by the caller (messageRouter) so the
 * backoff schedule lives in one place (outbox.ts), not split across the DB
 * layer and the router.
 */
export function enqueueOutbox(
  messageId: string,
  dstFingerprintHex: string,
  attempts: number,
  nextRetryAt: number,
): void {
  db.runSync(
    `INSERT INTO outbox (message_id, dst_fingerprint, attempts, next_retry_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       dst_fingerprint = excluded.dst_fingerprint,
       attempts = excluded.attempts,
       next_retry_at = excluded.next_retry_at`,
    [messageId, dstFingerprintHex, attempts, nextRetryAt, Date.now()],
  );
}

/** Record a failed retry: bump the attempt count and reschedule. */
export function setOutboxAttempt(messageId: string, attempts: number, nextRetryAt: number): void {
  db.runSync(
    'UPDATE outbox SET attempts = ?, next_retry_at = ? WHERE message_id = ?',
    [attempts, nextRetryAt, messageId],
  );
}

/** Remove an entry — on successful send, delivery, or give-up. */
export function removeFromOutbox(messageId: string): void {
  db.runSync('DELETE FROM outbox WHERE message_id = ?', [messageId]);
}

/** Outbox entries whose backoff has elapsed, joined with their message text. */
export function getDueOutboxEntries(now: number): OutboxEntry[] {
  const rows = db.getAllSync<any>(
    `SELECT o.message_id, o.dst_fingerprint, o.attempts, o.next_retry_at, o.created_at,
            m.text, m.sender_device_id, m.conversation_id
     FROM outbox o JOIN messages m ON m.id = o.message_id
     WHERE o.next_retry_at <= ?
     ORDER BY o.created_at ASC`,
    [now],
  );
  return rows.map(mapOutboxRow);
}

/**
 * Every outbox entry regardless of backoff — used when a new link just came
 * up (HELLO), since a fresh route may unblock delivery ahead of schedule.
 */
export function getAllOutboxEntries(): OutboxEntry[] {
  const rows = db.getAllSync<any>(
    `SELECT o.message_id, o.dst_fingerprint, o.attempts, o.next_retry_at, o.created_at,
            m.text, m.sender_device_id, m.conversation_id
     FROM outbox o JOIN messages m ON m.id = o.message_id
     ORDER BY o.created_at ASC`,
  );
  return rows.map(mapOutboxRow);
}

/** Pending-message count per conversation, for the conversation-list badge. */
export function getOutboxCountsByConversation(): Record<string, number> {
  const rows = db.getAllSync<{ conversation_id: string; count: number }>(
    `SELECT m.conversation_id as conversation_id, COUNT(*) as count
     FROM outbox o JOIN messages m ON m.id = o.message_id
     GROUP BY m.conversation_id`,
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.conversation_id] = row.count;
  return out;
}

/**
 * Messages we originated that reached `sent` but never got ACKed within
 * `olderThanMs`, and aren't already in the outbox. This is the watchdog that
 * catches PLAN.md's "kill the relay mid-conversation" case: the send
 * succeeded (radio accepted it) but the destination is now unreachable, so no
 * ACK will ever arrive — the message needs to be requeued for retry.
 */
export function getStuckSentMessages(
  myFingerprintHex: string,
  olderThanMs: number,
): Array<{ id: string; text: string; conversationId: string; dstFingerprintHex: string; createdAt: number }> {
  const cutoff = Date.now() - olderThanMs;
  const rows = db.getAllSync<any>(
    `SELECT m.id, m.text, m.conversation_id, c.peer_device_id as dst_fingerprint, m.created_at
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.sender_device_id = ? AND m.status = 'sent' AND m.created_at < ?
       AND m.id NOT IN (SELECT message_id FROM outbox)`,
    [myFingerprintHex, cutoff],
  );
  return rows.map((row: any) => ({
    id: row.id,
    text: row.text,
    conversationId: row.conversation_id,
    dstFingerprintHex: row.dst_fingerprint,
    createdAt: row.created_at,
  }));
}
