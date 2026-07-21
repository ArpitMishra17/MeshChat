/**
 * Phase 2 — End-to-end encryption service.
 *
 * X25519 key exchange + AES-256-GCM authenticated encryption. The design
 * follows PLAN.md Phase 2:
 *
 * - **Identity:** long-term X25519 keypair. Private key in `expo-secure-store`,
 *   public key shared via HELLO. Fingerprint = `SHA-256(pubkey)[:8]` — this
 *   replaces the old UUID-based `deviceId` everywhere (peers PK, conversation
 *   key, packet `src`/`dst`).
 * - **Per-peer key:** `ECDH(myPriv, theirPub)` → HKDF-SHA-256 → 32-byte
 *   AES-256 key. Cached in memory keyed by the peer's fingerprint hex.
 * - **Message encryption:** payload = `nonce(12) ‖ AES-256-GCM(key, nonce,
 *   plaintext, aad)`. The packet header (with TTL zeroed — relays decrement
 *   it) is bound as AAD so a relay cannot alter `src`/`dst`/`msgId` without
 *   the ciphertext failing to authenticate.
 * - **Trust model:** trust-on-first-use. The first pubkey seen for a
 *   fingerprint is pinned; a changed key surfaces a warning in the UI.
 *
 * Libraries: `@noble/curves` (X25519), `@noble/ciphers` (AES-GCM),
 * `@noble/hashes` (SHA-256, HKDF) — pure JS, audited, work under Hermes.
 * Randomness comes from the `cryptoPolyfill` shim (expo-crypto native CSPRNG).
 *
 * The `CryptoService` class is constructed with the node's private key. The
 * app singleton is created in `identity.ts` after onboarding; unit tests
 * construct instances directly so two parties (Alice, Bob) can be simulated
 * in one process.
 */

import { x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { bytesToHex, hexToBytes } from './ids';

export const PUBLIC_KEY_SIZE = 32;
export const FINGERPRINT_BYTES = 8;
export const NONCE_SIZE = 12;
export const GCM_TAG_SIZE = 16;

/** HKDF info string — binds the derived key to MeshChat v2. */
const HKDF_INFO = new TextEncoder().encode('meshchat-v2');
/** HKDF salt — empty per RFC 5869 (HKDFSalt = empty → use HashLen zeros). */
const HKDF_SALT = new Uint8Array(0);

/**
 * Derive an 8-byte fingerprint from a 32-byte X25519 public key.
 *
 * `fingerprint = SHA-256(pubkey)[:8]` — the stable node identifier that
 * replaces `deviceId` everywhere. Exported as a standalone function so
 * callers (ble.ts, messageRouter) can derive a peer's fingerprint from
 * the pubkey received in HELLO without constructing a full CryptoService.
 */
export function fingerprintFromPubKey(pubKey: Uint8Array): Uint8Array {
  if (pubKey.length !== PUBLIC_KEY_SIZE) {
    throw new Error(`public key must be ${PUBLIC_KEY_SIZE} bytes, got ${pubKey.length}`);
  }
  return sha256(pubKey).slice(0, FINGERPRINT_BYTES);
}

/** Hex-encoded fingerprint (16 chars) — the format stored in the DB. */
export function fingerprintHexFromPubKey(pubKey: Uint8Array): string {
  return bytesToHex(fingerprintFromPubKey(pubKey));
}

/**
 * Cryptographic identity + per-peer encryption for one node.
 *
 * Constructed with the node's X25519 private key. The public key and
 * fingerprint are derived once and cached. Per-peer shared keys are
 * derived on demand (ECDH + HKDF) and cached by the peer's fingerprint.
 */
export class CryptoService {
  private readonly myPrivateKey: Uint8Array;
  private readonly myPublicKey: Uint8Array;
  private readonly myFingerprint: Uint8Array;
  /** fingerprint hex → derived AES-256 key (32 bytes). */
  private readonly keyCache = new Map<string, Uint8Array>();

  constructor(myPrivateKey: Uint8Array) {
    if (myPrivateKey.length !== PUBLIC_KEY_SIZE) {
      throw new Error(`private key must be ${PUBLIC_KEY_SIZE} bytes, got ${myPrivateKey.length}`);
    }
    this.myPrivateKey = myPrivateKey;
    this.myPublicKey = x25519.getPublicKey(myPrivateKey);
    this.myFingerprint = fingerprintFromPubKey(this.myPublicKey);
  }

  /** The node's 32-byte X25519 public key (shared in HELLO). */
  getPublicKey(): Uint8Array {
    return this.myPublicKey;
  }

  /** The node's 8-byte fingerprint (SHA-256(pubkey)[:8]). */
  getFingerprint(): Uint8Array {
    return this.myFingerprint;
  }

  /** The node's fingerprint as a 16-char hex string (DB format). */
  getFingerprintHex(): string {
    return bytesToHex(this.myFingerprint);
  }

  /**
   * Register a peer's public key: derive the shared AES key (ECDH + HKDF)
   * and cache it by the peer's fingerprint. Returns the 8-byte fingerprint.
   *
   * Called at HELLO time, before any MESSAGE encrypt/decrypt. Safe to call
   * repeatedly for the same peer (the cache is a no-op on hit).
   */
  rememberPeer(theirPubKey: Uint8Array): Uint8Array {
    if (theirPubKey.length !== PUBLIC_KEY_SIZE) {
      throw new Error(`peer public key must be ${PUBLIC_KEY_SIZE} bytes, got ${theirPubKey.length}`);
    }
    const fingerprint = fingerprintFromPubKey(theirPubKey);
    const fpHex = bytesToHex(fingerprint);
    if (!this.keyCache.has(fpHex)) {
      const shared = x25519.getSharedSecret(this.myPrivateKey, theirPubKey);
      const key = hkdf(sha256, shared, HKDF_SALT, HKDF_INFO, 32);
      this.keyCache.set(fpHex, key);
    }
    return fingerprint;
  }

  /** Whether we have a cached shared key for this peer fingerprint. */
  hasPeerKey(fingerprint: Uint8Array): boolean {
    return this.keyCache.has(bytesToHex(fingerprint));
  }

  /**
   * Encrypt plaintext for the peer identified by `fingerprint`.
   *
   * Returns `nonce(12) ‖ ciphertext ‖ tag(16)` — the complete encrypted
   * payload that goes in the MESSAGE packet's body field. The caller must
   * have called `rememberPeer` with the peer's pubkey first.
   *
   * `aad` is the packet header with the TTL byte zeroed (relays decrement
   * TTL, so it is excluded from authentication; everything else — version,
   * type, flags, msgId, src, dst, payloadLen — is bound into the GCM tag).
   */
  encrypt(fingerprint: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
    const key = this.lookupKey(fingerprint);
    const nonce = this.randomNonce();
    const ct = gcm(key, nonce, aad).encrypt(plaintext);
    const out = new Uint8Array(NONCE_SIZE + ct.length);
    out.set(nonce, 0);
    out.set(ct, NONCE_SIZE);
    return out;
  }

  /**
   * Decrypt an encrypted payload from the peer identified by `fingerprint`.
   *
   * `encrypted` = `nonce(12) ‖ ciphertext ‖ tag(16)`. `aad` is the same
   * header-with-ttl-zeroed used on encrypt. Throws if the tag does not
   * verify (tampered header, wrong key, corrupted ciphertext).
   */
  decrypt(fingerprint: Uint8Array, encrypted: Uint8Array, aad: Uint8Array): Uint8Array {
    if (encrypted.length < NONCE_SIZE + GCM_TAG_SIZE) {
      throw new Error(`encrypted payload too short: ${encrypted.length} bytes`);
    }
    const key = this.lookupKey(fingerprint);
    const nonce = encrypted.subarray(0, NONCE_SIZE);
    const ct = encrypted.subarray(NONCE_SIZE);
    return gcm(key, nonce, aad).decrypt(ct);
  }

  private lookupKey(fingerprint: Uint8Array): Uint8Array {
    const fpHex = bytesToHex(fingerprint);
    const key = this.keyCache.get(fpHex);
    if (!key) {
      throw new Error(`no shared key for peer ${fpHex} — call rememberPeer first`);
    }
    return key;
  }

  private randomNonce(): Uint8Array {
    // A 12-byte nonce from the platform CSPRNG (via the crypto polyfill).
    // GCM nonces must be unique per key; a random 96-bit nonce makes
    // collision probability negligible for the message volumes in this app.
    return crypto!.getRandomValues(new Uint8Array(NONCE_SIZE));
  }
}

// --- App-singleton access ------------------------------------------------
//
// The singleton is created in `identity.ts` after the private key is loaded
// from secure store. Other modules import `getCrypto()` instead of
// constructing their own instance.

let appCrypto: CryptoService | null = null;

export function initAppCrypto(privateKey: Uint8Array): CryptoService {
  appCrypto = new CryptoService(privateKey);
  return appCrypto;
}

export function getCrypto(): CryptoService {
  if (!appCrypto) {
    throw new Error('Crypto service not initialized — ensureIdentity() must be called first');
  }
  return appCrypto;
}

/** Test-only: reset the app singleton between tests. */
export function _resetAppCrypto(): void {
  appCrypto = null;
}

/**
 * Test-only: generate a random X25519 private key for constructing
 * independent CryptoService instances in unit tests (e.g. Alice and Bob
 * in the same process). Not used by the app — onboarding uses
 * `createIdentity()` which goes through secure store.
 */
export function generateTestKey(): Uint8Array {
  return x25519.utils.randomSecretKey();
}
