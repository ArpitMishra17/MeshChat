/**
 * Phase 2 unit tests for the end-to-end encryption service.
 *
 * Covers the three scenarios from PLAN.md Phase 2 task 7:
 *  - key derivation both directions yields the same key (Alice encrypts,
 *    Bob decrypts, and vice versa)
 *  - tampered header (AAD) fails decryption
 *  - wrong-peer key fails decryption
 *
 * Plus: fingerprint derivation, rememberPeer idempotency, nonce
 * uniqueness, and a full encrypt → frame → fragment → reassemble →
 * decrypt round-trip through the protocol layer.
 */

import {
  CryptoService,
  generateTestKey,
  fingerprintFromPubKey,
  fingerprintHexFromPubKey,
  NONCE_SIZE,
  GCM_TAG_SIZE,
  PUBLIC_KEY_SIZE,
} from '../src/services/crypto';
import {
  buildHeaderBytes,
  headerToAAD,
  encodeRawPacket,
  decodeBLEChunkRaw,
  encodeBody,
  decodeBody,
  TYPE_MESSAGE,
  FLAG_ENCRYPTED,
  DEFAULT_TTL,
  HEADER_SIZE,
  _clearReassemblyBuffers,
} from '../src/services/protocol';
import { bytesToHex, hexToBytes } from '../src/services/ids';
import type { MessagePayload } from '../src/types';

// --- helpers ---

function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// --- fixtures ---

const MSGID = hexToBytes('1122334455667788');

const message: MessagePayload = {
  type: 'message',
  id: 'a1b2c3d4e5f60718',
  senderDeviceId: '0102030405060708',
  senderDisplayName: 'alice',
  text: 'hello world',
  timestamp: 0,
};

beforeEach(() => {
  _clearReassemblyBuffers();
});

// =====================================================================
// Fingerprint derivation
// =====================================================================

describe('fingerprint derivation', () => {
  it('derives a stable 8-byte fingerprint from a 32-byte public key', () => {
    const alice = new CryptoService(generateTestKey());
    const fp = fingerprintFromPubKey(alice.getPublicKey());
    expect(fp.length).toBe(8);
    // Same input → same output (deterministic).
    expect(bytesToHex(fingerprintFromPubKey(alice.getPublicKey()))).toBe(bytesToHex(fp));
  });

  it('fingerprintHexFromPubKey produces 16 hex chars', () => {
    const alice = new CryptoService(generateTestKey());
    const hex = fingerprintHexFromPubKey(alice.getPublicKey());
    expect(hex).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different keys produce different fingerprints', () => {
    const alice = new CryptoService(generateTestKey());
    const bob = new CryptoService(generateTestKey());
    expect(bytesToHex(alice.getFingerprint())).not.toBe(bytesToHex(bob.getFingerprint()));
  });

  it('throws on a public key of the wrong length', () => {
    expect(() => fingerprintFromPubKey(new Uint8Array(31))).toThrow();
  });
});

// =====================================================================
// Shared key derivation (ECDH + HKDF) — both directions match
// =====================================================================

describe('shared key derivation', () => {
  it('Alice and Bob derive the same shared key (both directions)', () => {
    const alice = new CryptoService(generateTestKey());
    const bob = new CryptoService(generateTestKey());

    // Alice remembers Bob's pubkey; Bob remembers Alice's pubkey.
    const bobFp = alice.rememberPeer(bob.getPublicKey());
    const aliceFp = bob.rememberPeer(alice.getPublicKey());

    // The fingerprints match the independently-derived ones.
    expect(bytesToHex(bobFp)).toBe(bytesToHex(bob.getFingerprint()));
    expect(bytesToHex(aliceFp)).toBe(bytesToHex(alice.getFingerprint()));

    // Alice can encrypt a message that Bob decrypts (and vice versa).
    const aad = new Uint8Array([1, 2, 3]);
    const plaintext = new TextEncoder().encode('secret message');

    const encrypted = alice.encrypt(bobFp, plaintext, aad);
    const decrypted = bob.decrypt(aliceFp, encrypted, aad);
    expect(new TextDecoder().decode(decrypted)).toBe('secret message');

    // Reverse direction: Bob encrypts, Alice decrypts.
    const encrypted2 = bob.encrypt(aliceFp, plaintext, aad);
    const decrypted2 = alice.decrypt(bobFp, encrypted2, aad);
    expect(new TextDecoder().decode(decrypted2)).toBe('secret message');
  });

  it('rememberPeer is idempotent (safe to call twice)', () => {
    const alice = new CryptoService(generateTestKey());
    const bob = new CryptoService(generateTestKey());

    const fp1 = alice.rememberPeer(bob.getPublicKey());
    const fp2 = alice.rememberPeer(bob.getPublicKey());
    expect(bytesToHex(fp1)).toBe(bytesToHex(fp2));
    expect(alice.hasPeerKey(fp1)).toBe(true);
  });
});

// =====================================================================
// Encryption / decryption — tampered header fails
// =====================================================================

describe('encryption with header AAD', () => {
  let alice: CryptoService;
  let bob: CryptoService;
  let bobFp: Uint8Array;
  let aliceFp: Uint8Array;

  beforeEach(() => {
    alice = new CryptoService(generateTestKey());
    bob = new CryptoService(generateTestKey());
    bobFp = alice.rememberPeer(bob.getPublicKey());
    aliceFp = bob.rememberPeer(alice.getPublicKey());
  });

  it('encrypts and decrypts with the header as AAD', () => {
    const headerBytes = buildHeaderBytes({
      type: TYPE_MESSAGE,
      flags: FLAG_ENCRYPTED,
      ttl: 5,
      msgId: MSGID,
      src: alice.getFingerprint(),
      dst: bob.getFingerprint(),
      payloadLen: 100,
    });
    const aad = headerToAAD(headerBytes);

    const plaintext = new TextEncoder().encode('hello encrypted world');
    const encrypted = alice.encrypt(bobFp, plaintext, aad);

    // nonce(12) + ciphertext + tag(16)
    expect(encrypted.length).toBe(NONCE_SIZE + plaintext.length + GCM_TAG_SIZE);

    const decrypted = bob.decrypt(aliceFp, encrypted, aad);
    expect(new TextDecoder().decode(decrypted)).toBe('hello encrypted world');
  });

  it('fails when the AAD header is tampered (src changed)', () => {
    const headerBytes = buildHeaderBytes({
      type: TYPE_MESSAGE,
      flags: FLAG_ENCRYPTED,
      ttl: 5,
      msgId: MSGID,
      src: alice.getFingerprint(),
      dst: bob.getFingerprint(),
      payloadLen: 100,
    });
    const aad = headerToAAD(headerBytes);
    const plaintext = new TextEncoder().encode('tamper test');
    const encrypted = alice.encrypt(bobFp, plaintext, aad);

    // Tamper with the src in the AAD — Bob should fail to decrypt.
    const tamperedAAD = new Uint8Array(aad);
    // src starts at byte 12 (version + type + flags + ttl + msgId = 4 + 8 = 12)
    tamperedAAD[12] ^= 0x01;
    expect(() => bob.decrypt(aliceFp, encrypted, tamperedAAD)).toThrow();
  });

  it('fails when the AAD header is tampered (dst changed)', () => {
    const headerBytes = buildHeaderBytes({
      type: TYPE_MESSAGE,
      flags: FLAG_ENCRYPTED,
      ttl: 5,
      msgId: MSGID,
      src: alice.getFingerprint(),
      dst: bob.getFingerprint(),
      payloadLen: 100,
    });
    const aad = headerToAAD(headerBytes);
    const plaintext = new TextEncoder().encode('dst tamper');
    const encrypted = alice.encrypt(bobFp, plaintext, aad);

    const tamperedAAD = new Uint8Array(aad);
    // dst starts at byte 20 (12 + 8 = 20)
    tamperedAAD[20] ^= 0x01;
    expect(() => bob.decrypt(aliceFp, encrypted, tamperedAAD)).toThrow();
  });

  it('succeeds when only the TTL byte differs (TTL excluded from AAD)', () => {
    // Both sides use headerToAAD, which zeroes the TTL byte. So different
    // TTLs (relay decremented it) must not affect decryption.
    const headerAlice = buildHeaderBytes({
      type: TYPE_MESSAGE, flags: FLAG_ENCRYPTED, ttl: 5,
      msgId: MSGID, src: alice.getFingerprint(), dst: bob.getFingerprint(),
      payloadLen: 100,
    });
    const headerBob = buildHeaderBytes({
      type: TYPE_MESSAGE, flags: FLAG_ENCRYPTED, ttl: 3, // different TTL
      msgId: MSGID, src: alice.getFingerprint(), dst: bob.getFingerprint(),
      payloadLen: 100,
    });
    const aadAlice = headerToAAD(headerAlice);
    const aadBob = headerToAAD(headerBob);

    // The AADs should be identical (TTL zeroed in both).
    expect(bytesToHex(aadAlice)).toBe(bytesToHex(aadBob));

    const plaintext = new TextEncoder().encode('ttl-safe');
    const encrypted = alice.encrypt(bobFp, plaintext, aadAlice);
    const decrypted = bob.decrypt(aliceFp, encrypted, aadBob);
    expect(new TextDecoder().decode(decrypted)).toBe('ttl-safe');
  });

  it('fails when the ciphertext is tampered', () => {
    const headerBytes = buildHeaderBytes({
      type: TYPE_MESSAGE, flags: FLAG_ENCRYPTED, ttl: 5,
      msgId: MSGID, src: alice.getFingerprint(), dst: bob.getFingerprint(),
      payloadLen: 100,
    });
    const aad = headerToAAD(headerBytes);
    const plaintext = new TextEncoder().encode('ct tamper');
    const encrypted = new Uint8Array(alice.encrypt(bobFp, plaintext, aad));

    // Flip a bit in the ciphertext (after the nonce).
    encrypted[NONCE_SIZE + 2] ^= 0x01;
    expect(() => bob.decrypt(aliceFp, encrypted, aad)).toThrow();
  });
});

// =====================================================================
// Wrong-peer key fails
// =====================================================================

describe('wrong-peer key', () => {
  it('fails to decrypt with the wrong peer key', () => {
    const alice = new CryptoService(generateTestKey());
    const bob = new CryptoService(generateTestKey());
    const eve = new CryptoService(generateTestKey());

    // Alice encrypts for Bob.
    const bobFp = alice.rememberPeer(bob.getPublicKey());
    const aad = new Uint8Array([1, 2, 3]);
    const plaintext = new TextEncoder().encode('private to bob');
    const encrypted = alice.encrypt(bobFp, plaintext, aad);

    // Eve remembers Alice's pubkey (so she has a shared key with Alice),
    // but it's a DIFFERENT shared key than the Alice-Bob key. Eve cannot
    // decrypt a message encrypted for Bob.
    const aliceFpAtEve = eve.rememberPeer(alice.getPublicKey());
    expect(() => eve.decrypt(aliceFpAtEve, encrypted, aad)).toThrow();

    // Bob (the intended recipient) can decrypt.
    const aliceFpAtBob = bob.rememberPeer(alice.getPublicKey());
    const decrypted = bob.decrypt(aliceFpAtBob, encrypted, aad);
    expect(new TextDecoder().decode(decrypted)).toBe('private to bob');
  });

  it('throws when encrypting for an unknown peer (rememberPeer not called)', () => {
    const alice = new CryptoService(generateTestKey());
    const bob = new CryptoService(generateTestKey());
    // Alice did NOT call rememberPeer(bob) — no shared key cached.
    expect(() => alice.encrypt(bob.getFingerprint(), new Uint8Array(5), new Uint8Array(0))).toThrow();
  });
});

// =====================================================================
// Full round-trip: encrypt → encodeRawPacket → fragment → reassemble → decrypt
// =====================================================================

describe('full encrypted message round-trip through the protocol layer', () => {
  it('encrypts, frames, fragments, reassembles, decrypts, decodes', () => {
    const alice = new CryptoService(generateTestKey());
    const bob = new CryptoService(generateTestKey());

    const bobFp = alice.rememberPeer(bob.getPublicKey());
    const aliceFp = bob.rememberPeer(alice.getPublicKey());

    // Serialize the message body (plaintext).
    const plaintext = encodeBody(message);

    // Compute AAD: header with ttl zeroed.
    const encryptedLen = NONCE_SIZE + plaintext.length + GCM_TAG_SIZE;
    const headerForAAD = buildHeaderBytes({
      type: TYPE_MESSAGE,
      flags: FLAG_ENCRYPTED,
      ttl: DEFAULT_TTL,
      msgId: MSGID,
      src: alice.getFingerprint(),
      dst: bobFp,
      payloadLen: encryptedLen,
    });
    const aad = headerToAAD(headerForAAD);

    // Encrypt.
    const encrypted = alice.encrypt(bobFp, plaintext, aad);

    // Frame as a v2 packet and fragment.
    const fragments = encodeRawPacket(TYPE_MESSAGE, encrypted, {
      src: alice.getFingerprint(),
      dst: bobFp,
      msgId: MSGID,
      ttl: DEFAULT_TTL,
      flags: FLAG_ENCRYPTED,
      mtu: 512,
    });
    expect(fragments.length).toBe(1); // small message, single fragment

    // Reassemble + decode raw packet.
    const raw = decodeBLEChunkRaw(fragments[0], 'rt');
    expect(raw).not.toBeNull();
    expect(raw!.header.type).toBe(TYPE_MESSAGE);
    expect(raw!.header.flags & FLAG_ENCRYPTED).toBe(FLAG_ENCRYPTED);
    expect(bytesToHex(raw!.header.src)).toBe(bytesToHex(alice.getFingerprint()));
    expect(bytesToHex(raw!.header.dst)).toBe(bytesToHex(bobFp));

    // Decrypt.
    const recvAAD = headerToAAD(raw!.headerBytes);
    const decrypted = bob.decrypt(raw!.header.src, raw!.payload, recvAAD);

    // Decode the message body.
    const decoded = decodeBody(raw!.header.type, decrypted) as MessagePayload;
    expect(decoded.type).toBe('message');
    expect(decoded.id).toBe(message.id);
    expect(decoded.text).toBe(message.text);
    expect(decoded.senderDeviceId).toBe(message.senderDeviceId);
    expect(decoded.senderDisplayName).toBe(message.senderDisplayName);
  });

  it('round-trips a large encrypted message across multiple fragments', () => {
    const alice = new CryptoService(generateTestKey());
    const bob = new CryptoService(generateTestKey());

    const bobFp = alice.rememberPeer(bob.getPublicKey());
    bob.rememberPeer(alice.getPublicKey());

    const bigMessage: MessagePayload = { ...message, text: 'x'.repeat(500) };
    const plaintext = encodeBody(bigMessage);

    const encryptedLen = NONCE_SIZE + plaintext.length + GCM_TAG_SIZE;
    const headerForAAD = buildHeaderBytes({
      type: TYPE_MESSAGE, flags: FLAG_ENCRYPTED, ttl: DEFAULT_TTL,
      msgId: MSGID, src: alice.getFingerprint(), dst: bobFp,
      payloadLen: encryptedLen,
    });
    const aad = headerToAAD(headerForAAD);
    const encrypted = alice.encrypt(bobFp, plaintext, aad);

    // MTU 23 → many fragments.
    const fragments = encodeRawPacket(TYPE_MESSAGE, encrypted, {
      src: alice.getFingerprint(), dst: bobFp, msgId: MSGID,
      ttl: DEFAULT_TTL, flags: FLAG_ENCRYPTED, mtu: 23,
    });
    expect(fragments.length).toBeGreaterThan(1);

    // Reassemble.
    let raw: ReturnType<typeof decodeBLEChunkRaw> = null;
    for (const frag of fragments) {
      raw = decodeBLEChunkRaw(frag, 'big');
    }
    expect(raw).not.toBeNull();

    const recvAAD = headerToAAD(raw!.headerBytes);
    const decrypted = bob.decrypt(raw!.header.src, raw!.payload, recvAAD);
    const decoded = decodeBody(raw!.header.type, decrypted) as MessagePayload;
    expect(decoded.text).toBe('x'.repeat(500));
  });
});

// =====================================================================
// headerToAAD and buildHeaderBytes
// =====================================================================

describe('headerToAAD', () => {
  it('zeroes the TTL byte (byte[3]) and copies the rest', () => {
    const header = buildHeaderBytes({
      type: TYPE_MESSAGE, flags: FLAG_ENCRYPTED, ttl: 5,
      msgId: MSGID, src: hexToBytes('0102030405060708'),
      dst: hexToBytes('0807060504030201'), payloadLen: 42,
    });
    expect(header[3]).toBe(5); // original TTL

    const aad = headerToAAD(header);
    expect(aad.length).toBe(HEADER_SIZE);
    expect(aad[3]).toBe(0); // TTL zeroed
    // Original is unmodified.
    expect(header[3]).toBe(5);
    // Everything else matches.
    expect(aad[0]).toBe(header[0]); // version
    expect(aad[1]).toBe(header[1]); // type
    expect(aad[2]).toBe(header[2]); // flags
  });

  it('produces identical AAD for headers differing only in TTL', () => {
    const h1 = buildHeaderBytes({
      type: TYPE_MESSAGE, flags: 0, ttl: 5,
      msgId: MSGID, src: hexToBytes('0102030405060708'),
      dst: hexToBytes('0807060504030201'), payloadLen: 10,
    });
    const h2 = buildHeaderBytes({
      type: TYPE_MESSAGE, flags: 0, ttl: 1,
      msgId: MSGID, src: hexToBytes('0102030405060708'),
      dst: hexToBytes('0807060504030201'), payloadLen: 10,
    });
    expect(bytesToHex(headerToAAD(h1))).toBe(bytesToHex(headerToAAD(h2)));
  });
});
