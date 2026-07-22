import { bleService, type IncomingPacket } from './ble';
import { ensureIdentity, getCrypto } from './identity';
import { SeenCache, decideRelay, withTtlDecremented, hopCount } from './relay';
import {
  decodeBody,
  headerToAAD,
  DEFAULT_TTL,
  TYPE_MESSAGE,
  TYPE_ACK,
} from './protocol';
import { bytesToHex, hexToBytes } from './ids';
import type { AckPayload, MessagePayload } from '../types';
import {
  getOrCreateConversation,
  insertMessage,
  markMessageDelivered,
  messageExists,
  getPeerByFingerprint,
} from '../db/database';
import { Emitter } from './events';

/**
 * P0.1 / Phase 3 — App-level message router + relay engine.
 *
 * Owns the BLE incoming-packet callback for the lifetime of the app and makes
 * the mesh's flooding decision for every MESSAGE/ACK that arrives:
 *
 *   1. **Dedup** against the seen-cache (transport-level msgId). A packet
 *      we've already processed is dropped — this is what stops an echo storm
 *      in a fully-meshed topology (A↔B↔C all in range).
 *   2. **Deliver locally** if `dst == myFingerprint`: decrypt (MESSAGE) or
 *      flip delivered status (ACK). For a MESSAGE, ACK back into the mesh
 *      addressed to the original sender so `delivered` works across hops.
 *   3. **Forward** (relay) if `dst` is someone else and TTL > 0: decrement
 *      TTL, re-fragment, broadcast to all neighbors except the arrival link.
 *
 * HELLO is not routed — `ble.ts` consumes it at the link layer. The router
 * never sees HELLO packets (the relay engine returns `ignore` for them, and
 * ble.ts doesn't emit them via `packetReceived` anyway).
 *
 * The router is the sole writer to the message DB for incoming traffic;
 * screens subscribe to *our* emitters to refresh their views.
 */
class MessageRouter {
  /** Fires when any message is inserted or its status changes. */
  readonly messagesChanged = new Emitter();
  /** Fires when a conversation's last-message preview changes. */
  readonly conversationsChanged = new Emitter();
  /** Fires when the peer table changes (new peer, last-seen bump). */
  readonly peersChanged = new Emitter();

  private started = false;
  /** Transport-level flood dedup. In-memory for Phase 3 (persisted best-effort is Phase 5). */
  private seen = new SeenCache();
  private myFingerprintHex = '';
  private unsubscribers: Array<() => void> = [];

  start(): void {
    if (this.started) return;
    this.started = true;
    this.myFingerprintHex = ensureIdentity().deviceId;

    this.unsubscribers.push(
      bleService.packetReceived.subscribe(p => this.handlePacket(p)),
      bleService.peerDiscovered.subscribe(() => this.peersChanged.emit()),
      bleService.handshakeReceived.subscribe(() => this.peersChanged.emit()),
    );
  }

  /**
   * Phase 3 — The relay decision per PLAN.md's flooding algorithm.
   *
   * `decideRelay` is pure (mutates only the seen-cache); this method performs
   * the actual side effects (decrypt, store, ACK, forward) that the decision
   * prescribes. Splitting pure-decision from effect makes the decision logic
   * unit-testable without BLE/DB/crypto.
   */
  private handlePacket(p: IncomingPacket): void {
    const decision = decideRelay(p.header, this.myFingerprintHex, this.seen);
    switch (decision.action) {
      case 'ignore':
        return;
      case 'drop':
        // Duplicate (seen-cache hit) or TTL exhausted. Either way, no work.
        return;
      case 'deliver':
        this.deliverLocally(p);
        return;
      case 'deliver-and-relay':
        // Broadcast: deliver locally AND forward to neighbors.
        this.deliverLocally(p);
        this.forward(p);
        return;
      case 'relay':
        this.forward(p);
        return;
    }
  }

  private deliverLocally(p: IncomingPacket): void {
    if (p.header.type === TYPE_MESSAGE) {
      this.deliverMessage(p);
    } else if (p.header.type === TYPE_ACK) {
      this.deliverAck(p);
    }
  }

  /**
   * Phase 3 — Decrypt and store a MESSAGE addressed to us, then ACK back to
   * the original sender (`header.src`) through the mesh.
   *
   * Decryption uses the sender's shared AES key, derived from their stored
   * public key if it isn't in the in-memory cache (multi-hop: the sender may
   * be a peer we met before but aren't currently linked to). The header (TTL
   * zeroed) is the AAD — a relay that altered src/dst/msgId would fail auth.
   *
   * The hop count (`DEFAULT_TTL - header.ttl`) is recorded so the UI can show
   * "via N relay(s)" — the headline evidence that multi-hop routing worked.
   */
  private deliverMessage(p: IncomingPacket): void {
    const senderFpHex = bytesToHex(p.header.src);

    let plaintext: Uint8Array;
    try {
      this.ensurePeerKey(senderFpHex);
      const aad = headerToAAD(p.headerBytes);
      plaintext = getCrypto().decrypt(p.header.src, p.payloadBytes, aad);
    } catch (e: any) {
      console.warn('[router] decrypt failed:', e?.message ?? e);
      return;
    }

    let msg: MessagePayload;
    try {
      msg = decodeBody(TYPE_MESSAGE, plaintext) as MessagePayload;
    } catch (e: any) {
      console.warn('[router] message body decode failed:', e?.message ?? e);
      return;
    }

    // App-level dedup (INSERT OR IGNORE). The seen-cache already deduped the
    // transport-level packet; this catches the rarer case of the same message
    // arriving via different paths with different packet msgIds (or a Phase 5
    // retry after a restart).
    const alreadySeen = messageExists(msg.id);
    const conversation = getOrCreateConversation(
      msg.senderDeviceId,
      msg.senderDisplayName || msg.senderDeviceId,
    );

    if (!alreadySeen) {
      const hops = hopCount(p.header.ttl, DEFAULT_TTL);
      insertMessage(conversation.id, msg.senderDeviceId, msg.text, 'delivered', msg.id, hops);
      this.messagesChanged.emit();
      this.conversationsChanged.emit();
    }

    // Always ACK — even for duplicates — so the sender's status flips to
    // `delivered`. The ACK is a flooded packet addressed to `header.src`.
    void bleService.sendAck(msg.id, senderFpHex);
  }

  private deliverAck(p: IncomingPacket): void {
    let ack: AckPayload;
    try {
      ack = decodeBody(TYPE_ACK, p.payloadBytes) as AckPayload;
    } catch (e: any) {
      console.warn('[router] ack body decode failed:', e?.message ?? e);
      return;
    }
    // P0.2 — ids are fixed-width and match what we stored, so this flips the
    // row's status (previously a no-op on a truncated id).
    markMessageDelivered(ack.messageId);
    this.messagesChanged.emit();
  }

  /**
   * Phase 3 — Forward a packet to all neighbors except the one it arrived on.
   * Copies the packet bytes, decrements TTL (byte[3]), and re-fragments per
   * outgoing link's MTU. The msgId is preserved, so downstream nodes (and a
   * loop-back) hit the seen-cache and drop the duplicate.
   */
  private forward(p: IncomingPacket): void {
    const forwardBytes = withTtlDecremented(p.packetBytes);
    // Fire-and-forget: the seen-cache already recorded this msgId, so even if
    // the send is slow we won't re-process a looped copy.
    void bleService.broadcastPacket(forwardBytes, p.arrivalTransportKey);
  }

  /**
   * Phase 3 — Recover the per-peer shared AES key for `fingerprintHex` from
   * the stored pubkey if it isn't cached. Needed on the receive side because
   * a multi-hop sender may be a peer we met before but aren't linked to now.
   */
  private ensurePeerKey(fingerprintHex: string): void {
    const fp = hexToBytes(fingerprintHex);
    if (getCrypto().hasPeerKey(fp)) return;
    const peer = getPeerByFingerprint(fingerprintHex);
    if (!peer || !peer.publicKey) {
      throw new Error(`No public key for peer ${fingerprintHex.slice(0, 8)} — cannot decrypt`);
    }
    getCrypto().rememberPeer(hexToBytes(peer.publicKey));
  }
}

export const messageRouter = new MessageRouter();
