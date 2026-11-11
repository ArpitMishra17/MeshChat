import * as SQLite from 'expo-sqlite';
import type {
  Identity,
  Peer,
  Conversation,
  Message,
  MessageKind,
  MessageStatus,
  MediaMeta,
  OutboxEntry,
  Reaction,
} from '../types';
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
      key_pinned INTEGER NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 0,
      key_warning_at INTEGER
    );
  `);

  db.execSync(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      peer_device_id TEXT NOT NULL,
      peer_display_name TEXT NOT NULL,
      last_message TEXT,
      last_message_at INTEGER,
      created_at INTEGER NOT NULL,
      last_read_at INTEGER
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
      reply_to TEXT,
      read_at INTEGER,
      kind TEXT NOT NULL DEFAULT 'text',
      attachment_uri TEXT,
      attachment_meta TEXT,
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

  db.execSync(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      reactor_device_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, reactor_device_id)
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
 *
 * v6 fixes the receive-side hop convention: old rows stored relay forwards
 * (`0` for direct), while the UI contract is transmissions (`1` for direct).
 * Originated messages remain NULL, so only received-message hop values are
 * incremented.
 *
 * v7 adds `conversations.last_read_at`, the per-thread read marker behind the
 * unread badges. Existing threads are stamped "read now" so upgrading does not
 * flag the whole history as unread.
 *
 * v8 (features batch) adds reply-to, read receipts, media attachments and
 * reactions. `messages` gains `reply_to`, `read_at`, `kind`, `attachment_uri`
 * and `attachment_meta` (JSON of MediaMeta); `kind` is NOT NULL DEFAULT 'text'
 * so existing rows read as plain text and everything else stays NULL. The new
 * `reactions` table is additive. Each ALTER is guarded by PRAGMA table_info so
 * a partially-applied or already-current table is not altered twice.
 *
 * v9 adds `peers.verified` (the user compared safety numbers in person) and
 * `peers.key_warning_at` (when a key-change warning was raised for this peer,
 * cleared once the user verifies). Both default to "not verified, no warning".
 */
function runMigrations() {
  const versionRow = db.getAllSync<{ user_version: number }>('PRAGMA user_version');
  let version = versionRow[0]?.user_version ?? 0;

  if (version < 2) {
    db.execSync('DROP TABLE IF EXISTS messages');
    db.execSync('DROP TABLE IF EXISTS conversations');
    db.execSync('DROP TABLE IF EXISTS peers');
    db.execSync('DROP TABLE IF EXISTS identity');
    // A fresh database has no tables yet; initSchema() creates the current
    // schema immediately after migrations run, so skip ALTER TABLE steps.
    version = 6;
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

  if (version < 6) {
    // Phase 3/6 — convert persisted received-message hop counts from relay
    // forwards (direct = 0) to radio transmissions (direct = 1). NULL values
    // identify messages originated on this device and are left untouched.
    db.execSync('UPDATE messages SET hops = hops + 1 WHERE hops IS NOT NULL');
    version = 6;
  }

  if (version < 7) {
    // A fresh DB has no `conversations` table yet (initSchema creates it with
    // the column already included), so only ALTER when the table exists.
    const cols = db.getAllSync<{ name: string }>('PRAGMA table_info(conversations)');
    if (cols.length > 0 && !cols.some(c => c.name === 'last_read_at')) {
      db.execSync('ALTER TABLE conversations ADD COLUMN last_read_at INTEGER');
      db.runSync('UPDATE conversations SET last_read_at = ?', [Date.now()]);
    }
    version = 7;
  }

  if (version < 8) {
    // Like v7, only ALTER when the table exists; on a fresh DB initSchema
    // creates `messages` with these columns already in place.
    const cols = db.getAllSync<{ name: string }>('PRAGMA table_info(messages)');
    if (cols.length > 0) {
      const has = (name: string) => cols.some(c => c.name === name);
      if (!has('reply_to')) db.execSync('ALTER TABLE messages ADD COLUMN reply_to TEXT');
      if (!has('read_at')) db.execSync('ALTER TABLE messages ADD COLUMN read_at INTEGER');
      if (!has('kind')) db.execSync("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
      if (!has('attachment_uri')) db.execSync('ALTER TABLE messages ADD COLUMN attachment_uri TEXT');
      if (!has('attachment_meta')) db.execSync('ALTER TABLE messages ADD COLUMN attachment_meta TEXT');
    }
    db.execSync(`
      CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT NOT NULL,
        reactor_device_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, reactor_device_id)
      )
    `);
    version = 8;
  }

  if (version < 9) {
    const cols = db.getAllSync<{ name: string }>('PRAGMA table_info(peers)');
    if (cols.length > 0) {
      const has = (name: string) => cols.some(c => c.name === name);
      if (!has('verified')) db.execSync('ALTER TABLE peers ADD COLUMN verified INTEGER NOT NULL DEFAULT 0');
      if (!has('key_warning_at')) db.execSync('ALTER TABLE peers ADD COLUMN key_warning_at INTEGER');
    }
    version = 9;
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

/**
 * Mark a peer as verified (safety numbers compared in person) or not.
 * Verifying also clears any pending key-change warning for that peer.
 */
export function setPeerVerified(deviceId: string, verified: boolean): void {
  db.runSync(
    `UPDATE peers SET verified = ?,
       key_warning_at = CASE WHEN ? = 1 THEN NULL ELSE key_warning_at END
     WHERE device_id = ?`,
    [verified ? 1 : 0, verified ? 1 : 0, deviceId],
  );
}

/**
 * Record a key-change warning for a peer and drop any earlier verification.
 * The warning can fire during the HELLO, before the peer row exists, so this
 * inserts a stub row when needed; the normal upsert fills in the rest.
 */
export function flagPeerKeyWarning(deviceId: string, displayName: string): void {
  const now = Date.now();
  db.runSync(
    `INSERT INTO peers (device_id, display_name, last_seen, key_warning_at, verified)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(device_id) DO UPDATE SET
       key_warning_at = excluded.key_warning_at,
       verified = 0`,
    [deviceId, displayName, now, now],
  );
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
    verified: row.verified === 1,
    keyWarningAt: row.key_warning_at ?? null,
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
    verified: row.verified === 1,
    keyWarningAt: row.key_warning_at ?? null,
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

/** Chat-list preview. Captionless media gets a label so the thread row is not blank. */
function previewFor(text: string, kind: MessageKind): string {
  if (text.length > 0) return text;
  if (kind === 'image') return '📷 Photo';
  if (kind === 'audio') return '🎤 Voice message';
  return text;
}

/**
 * `attachment_meta` is JSON written by us, but a corrupt or hand-edited value
 * must not crash the thread view, so anything that isn't a recognisable
 * MediaMeta collapses to null.
 */
function parseMediaMeta(raw: unknown): MediaMeta | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    if (
      v && typeof v === 'object' &&
      (v.kind === 'image' || v.kind === 'audio') &&
      typeof v.size === 'number' &&
      typeof v.chunks === 'number' &&
      typeof v.mime === 'string'
    ) {
      return v as MediaMeta;
    }
    return null;
  } catch {
    return null;
  }
}

function mapMessageRow(row: any): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderDeviceId: row.sender_device_id,
    text: row.text,
    status: row.status as MessageStatus,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? null,
    hops: row.hops ?? null,
    replyTo: row.reply_to ?? null,
    readAt: row.read_at ?? null,
    kind: (row.kind ?? 'text') as MessageKind,
    attachmentUri: row.attachment_uri ?? null,
    attachmentMeta: parseMediaMeta(row.attachment_meta),
  };
}

export function insertMessageEx(o: {
  conversationId: string;
  senderDeviceId: string;
  text: string;
  status: MessageStatus;
  id?: string;
  hops?: number | null;
  replyTo?: string | null;
  kind?: MessageKind;
  attachmentUri?: string | null;
  attachmentMeta?: MediaMeta | null;
  createdAt?: number;
}): Message {
  const id = o.id || generateMessageId();
  const now = o.createdAt ?? Date.now();
  const hops = o.hops ?? null;
  const replyTo = o.replyTo ?? null;
  const kind: MessageKind = o.kind ?? 'text';
  const attachmentUri = o.attachmentUri ?? null;
  const attachmentMeta = o.attachmentMeta ?? null;
  db.runSync(
    `INSERT OR IGNORE INTO messages
       (id, conversation_id, sender_device_id, text, status, created_at, hops,
        reply_to, kind, attachment_uri, attachment_meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      o.conversationId,
      o.senderDeviceId,
      o.text,
      o.status,
      now,
      hops,
      replyTo,
      kind,
      attachmentUri,
      attachmentMeta ? JSON.stringify(attachmentMeta) : null,
    ],
  );
  updateConversationLastMessage(o.conversationId, previewFor(o.text, kind), now);
  return {
    id,
    conversationId: o.conversationId,
    senderDeviceId: o.senderDeviceId,
    text: o.text,
    status: o.status,
    createdAt: now,
    deliveredAt: null,
    hops,
    replyTo,
    readAt: null,
    kind,
    attachmentUri,
    attachmentMeta,
  };
}

export function insertMessage(
  conversationId: string,
  senderDeviceId: string,
  text: string,
  status: MessageStatus = 'sending',
  messageId?: string,
  hops: number | null = null,
): Message {
  return insertMessageEx({ conversationId, senderDeviceId, text, status, id: messageId, hops });
}

export function getMessageById(id: string): Message | null {
  const rows = db.getAllSync<any>('SELECT * FROM messages WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0 ? mapMessageRow(rows[0]) : null;
}

/**
 * Remove a message everywhere it lives in the DB. The conversation preview is
 * deliberately not recomputed: callers only delete locally and the thread list
 * is refreshed on the next load.
 */
export function deleteMessage(id: string): { attachmentUri: string | null } | null {
  const rows = db.getAllSync<{ attachment_uri: string | null }>(
    'SELECT attachment_uri FROM messages WHERE id = ? LIMIT 1',
    [id],
  );
  if (rows.length === 0) return null;
  db.withTransactionSync(() => {
    db.runSync('DELETE FROM reactions WHERE message_id = ?', [id]);
    db.runSync('DELETE FROM outbox WHERE message_id = ?', [id]);
    db.runSync('DELETE FROM messages WHERE id = ?', [id]);
  });
  return { attachmentUri: rows[0].attachment_uri ?? null };
}

export function setMessageAttachment(id: string, uri: string, meta: MediaMeta): void {
  db.runSync(
    'UPDATE messages SET attachment_uri = ?, attachment_meta = ? WHERE id = ?',
    [uri, JSON.stringify(meta), id],
  );
}

export function updateMessageStatus(messageId: string, status: MessageStatus): void {
  db.runSync('UPDATE messages SET status = ? WHERE id = ?', [status, messageId]);
}

/**
 * Flip a message to `sent` after a transmit, unless its ACK already arrived.
 * A long photo/voice transfer can be ACKed before the send call returns;
 * overwriting `delivered` with `sent` made the watchdog resend it forever.
 */
export function markMessageSent(messageId: string): void {
  db.runSync(
    "UPDATE messages SET status = 'sent' WHERE id = ? AND status != 'delivered'",
    [messageId],
  );
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
  return rows.map(mapMessageRow);
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
    replyTo: row.reply_to ?? null,
    kind: (row.kind ?? 'text') as MessageKind,
    attachmentUri: row.attachment_uri ?? null,
    attachmentMeta: parseMediaMeta(row.attachment_meta),
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
            m.text, m.sender_device_id, m.conversation_id,
            m.reply_to, m.kind, m.attachment_uri, m.attachment_meta
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
            m.text, m.sender_device_id, m.conversation_id,
            m.reply_to, m.kind, m.attachment_uri, m.attachment_meta
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

// --- Conversation read state / summaries ---

/** Stamp a thread as read up to now (clears its unread badge). */
export function markConversationRead(conversationId: string): void {
  db.runSync('UPDATE conversations SET last_read_at = ? WHERE id = ?', [Date.now(), conversationId]);
}

// --- Read receipts (features batch) ---
//
// `read_at` on an incoming row = when we viewed it; on an outgoing row = when
// the peer reported reading it. Distinct from `conversations.last_read_at`,
// which only drives the unread badge.

/**
 * Mark every unread incoming message in the thread as read now. Returns their
 * ids (oldest first) so the caller can send a READ control packet back.
 */
export function markIncomingRead(conversationId: string, myFingerprintHex: string): string[] {
  const rows = db.getAllSync<{ id: string }>(
    `SELECT id FROM messages
     WHERE conversation_id = ? AND sender_device_id != ? AND read_at IS NULL
     ORDER BY created_at ASC`,
    [conversationId, myFingerprintHex],
  );
  if (rows.length === 0) return [];
  db.withTransactionSync(() => {
    db.runSync(
      `UPDATE messages SET read_at = ?
       WHERE conversation_id = ? AND sender_device_id != ? AND read_at IS NULL`,
      [Date.now(), conversationId, myFingerprintHex],
    );
  });
  return rows.map(r => r.id);
}

/**
 * The peer read these messages. Only rows NOT sent by the peer are touched, so
 * a forged or misdirected READ cannot alter incoming rows. A message that
 * reached `sent`/`queued`/`sending` is promoted to `delivered`, since reading
 * implies the bytes arrived; its outbox row (if any) is dropped so the router
 * does not resend it.
 */
export function markOutgoingRead(ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  db.withTransactionSync(() => {
    for (const id of ids) {
      const rows = db.getAllSync<{ id: string }>(
        `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = ? AND m.sender_device_id != c.peer_device_id`,
        [id],
      );
      if (rows.length === 0) continue;
      db.runSync('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL', [now, id]);
      db.runSync(
        `UPDATE messages SET status = 'delivered', delivered_at = ?
         WHERE id = ? AND status IN ('sending', 'sent', 'queued')`,
        [now, id],
      );
      db.runSync('DELETE FROM outbox WHERE message_id = ?', [id]);
    }
  });
}

// --- Reactions (features batch) ---

/** One reaction per (message, reactor): a new emoji replaces the previous one. */
export function upsertReaction(messageId: string, reactorDeviceId: string, emoji: string): void {
  db.runSync(
    `INSERT INTO reactions (message_id, reactor_device_id, emoji, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, reactor_device_id) DO UPDATE SET
       emoji = excluded.emoji,
       created_at = excluded.created_at`,
    [messageId, reactorDeviceId, emoji, Date.now()],
  );
}

export function removeReaction(messageId: string, reactorDeviceId: string): void {
  db.runSync(
    'DELETE FROM reactions WHERE message_id = ? AND reactor_device_id = ?',
    [messageId, reactorDeviceId],
  );
}

/** All reactions on messages in a thread, keyed by message id. */
export function getReactionsForConversation(conversationId: string): Record<string, Reaction[]> {
  const rows = db.getAllSync<any>(
    `SELECT r.message_id, r.reactor_device_id, r.emoji, r.created_at
     FROM reactions r JOIN messages m ON m.id = r.message_id
     WHERE m.conversation_id = ?
     ORDER BY r.created_at ASC`,
    [conversationId],
  );
  const out: Record<string, Reaction[]> = {};
  for (const r of rows) {
    const reaction: Reaction = {
      messageId: r.message_id,
      reactorDeviceId: r.reactor_device_id,
      emoji: r.emoji,
      createdAt: r.created_at,
    };
    (out[r.message_id] ??= []).push(reaction);
  }
  return out;
}

export interface ConversationSummary {
  /** Messages from the peer newer than the thread's read marker. */
  unread: number;
  /** Status of the newest message in the thread, or null if empty. */
  lastStatus: MessageStatus | null;
  /** True if the newest message was sent by us. */
  lastMine: boolean;
  /** Hop count (radio transmissions) of the newest received message, if any. */
  lastHops: number | null;
}

/** Per-conversation unread count, last-message status and last received hop count. */
export function getConversationSummaries(myFingerprintHex: string): Record<string, ConversationSummary> {
  const rows = db.getAllSync<any>(
    `SELECT c.id AS id,
       (SELECT COUNT(*) FROM messages m
          WHERE m.conversation_id = c.id AND m.sender_device_id != ?
            AND m.created_at > COALESCE(c.last_read_at, 0)) AS unread,
       (SELECT m.status FROM messages m WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1) AS last_status,
       (SELECT m.sender_device_id FROM messages m WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
       (SELECT m.hops FROM messages m WHERE m.conversation_id = c.id AND m.hops IS NOT NULL
          ORDER BY m.created_at DESC LIMIT 1) AS last_hops
     FROM conversations c`,
    [myFingerprintHex],
  );
  const out: Record<string, ConversationSummary> = {};
  for (const r of rows) {
    out[r.id] = {
      unread: r.unread ?? 0,
      lastStatus: (r.last_status as MessageStatus | null) ?? null,
      lastMine: r.last_sender === myFingerprintHex,
      lastHops: r.last_hops ?? null,
    };
  }
  return out;
}

/** Total unread messages across all conversations, using the same rule as getConversationSummaries. */
export function getTotalUnread(myFingerprintHex: string): number {
  const rows = db.getAllSync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.sender_device_id != ?
        AND m.created_at > COALESCE(c.last_read_at, 0)`,
    [myFingerprintHex],
  );
  return rows[0]?.n ?? 0;
}

// --- Telemetry helpers ---

/** Number of messages currently waiting in the outbox. */
export function getOutboxCount(): number {
  const rows = db.getAllSync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
  return rows[0]?.n ?? 0;
}

/** Row count per local table, for the settings storage panel. */
export function getTableCounts(): { table: string; count: number }[] {
  const tables = ['identity', 'peers', 'conversations', 'messages', 'outbox', 'settings', 'reactions'];
  return tables.map(table => ({
    table,
    // Table names come from the fixed list above, never user input.
    count: db.getAllSync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0,
  }));
}
