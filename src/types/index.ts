/**
 * Phase 2 — `deviceId` is now the node's cryptographic fingerprint:
 * `hex(SHA-256(publicKey)[:8])` (16 hex chars). The private key lives in
 * `expo-secure-store`, never SQLite. `publicKey` is the 32-byte X25519
 * public key, kept in memory (derived from the private key on load).
 */
export interface Identity {
  deviceId: string;
  displayName: string;
  createdAt: number;
  publicKey: Uint8Array;
}

/**
 * Phase 2 — `deviceId` is the peer's fingerprint (16 hex chars), derived
 * from their X25519 public key. `publicKey` stores the peer's 32-byte
 * pubkey as 64 hex chars (for trust-on-first-use pinning). Renames and
 * MAC rotation no longer fork threads because identity is keyed on the
 * fingerprint, not the display name or BLE address.
 */
export interface Peer {
  deviceId: string;
  displayName: string;
  lastSeen: number;
  rssi: number | null;
  bleId: string | null;
  publicKey: string | null;
  keyPinned: boolean;
}

export interface Conversation {
  id: string;
  peerDeviceId: string;
  peerDisplayName: string;
  lastMessage: string | null;
  lastMessageAt: number | null;
  createdAt: number;
}

// P0.5 — Status ladder: sending -> sent (radio accepted) -> delivered (ACK received).
// Phase 5 will add `queued` in front and `failed` is terminal.
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'failed';

export interface Message {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  text: string;
  status: MessageStatus;
  createdAt: number;
  deliveredAt: number | null;
}

/**
 * Phase 2 — HELLO carries the full 32-byte X25519 public key so the
 * receiver can derive the shared secret and fingerprint. `deviceId` is
 * the fingerprint (derived from `publicKey` by the receiver, not sent
 * on the wire).
 */
export interface HandshakePayload {
  type: 'handshake';
  deviceId: string;
  displayName: string;
  publicKey: Uint8Array;
}

export interface MessagePayload {
  type: 'message';
  id: string;
  senderDeviceId: string;
  senderDisplayName: string;
  text: string;
  timestamp: number;
}

export interface AckPayload {
  type: 'ack';
  messageId: string;
}

export type BLEPayload = HandshakePayload | MessagePayload | AckPayload;
