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

function initSchema() {
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
      ble_id TEXT
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
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
  `);

  db.execSync(`
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, created_at);
  `);

  runMigrations();
}

/**
 * Sequential migrations keyed off `PRAGMA user_version`. Pre-release stance:
 * additive ALTERs only. A wipe-and-recreate migration is deferred to Phase 2
 * (when identity changes break the schema wholesale).
 */
function runMigrations() {
  const versionRow = db.getAllSync<{ user_version: number }>('PRAGMA user_version');
  let version = versionRow[0]?.user_version ?? 0;

  // v1: add delivered_at column for the P0.5 status ladder.
  if (version < 1) {
    const cols = db.getAllSync<{ name: string }>('PRAGMA table_info(messages)');
    if (!cols.some(c => c.name === 'delivered_at')) {
      db.execSync('ALTER TABLE messages ADD COLUMN delivered_at INTEGER');
    }
    version = 1;
  }

  db.runSync(`PRAGMA user_version = ${version}`);
}

// --- Identity ---

export function getIdentity(): Identity | null {
  const rows = db.getAllSync<any>('SELECT * FROM identity LIMIT 1');
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    deviceId: row.device_id,
    displayName: row.display_name,
    createdAt: row.created_at,
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

export function upsertPeer(peer: Peer): void {
  // Android rotates BLE MAC addresses, so the same physical device appears
  // with different deviceIds across scans. Deduplicate by display name:
  // if a peer with the same name already exists, update it instead of inserting.
  const existing = db.getAllSync<any>(
    'SELECT device_id FROM peers WHERE display_name = ? AND device_id != ? LIMIT 1',
    [peer.displayName, peer.deviceId],
  );
  if (existing.length > 0) {
    // Update existing record (keep the old device_id row, update its ble_id)
    db.runSync(
      `UPDATE peers SET last_seen = ?, rssi = ?, ble_id = ? WHERE device_id = ?`,
      [peer.lastSeen, peer.rssi, peer.bleId, existing[0].device_id],
    );
    return;
  }

  db.runSync(
    `INSERT INTO peers (device_id, display_name, last_seen, rssi, ble_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       display_name = excluded.display_name,
       last_seen = excluded.last_seen,
       rssi = excluded.rssi,
       ble_id = excluded.ble_id`,
    [peer.deviceId, peer.displayName, peer.lastSeen, peer.rssi, peer.bleId],
  );
}

export function getAllPeers(): Peer[] {
  // Group by display_name, keeping only the most recently seen entry per name
  const rows = db.getAllSync<any>(
    `SELECT p.* FROM peers p
     INNER JOIN (
       SELECT display_name, MAX(last_seen) as max_seen
       FROM peers GROUP BY display_name
     ) latest ON p.display_name = latest.display_name AND p.last_seen = latest.max_seen
     ORDER BY p.last_seen DESC`,
  );
  return rows.map(row => ({
    deviceId: row.device_id,
    displayName: row.display_name,
    lastSeen: row.last_seen,
    rssi: row.rssi,
    bleId: row.ble_id,
  }));
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
): Message {
  const id = messageId || generateMessageId();
  const now = Date.now();
  db.runSync(
    'INSERT OR IGNORE INTO messages (id, conversation_id, sender_device_id, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, conversationId, senderDeviceId, text, status, now],
  );
  updateConversationLastMessage(conversationId, text, now);
  return { id, conversationId, senderDeviceId, text, status, createdAt: now, deliveredAt: null };
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
  }));
}

export function messageExists(messageId: string): boolean {
  const rows = db.getAllSync('SELECT 1 FROM messages WHERE id = ? LIMIT 1', [messageId]);
  return rows.length > 0;
}
