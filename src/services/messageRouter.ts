import { bleService } from './ble';
import type { AckPayload, MessagePayload } from '../types';
import {
  getOrCreateConversation,
  insertMessage,
  markMessageDelivered,
  messageExists,
} from '../db/database';
import { Emitter } from './events';

/**
 * P0.1 — App-level message router.
 *
 * Previously `bleService.setOnMessageReceived(...)` was a single global
 * callback slot owned by whichever ChatScreen was mounted. A message arriving
 * on any other screen was silently dropped — never persisted, never ACKed.
 * Worse, the handler inserted every incoming message into the currently-open
 * conversation, so a message from B while you were chatting with A landed in
 * A's thread.
 *
 * The router owns the BLE callbacks for the lifetime of the app. It resolves
 * the conversation from the *sender's* identity, persists, and ACKs — always,
 * regardless of which screen is open. Screens subscribe to the emitters to
 * know when to re-query the DB.
 *
 * This service is the natural home for relay / store-and-forward logic in
 * later phases (Phase 3 seen-cache + relay engine, Phase 5 outbox).
 */
class MessageRouter {
  /** Fires when any message is inserted or its status changes. */
  readonly messagesChanged = new Emitter();
  /** Fires when a conversation's last-message preview changes. */
  readonly conversationsChanged = new Emitter();
  /** Fires when the peer table changes (new peer, last-seen bump). */
  readonly peersChanged = new Emitter();

  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    // P0.1 — subscribe to the BLE emitters for the lifetime of the app.
    // The router is the sole writer to the DB for incoming traffic; screens
    // subscribe to *our* emitters (messagesChanged / conversationsChanged)
    // to refresh their views.
    this.unsubscribers.push(
      bleService.messageReceived.subscribe(p => this.handleIncomingMessage(p)),
      bleService.ackReceived.subscribe(p => this.handleIncomingAck(p)),
      bleService.peerDiscovered.subscribe(() => this.peersChanged.emit()),
      bleService.handshakeReceived.subscribe(() => this.peersChanged.emit()),
    );
  }

  private unsubscribers: Array<() => void> = [];

  private handleIncomingMessage(payload: MessagePayload): void {
    // Dedup — a peer (or a relay in Phase 3) may deliver the same message
    // twice. `insertMessage` uses INSERT OR IGNORE on the primary key, but
    // we still need to ACK duplicates so the sender's status flips.
    const alreadySeen = messageExists(payload.id);

    // Resolve the conversation from the SENDER's identity — never from the
    // currently-open chat. Falls back to the sender's display name carried
    // in the payload so an unknown peer's first message creates a usable
    // conversation row without a prior handshake.
    const conversation = getOrCreateConversation(
      payload.senderDeviceId,
      payload.senderDisplayName || payload.senderDeviceId,
    );

    if (!alreadySeen) {
      insertMessage(
        conversation.id,
        payload.senderDeviceId,
        payload.text,
        'delivered',
        payload.id,
      );
      this.messagesChanged.emit();
      this.conversationsChanged.emit();
    }

    // Always ACK — even for duplicates — so the sender can mark delivered.
    void bleService.sendAck(payload.id);
  }

  private handleIncomingAck(payload: AckPayload): void {
    // P0.2 — ids are now fixed-width and match what we stored, so this
    // actually flips the row's status (previously a no-op on a 25-char id).
    markMessageDelivered(payload.messageId);
    this.messagesChanged.emit();
  }
}

export const messageRouter = new MessageRouter();
