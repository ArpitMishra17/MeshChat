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
  /**
   * Phase 3 — number of network hops the message travelled to reach us.
   * Computed on arrival as `DEFAULT_TTL - header.ttl`. `null` for messages we
   * originated (we don't hop to ourselves). 1 = direct from sender, 2 = via
   * one relay, etc. Surfaced in the UI as "via N relay(s)".
   */
  hops: number | null;
}

/**
 * Phase 2 — HELLO carries the full 32-byte X25519 public key so the
 * receiver can derive the shared secret and fingerprint. `deviceId` is
 * the fingerprint (derived from `publicKey` by the receiver, not sent
 * on the wire).
 *
 * Phase 4 — when the sender has a GPS fix, the position is appended to
 * the HELLO body (signalled by FLAG_HAS_POSITION in the header). The
 * receiver updates its location table immediately on connect, so a
 * neighbor's position is known without waiting for the first POSITION
 * beacon. `null` when GPS is disabled or no fix yet.
 */
export interface HandshakePayload {
  type: 'handshake';
  deviceId: string;
  displayName: string;
  publicKey: Uint8Array;
  position: GeoPosition | null;
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

/**
 * Phase 4 — A geographic coordinate (WGS-84). Latitude/longitude in degrees,
 * truncated to ~3 decimal places (~110 m) before going on the wire for
 * privacy (see position.ts / protocol.ts POSITION body). `timestamp` is the
 * sender's claim of when the fix was taken; the location table uses arrival
 * time for staleness eviction to stay robust against clock skew.
 */
export interface GeoPosition {
  lat: number;
  lon: number;
  timestamp: number;
}

/**
 * Phase 4 — POSITION beacon body. Broadcast (dst = 0x00…00), TTL ~3, sent on
 * HELLO and periodically while moving. Every node that receives it updates
 * its location table with the sender's position keyed by `header.src`.
 *
 * Positions are visible to the mesh — relays must route on them. This is a
 * documented privacy trade-off (PLAN.md Phase 4); users can opt out entirely
 * via the Settings GPS toggle, in which case the node participates as a
 * flooding-only relay and originates no POSITION beacons.
 */
export interface PositionPayload {
  type: 'position';
  lat: number;
  lon: number;
  timestamp: number;
}

export type BLEPayload = HandshakePayload | MessagePayload | AckPayload | PositionPayload;
