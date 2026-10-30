import { AppState } from 'react-native';
import { bleService, type IncomingPacket } from './ble';
import { ensureIdentity, getCrypto } from './identity';
import { SeenCache, decideRelay, withTtlDecremented, receivedHopCount, isBroadcast } from './relay';
import {
  decodeBody,
  headerToAAD,
  DEFAULT_TTL,
  TYPE_MESSAGE,
  TYPE_ACK,
  TYPE_POSITION,
  TYPE_CTRL,
  TYPE_MESSAGE_EXT,
  TYPE_MEDIA,
  FLAG_FLOOD_MODE,
  MAX_MEDIA_BYTES,
  MAX_READ_IDS_PER_PACKET,
  MEDIA_CHUNK_BYTES,
} from './protocol';
import { bytesToHex, hexToBytes } from './ids';
import {
  getLocationTable,
  greedyForwardDecision,
  type NeighborPosition,
  type ForwardDecision,
} from './location';
import { positionProvider } from './position';
import { backoffDelayMs, shouldGiveUp, SENT_ACK_TIMEOUT_MS } from './outbox';
import { MediaAssembler, chunkBytes } from './mediaAssembler';
import { saveMediaBytes, readMediaBytes, deleteMediaFile } from './media';
import { TypingTracker, TYPING_HOLD_MS } from './typingTracker';
import type {
  AckPayload,
  ControlPayload,
  MediaChunkPayload,
  MediaMeta,
  MessageKind,
  MessagePayload,
  PositionPayload,
  Message,
  OutboxEntry,
} from '../types';
import {
  getOrCreateConversation,
  getAllConversations,
  insertMessage,
  insertMessageEx,
  getMessageById,
  deleteMessage,
  setMessageAttachment,
  updateMessageStatus,
  markMessageSent,
  markMessageDelivered,
  markIncomingRead,
  markOutgoingRead,
  upsertReaction,
  removeReaction,
  getReactionsForConversation,
  markConversationRead,
  getBoolSetting,
  messageExists,
  getPeerByFingerprint,
  enqueueOutbox,
  setOutboxAttempt,
  removeFromOutbox,
  getDueOutboxEntries,
  getAllOutboxEntries,
  getStuckSentMessages,
} from '../db/database';
import { Emitter, PayloadEmitter } from './events';

/**
 * P0.1 / Phase 3 / Phase 4 — App-level packet router + relay engine.
 *
 * Owns the BLE incoming-packet callback for the lifetime of the app and makes
 * the routing decision for every MESSAGE/ACK/POSITION that arrives:
 *
 *   1. **Dedup** against the seen-cache (transport-level msgId). A packet
 *      we've already processed is dropped — this is what stops an echo storm
 *      in a fully-meshed topology (A↔B↔C all in range).
 *   2. **Deliver locally** if `dst == myFingerprint`: decrypt (MESSAGE), flip
 *      delivered status (ACK), or update the location table (POSITION). For a
 *      MESSAGE, ACK back into the mesh addressed to the original sender so
 *      `delivered` works across hops.
 *   3. **Forward** (relay) if `dst` is someone else and TTL > 0:
 *      - Phase 3: decrement TTL, re-fragment, flood to all neighbors except
 *        the arrival link.
 *      - Phase 4: for unicast packets, try **greedy geographic forwarding**
 *        first — send to the single neighbor closest to the destination.
 *        Fall back to flooding (with FLAG_FLOOD_MODE set) on a local minimum
 *        or unknown destination position. Broadcast packets always flood.
 *
 * HELLO is not routed — `ble.ts` consumes it at the link layer. The router
 * never sees HELLO packets (the relay engine returns `ignore` for them, and
 * ble.ts doesn't emit them via `packetReceived` anyway).
 *
 * The router is the sole writer to the message DB for incoming chat traffic;
 * screens subscribe to *our* emitters to refresh their views. Routing
 * decisions are surfaced via `routingLog` for the demo/report (greedy vs
 * flood, progress meters, packet counts).
 */

/** Phase 4 — one routing decision, for the demo log + report evaluation. */
export interface RouteLogEntry {
  timestamp: number;
  type: 'MESSAGE' | 'MESSAGE_EXT' | 'ACK' | 'POSITION' | 'CTRL' | 'MEDIA';
  msgId: string;           // first 8 hex chars of the 8-byte transport msgId
  strategy: 'greedy' | 'flood' | 'deliver' | 'drop';
  target?: string;         // neighbor fingerprint (greedy) — first 8 hex
  reason?: string;         // flood reason, when strategy = 'flood'
  progressMeters?: number; // greedy progress, when strategy = 'greedy'
  neighborCount: number;   // established neighbors at decision time
  hops?: number;           // hops travelled so far (for delivered packets)
}

/** Phase 4 — cumulative counters for the report's evaluation section. */
export interface RouteStats {
  greedyForwards: number;
  floodForwards: number;
  delivered: number;
  positionBeaconsRouted: number;
  /** Packets dropped by the seen-cache (transport-level duplicates). */
  duplicates: number;
  /** Unicast packets dropped because their hop budget ran out. */
  ttlDrops: number;
}

/** Phase 5 — how often the outbox watchdog/drain tick runs. */
const OUTBOX_TICK_MS = 15_000;

/** Feature batch — how often stale incoming attachment transfers are swept. */
const ASSEMBLER_SWEEP_MS = 30_000;

/** Settings key gating whether we *send* READ receipts (UI toggle writes it). */
export const READ_RECEIPTS_SETTING = 'read_receipts';

/** Whether read receipts are enabled; defaults to on. */
export function readReceiptsEnabled(): boolean {
  return getBoolSetting(READ_RECEIPTS_SETTING, true);
}

/** Matches the MediaAssembler bound; a valid chunk index is always below this. */
const MAX_MEDIA_CHUNKS = 64;

/** Reactions travel as a short emoji string; the wire allows at most 16 UTF-8 bytes. */
const MAX_EMOJI_BYTES = 16;

export interface MediaProgressEvent {
  messageId: string;
  done: number;
  total: number;
  direction: 'in' | 'out';
}

export interface MessageReceivedEvent {
  conversationId: string;
  peerDeviceId: string;
  senderName: string;
  /** Message text; empty for attachment-only messages. */
  preview: string;
  messageId: string;
  kind: MessageKind;
}

/** Descriptor sanity checks applied before any attachment state is created. */
function isValidMediaMeta(m: MediaMeta): boolean {
  if (m.kind !== 'image' && m.kind !== 'audio') return false;
  if (!Number.isInteger(m.size) || m.size < 1 || m.size > MAX_MEDIA_BYTES) return false;
  if (!Number.isInteger(m.chunks) || m.chunks < 1 || m.chunks > MAX_MEDIA_CHUNKS) return false;
  return m.chunks === Math.ceil(m.size / MEDIA_CHUNK_BYTES);
}

function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Phase 4 — maps a wire packet type to the label used in the routing log. */
function routeTypeLabel(type: number): RouteLogEntry['type'] {
  switch (type) {
    case TYPE_MESSAGE: return 'MESSAGE';
    case TYPE_MESSAGE_EXT: return 'MESSAGE_EXT';
    case TYPE_ACK: return 'ACK';
    case TYPE_CTRL: return 'CTRL';
    case TYPE_MEDIA: return 'MEDIA';
    default: return 'POSITION';
  }
}

/** Peer fingerprint that owns a conversation, or null if the conversation is unknown. */
function peerOfConversation(conversationId: string): string | null {
  const conv = getAllConversations().find(c => c.id === conversationId);
  return conv ? conv.peerDeviceId : null;
}

class MessageRouter {
  /** Fires when any message is inserted or its status changes. */
  readonly messagesChanged = new Emitter();
  /** Fires when a conversation's last-message preview changes. */
  readonly conversationsChanged = new Emitter();
  /** Fires when the peer table changes (new peer, last-seen bump). */
  readonly peersChanged = new Emitter();
  /** Phase 4 — fires on every routing decision (greedy/flood/deliver/drop). */
  readonly routingLog = new PayloadEmitter<RouteLogEntry>();
  /** Feature batch — fires when any peer's typing indicator appears, lapses or clears. */
  readonly typingChanged = new Emitter();
  /** Feature batch — attachment transfer progress, both directions. */
  readonly mediaProgress = new PayloadEmitter<MediaProgressEvent>();
  /** Feature batch — fires once per NEW incoming message row (notifications, haptics). */
  readonly messageReceived = new PayloadEmitter<MessageReceivedEvent>();

  private started = false;
  /** Transport-level flood dedup. In-memory for Phase 3 (persisted best-effort is Phase 5). */
  private seen = new SeenCache();
  private myFingerprintHex = '';
  private unsubscribers: Array<() => void> = [];
  /** Phase 4 — routing counters for the report. */
  private stats: RouteStats = {
    greedyForwards: 0, floodForwards: 0, delivered: 0, positionBeaconsRouted: 0, duplicates: 0, ttlDrops: 0,
  };
  /** Phase 5 — periodic outbox drain/watchdog tick. */
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  /** Message ids with a transmit in progress; never start a second one. */
  private inFlight = new Set<string>();
  /** Message id → when its last transmit finished; the ACK watchdog counts from here. */
  private lastTransmitAt = new Map<string, number>();
  /** Guards drainOutbox against overlapping runs (tick + linkUp). */
  private draining = false;
  /** Feature batch — typing state for peers (remote) and throttle for our own signals. */
  private typing = new TypingTracker();
  /** Per-peer timers that emit `typingChanged` when an indicator lapses on its own. */
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Feature batch — reassembly of incoming attachments, keyed by message id. */
  private assembler = new MediaAssembler();
  private assemblerTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.myFingerprintHex = ensureIdentity().deviceId;

    this.unsubscribers.push(
      bleService.packetReceived.subscribe(p => this.handlePacket(p)),
      bleService.peerDiscovered.subscribe(() => this.peersChanged.emit()),
      bleService.handshakeReceived.subscribe(() => this.peersChanged.emit()),
      // Phase 5 — a new link may unblock delivery for queued messages
      // addressed to someone reachable through it, even if it isn't the
      // destination itself (the mesh may relay further).
      bleService.linkUp.subscribe(() => void this.drainOutbox({ onlyDue: false })),
    );

    // Phase 5 — periodic backoff tick (drains due entries + escalates
    // messages stuck in `sent` with no ACK) and an immediate tick to drain
    // whatever persisted from a previous app run.
    this.outboxTimer = setInterval(() => void this.tickOutbox(), OUTBOX_TICK_MS);
    void this.tickOutbox();

    // Feature batch — drop incoming attachment transfers that stopped progressing.
    if (this.assemblerTimer) clearInterval(this.assemblerTimer);
    this.assemblerTimer = setInterval(() => this.assembler.sweep(), ASSEMBLER_SWEEP_MS);

    // Phase 5 — app foreground is a trigger of its own: RN suspends JS
    // timers in the background, so resuming needs its own nudge to catch up
    // on backoff windows that elapsed while backgrounded.
    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') void this.tickOutbox();
    });
    this.unsubscribers.push(() => appStateSub.remove());
  }

  /** Phase 4 — cumulative routing counters (for the Nearby screen / report). */
  getRouteStats(): RouteStats {
    return { ...this.stats };
  }

  /** Seen-cache occupancy + LRU evictions, for the wire inspector. */
  getSeenStats(): { size: number; capacity: number; evictions: number } {
    return { size: this.seen.size, capacity: this.seen.capacity, evictions: this.seen.evictions };
  }

  /**
   * Phase 5 — Originate a chat message. Inserts it as `sending` (instant
   * optimistic UI) and kicks off the send attempt in the background; the
   * caller learns the outcome (sent/queued/delivered) via `messagesChanged`.
   */
  sendMessage(
    conversationId: string,
    dstFingerprintHex: string,
    text: string,
    opts?: { replyTo?: string; media?: { bytes: Uint8Array; meta: MediaMeta } },
  ): Message {
    const replyTo = opts?.replyTo ?? null;
    if (!opts?.media) {
      const msg = replyTo
        ? insertMessageEx({ conversationId, senderDeviceId: this.myFingerprintHex, text, status: 'sending', replyTo })
        : insertMessage(conversationId, this.myFingerprintHex, text, 'sending');
      void this.attemptSend(msg, dstFingerprintHex);
      return msg;
    }

    const { bytes, meta } = opts.media;
    if (!isValidMediaMeta(meta) || meta.size !== bytes.length) {
      throw new Error('sendMessage: attachment descriptor does not match its bytes');
    }
    // The row exists before the file does: attachmentUri stays null (the UI
    // shows a progress overlay) until saveMediaBytes has written the bytes.
    const msg = insertMessageEx({
      conversationId,
      senderDeviceId: this.myFingerprintHex,
      text,
      status: 'sending',
      replyTo,
      kind: meta.kind,
      attachmentMeta: meta,
    });
    void this.stageAndSendMedia(msg, dstFingerprintHex, bytes);
    return msg;
  }

  /**
   * Feature batch — Persist an outgoing attachment's bytes, record the uri on
   * the row, then run the normal send path (EXT packet, then chunks). A save
   * failure cannot be retried from the outbox (there is nothing to read back),
   * so it is terminal.
   */
  private async stageAndSendMedia(msg: Message, dstFingerprintHex: string, bytes: Uint8Array): Promise<void> {
    const meta = msg.attachmentMeta;
    if (!meta) return;
    let uri: string;
    try {
      uri = await saveMediaBytes(msg.id, meta.kind, bytes, meta.mime);
      setMessageAttachment(msg.id, uri, meta);
    } catch (e: any) {
      console.warn('[router] could not store attachment:', e?.message ?? e);
      updateMessageStatus(msg.id, 'failed');
      this.messagesChanged.emit();
      return;
    }
    this.messagesChanged.emit();
    await this.attemptSend({ ...msg, attachmentUri: uri }, dstFingerprintHex);
  }

  /**
   * Feature batch — Build the wire payload for a stored message. Plain rows
   * (no reply, no attachment) produce exactly the object the MESSAGE path has
   * always sent; the optional keys are only added when they carry a value.
   */
  private buildPayload(fields: {
    messageId: string;
    senderDeviceId: string;
    text: string;
    timestamp: number;
    replyTo: string | null;
    media: MediaMeta | null;
  }): MessagePayload {
    const payload: MessagePayload = {
      type: 'message',
      id: fields.messageId,
      senderDeviceId: fields.senderDeviceId,
      senderDisplayName: ensureIdentity().displayName,
      text: fields.text,
      timestamp: fields.timestamp,
    };
    if (fields.replyTo) payload.replyTo = fields.replyTo;
    if (fields.media) payload.media = fields.media;
    return payload;
  }

  /**
   * `transmitMessage` with bookkeeping: marks the id in flight (so the outbox
   * tick cannot start a parallel resend) and records when it finished (so the
   * ACK watchdog measures from the end of a long media transfer, not from
   * when the message was composed).
   */
  private async transmitTracked(
    payload: MessagePayload,
    attachmentUri: string | null,
    dstFingerprintHex: string,
  ): Promise<void> {
    this.inFlight.add(payload.id);
    try {
      await this.transmitMessage(payload, attachmentUri, dstFingerprintHex);
    } finally {
      this.inFlight.delete(payload.id);
      this.lastTransmitAt.set(payload.id, Date.now());
    }
  }

  /**
   * Feature batch — Transmit one message: the MESSAGE / MESSAGE_EXT packet and,
   * for attachments, every MEDIA chunk after it. The attachment is read and
   * validated before anything is sent so a bad file never leaves a dangling
   * EXT behind. Throws on any failure; callers route that to the outbox.
   */
  private async transmitMessage(
    payload: MessagePayload,
    attachmentUri: string | null,
    dstFingerprintHex: string,
  ): Promise<void> {
    let chunks: Uint8Array[] | null = null;
    const media = payload.media;
    if (media) {
      if (!attachmentUri) throw new Error('attachment not stored yet');
      const bytes = await readMediaBytes(attachmentUri);
      if (bytes.length !== media.size) throw new Error('attachment size does not match its descriptor');
      chunks = chunkBytes(bytes);
      if (chunks.length !== media.chunks) throw new Error('attachment chunk count does not match its descriptor');
    }
    const announced = await bleService.sendMessage(payload, dstFingerprintHex);
    // A photo/voice announcement nobody received is useless: fail now so the
    // retry path runs instead of streaming chunks into the void.
    if (media && announced === false) throw new Error('could not send attachment announcement');
    if (chunks && media) {
      const messageId = payload.id;
      await bleService.sendMediaChunks(messageId, dstFingerprintHex, chunks, (done, total) => {
        this.mediaProgress.emit({ messageId, done, total, direction: 'out' });
      });
    }
  }

  /**
   * Phase 5 — Manual tap-to-retry for a `failed` message. Resets any prior
   * backoff state (a manual retry should try immediately, not wait out the
   * schedule that led to the give-up) and re-attempts the send.
   */
  retryMessage(message: Message, dstFingerprintHex: string): void {
    removeFromOutbox(message.id);
    updateMessageStatus(message.id, 'sending');
    this.messagesChanged.emit();
    void this.attemptSend(message, dstFingerprintHex);
  }

  /** Feature batch — whether `peer` is currently typing to us (6 s after their last typing=1). */
  isPeerTyping(peerFingerprintHex: string): boolean {
    return this.typing.isTyping(peerFingerprintHex);
  }

  /**
   * Feature batch — Tell a peer we are typing (`true`) or stopped (`false`).
   * typing=1 is throttled to one per 3 s per peer; typing=0 always goes out.
   * Nothing is sent unless the peer is a currently linked neighbour, and
   * nothing is ever queued or written to the DB.
   */
  notifyTyping(peerFingerprintHex: string, typing: boolean): void {
    try {
      if (!this.isLinked(peerFingerprintHex)) return;
      if (typing && !this.typing.tryAcquireSend(peerFingerprintHex)) return;
      void bleService.sendControl({ type: 'control', sub: 'typing', typing }, peerFingerprintHex);
    } catch (e: any) {
      console.warn('[router] notifyTyping failed:', e?.message ?? e);
    }
  }

  /**
   * Feature batch — The user has looked at a thread. Marks its unread incoming
   * messages as read, tells the peer (READ control, batched, only when the
   * read_receipts setting is on), and clears the unread badge.
   */
  markConversationSeen(conversationId: string, peerFingerprintHex: string): void {
    try {
      const ids = markIncomingRead(conversationId, this.myFingerprintHex);
      if (ids.length > 0 && readReceiptsEnabled()) {
        for (let i = 0; i < ids.length; i += MAX_READ_IDS_PER_PACKET) {
          const batch = ids.slice(i, i + MAX_READ_IDS_PER_PACKET);
          void bleService.sendControl({ type: 'control', sub: 'read', ids: batch }, peerFingerprintHex);
        }
      }
      markConversationRead(conversationId);
      if (ids.length > 0) this.messagesChanged.emit();
      this.conversationsChanged.emit();
    } catch (e: any) {
      console.warn('[router] markConversationSeen failed:', e?.message ?? e);
    }
  }

  /**
   * Feature batch — Set or clear our reaction on a message in the thread with
   * `peerFingerprintHex`. Choosing the emoji we already reacted with removes
   * it. The change is applied locally first and then sent best-effort.
   */
  toggleReaction(messageId: string, peerFingerprintHex: string, emoji: string): void {
    try {
      if (!emoji || utf8ByteLength(emoji) > MAX_EMOJI_BYTES) return;
      const msg = getMessageById(messageId);
      if (!msg || peerOfConversation(msg.conversationId) !== peerFingerprintHex) return;

      const mine = getReactionsForConversation(msg.conversationId)[messageId]
        ?.find(r => r.reactorDeviceId === this.myFingerprintHex);
      const add = !(mine && mine.emoji === emoji);
      if (add) {
        upsertReaction(messageId, this.myFingerprintHex, emoji);
      } else {
        removeReaction(messageId, this.myFingerprintHex);
      }
      this.messagesChanged.emit();
      void bleService.sendControl(
        { type: 'control', sub: 'reaction', messageId, emoji, add },
        peerFingerprintHex,
      );
    } catch (e: any) {
      console.warn('[router] toggleReaction failed:', e?.message ?? e);
    }
  }

  /**
   * Feature batch — Remove a message from this device only (the peer keeps
   * their copy). Also drops its attachment file and any pending outbox row.
   */
  deleteMessageLocal(messageId: string): void {
    try {
      const removed = deleteMessage(messageId);
      if (!removed) return;
      void deleteMediaFile(removed.attachmentUri);
      this.messagesChanged.emit();
      this.conversationsChanged.emit();
    } catch (e: any) {
      console.warn('[router] deleteMessageLocal failed:', e?.message ?? e);
    }
  }

  /** Feature batch — true when `peer` is one of our currently established links. */
  private isLinked(peerFingerprintHex: string): boolean {
    return bleService.getNeighbors().some(n => n.fingerprintHex === peerFingerprintHex);
  }

  /**
   * Phase 5 — Attempt to send a message right now. `sent` on success (the
   * radio accepted it — `delivered` still waits on the ACK); `queued` and
   * handed to the outbox on failure or when there is no route at all yet
   * (PLAN.md: "no route exists" → queued, not failed).
   */
  private async attemptSend(msg: Message, dstFingerprintHex: string): Promise<void> {
    if (bleService.getNeighbors().length === 0) {
      this.enqueueForRetry(msg.id, dstFingerprintHex);
      return;
    }
    const payload = this.buildPayload({
      messageId: msg.id,
      senderDeviceId: msg.senderDeviceId,
      text: msg.text,
      timestamp: msg.createdAt,
      replyTo: msg.replyTo,
      media: msg.attachmentMeta,
    });
    if (this.inFlight.has(msg.id)) return;
    try {
      await this.transmitTracked(payload, msg.attachmentUri, dstFingerprintHex);
      markMessageSent(msg.id);
      this.messagesChanged.emit();
    } catch (e: any) {
      console.warn('[router] send failed, queueing for retry:', e?.message ?? e);
      this.enqueueForRetry(msg.id, dstFingerprintHex);
    }
  }

  private enqueueForRetry(messageId: string, dstFingerprintHex: string): void {
    updateMessageStatus(messageId, 'queued');
    enqueueOutbox(messageId, dstFingerprintHex, 1, Date.now() + backoffDelayMs(1));
    this.messagesChanged.emit();
    this.conversationsChanged.emit();
  }

  /**
   * Phase 5 — One outbox tick: first escalate anything stuck in `sent` with
   * no ACK (the "relay died mid-conversation" case), then drain whatever is
   * now due. Both are no-ops when we have no neighbors at all — there is
   * nowhere to send to yet.
   */
  private async tickOutbox(): Promise<void> {
    this.escalateStuckSent();
    await this.drainOutbox({ onlyDue: true });
  }

  /**
   * Phase 5 — A message can reach `sent` (radio accepted it) and then never
   * get ACKed if the path dies afterward (PLAN.md testing note: kill the
   * relay mid-conversation). Requeue anything that's been silently
   * undelivered for too long so the backoff loop picks it up.
   */
  private escalateStuckSent(): void {
    const now = Date.now();
    const stuck = getStuckSentMessages(this.myFingerprintHex, SENT_ACK_TIMEOUT_MS).filter(m => {
      if (this.inFlight.has(m.id)) return false;
      const sentAt = this.lastTransmitAt.get(m.id);
      return sentAt === undefined || now - sentAt >= SENT_ACK_TIMEOUT_MS;
    });
    if (stuck.length === 0) return;
    for (const m of stuck) {
      this.lastTransmitAt.delete(m.id);
      updateMessageStatus(m.id, 'queued');
      enqueueOutbox(m.id, m.dstFingerprintHex, 0, Date.now());
    }
    this.messagesChanged.emit();
    this.conversationsChanged.emit();
  }

  /**
   * Phase 5 — Retry outbox entries. `onlyDue: true` respects each entry's
   * backoff schedule (the periodic tick); `onlyDue: false` retries everything
   * regardless of schedule (a new link just came up — worth trying early).
   */
  private async drainOutbox(opts: { onlyDue: boolean }): Promise<void> {
    if (bleService.getNeighbors().length === 0) return;
    if (this.draining) return;
    this.draining = true;
    try {
      const now = Date.now();
      const entries = opts.onlyDue ? getDueOutboxEntries(now) : getAllOutboxEntries();
      for (const entry of entries) {
        await this.retryOutboxEntry(entry, now);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Phase 5 — Retry a single outbox entry. On success, flips the message to
   * `sent` and removes the outbox row (delivery still awaits the ACK). On
   * failure, reschedules with exponential backoff, or gives up (`failed`,
   * terminal — the existing tap-to-retry UI affordance takes over) once the
   * attempt/age budget is exhausted.
   */
  private async retryOutboxEntry(entry: OutboxEntry, now: number): Promise<void> {
    const payload = this.buildPayload({
      messageId: entry.messageId,
      senderDeviceId: entry.senderDeviceId,
      text: entry.text,
      timestamp: entry.createdAt,
      replyTo: entry.replyTo,
      media: entry.attachmentMeta,
    });
    if (this.inFlight.has(entry.messageId)) return;
    try {
      await this.transmitTracked(payload, entry.attachmentUri, entry.dstFingerprintHex);
      markMessageSent(entry.messageId);
      removeFromOutbox(entry.messageId);
      this.messagesChanged.emit();
      this.conversationsChanged.emit();
    } catch (e: any) {
      const attempts = entry.attempts + 1;
      if (shouldGiveUp(attempts, entry.createdAt, now)) {
        updateMessageStatus(entry.messageId, 'failed');
        removeFromOutbox(entry.messageId);
      } else {
        setOutboxAttempt(entry.messageId, attempts, now + backoffDelayMs(attempts));
      }
      this.messagesChanged.emit();
      this.conversationsChanged.emit();
    }
  }

  /**
   * Phase 3 / Phase 4 — The relay decision per PLAN.md's flooding + geographic
   * routing algorithm.
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
        // Duplicate (seen-cache hit) or TTL exhausted. No work either way, but
        // count them; only TTL exhaustion is logged (duplicates are routine in
        // a flooded mesh and would drown the routing log).
        if (decision.reason === 'duplicate') {
          this.stats.duplicates += 1;
        } else {
          this.stats.ttlDrops += 1;
          this.logRoute(p, 'drop', { reason: decision.reason });
        }
        return;
      case 'deliver':
        this.deliverLocally(p);
        return;
      case 'deliver-and-relay':
        // Broadcast: deliver locally AND forward to neighbors.
        this.deliverLocally(p);
        void this.forward(p);
        return;
      case 'relay':
        void this.forward(p);
        return;
    }
  }

  private deliverLocally(p: IncomingPacket): void {
    if (p.header.type === TYPE_MESSAGE) {
      this.deliverMessage(p);
    } else if (p.header.type === TYPE_ACK) {
      this.deliverAck(p);
    } else if (p.header.type === TYPE_POSITION) {
      this.deliverPosition(p);
    } else if (p.header.type === TYPE_CTRL) {
      this.deliverControl(p);
    } else if (p.header.type === TYPE_MESSAGE_EXT) {
      this.deliverMessageExt(p);
    } else if (p.header.type === TYPE_MEDIA) {
      this.deliverMedia(p);
    }
  }

  /**
   * Feature batch — Decrypt the body of an encrypted feature packet
   * (CTRL / MESSAGE_EXT / MEDIA). Same AES-GCM + header-AAD scheme as MESSAGE.
   * Returns null (after a warning) when the key is unknown or the tag fails.
   */
  private decryptFrom(p: IncomingPacket): Uint8Array | null {
    try {
      this.ensurePeerKey(bytesToHex(p.header.src));
      const aad = headerToAAD(p.headerBytes);
      return getCrypto().decrypt(p.header.src, p.payloadBytes, aad);
    } catch (e: any) {
      console.warn('[router] decrypt failed:', e?.message ?? e);
      return null;
    }
  }

  /** Feature batch — Typing started or stopped for `peer`, with a timer to announce lapses. */
  private setRemoteTyping(peer: string, typing: boolean): void {
    const changed = typing ? this.typing.markTyping(peer) : this.typing.clearTyping(peer);
    const existing = this.typingTimers.get(peer);
    if (existing) clearTimeout(existing);
    this.typingTimers.delete(peer);
    if (typing) {
      // Re-arm while still inside the window: a timer can fire a little early
      // relative to the tracker's clock, and the lapse must still be announced.
      const lapse = (): void => {
        if (this.typing.isTyping(peer)) {
          this.typingTimers.set(peer, setTimeout(lapse, 250));
          return;
        }
        this.typingTimers.delete(peer);
        this.typingChanged.emit();
      };
      this.typingTimers.set(peer, setTimeout(lapse, TYPING_HOLD_MS));
    }
    if (changed) this.typingChanged.emit();
  }

  /**
   * Feature batch — CTRL packets. The sender is `header.src`, never a body
   * field. Typing never touches the DB; read and reaction only act on
   * messages that belong to a conversation with that peer.
   */
  private deliverControl(p: IncomingPacket): void {
    try {
      const plaintext = this.decryptFrom(p);
      if (!plaintext) return;
      const ctrl = decodeBody(TYPE_CTRL, plaintext) as ControlPayload;
      const src = bytesToHex(p.header.src);
      if (ctrl.sub === 'typing') {
        this.setRemoteTyping(src, ctrl.typing);
      } else if (ctrl.sub === 'read') {
        this.applyRemoteRead(src, ctrl.ids);
      } else if (ctrl.sub === 'reaction') {
        this.applyRemoteReaction(src, ctrl);
      }
    } catch (e: any) {
      console.warn('[router] control packet failed:', e?.message ?? e);
    }
  }

  /** Peer read our messages: only our own rows in their conversation are touched. */
  private applyRemoteRead(src: string, ids: string[]): void {
    const valid: string[] = [];
    for (const id of ids.slice(0, MAX_READ_IDS_PER_PACKET)) {
      const msg = getMessageById(id);
      if (!msg) continue;
      if (msg.senderDeviceId !== this.myFingerprintHex) continue;
      if (peerOfConversation(msg.conversationId) !== src) continue;
      valid.push(id);
    }
    if (valid.length === 0) return;
    markOutgoingRead(valid);
    this.messagesChanged.emit();
    this.conversationsChanged.emit();
  }

  /** Peer reacted (or un-reacted) to a message in their conversation with us. */
  private applyRemoteReaction(src: string, ctrl: Extract<ControlPayload, { sub: 'reaction' }>): void {
    const msg = getMessageById(ctrl.messageId);
    if (!msg || peerOfConversation(msg.conversationId) !== src) return;
    if (ctrl.add) {
      if (!ctrl.emoji || utf8ByteLength(ctrl.emoji) > MAX_EMOJI_BYTES) return;
      upsertReaction(msg.id, src, ctrl.emoji);
    } else {
      removeReaction(msg.id, src);
    }
    this.messagesChanged.emit();
  }

  /**
   * Feature batch — MESSAGE_EXT: a message with reply-to and/or an attachment
   * descriptor. Text-only messages are stored and ACKed like MESSAGE. Messages
   * with media are stored with no file yet; the ACK waits until every chunk has
   * arrived and been saved, so the sender's `delivered` means the photo arrived.
   */
  private deliverMessageExt(p: IncomingPacket): void {
    try {
      const src = bytesToHex(p.header.src);
      const plaintext = this.decryptFrom(p);
      if (!plaintext) return;
      const msg = decodeBody(TYPE_MESSAGE_EXT, plaintext) as MessagePayload;
      // The body's sender field is only trusted when it matches the link-layer
      // source of the authenticated packet.
      if (msg.senderDeviceId !== src) {
        console.warn('[router] MESSAGE_EXT sender mismatch, dropped');
        return;
      }
      if (msg.media && !isValidMediaMeta(msg.media)) {
        console.warn('[router] MESSAGE_EXT attachment descriptor invalid, dropped');
        return;
      }
      this.setRemoteTyping(src, false);

      const existing = getMessageById(msg.id);
      if (existing) {
        // Duplicate of a message we already hold. Either it is complete (ACK
        // again so the sender stops retrying) or its transfer is in flight and
        // must not be restarted, which would discard chunks already received.
        if (existing.senderDeviceId !== src) return;
        if (existing.attachmentUri || !msg.media) {
          void bleService.sendAck(msg.id, src);
        } else if (this.assembler.progress(msg.id) === null) {
          // The transfer was swept before it finished; re-arm it from this EXT.
          this.armIncomingMedia(msg.id, src, msg.media);
        }
        return;
      }

      const conversation = getOrCreateConversation(
        msg.senderDeviceId,
        msg.senderDisplayName || msg.senderDeviceId,
      );
      const hops = receivedHopCount(p.header.ttl, DEFAULT_TTL);
      insertMessageEx({
        conversationId: conversation.id,
        senderDeviceId: src,
        text: msg.text,
        status: 'delivered',
        id: msg.id,
        hops,
        replyTo: msg.replyTo ?? null,
        kind: msg.media ? msg.media.kind : 'text',
        attachmentUri: null,
        attachmentMeta: msg.media ?? null,
      });
      this.messagesChanged.emit();
      this.conversationsChanged.emit();
      this.messageReceived.emit({
        conversationId: conversation.id,
        peerDeviceId: src,
        senderName: msg.senderDisplayName || src,
        preview: msg.text,
        messageId: msg.id,
        kind: msg.media ? msg.media.kind : 'text',
      });
      this.stats.delivered += 1;
      this.logRoute(p, 'deliver', { hops });

      if (!msg.media) {
        void bleService.sendAck(msg.id, src);
      } else {
        this.armIncomingMedia(msg.id, src, msg.media);
      }
    } catch (e: any) {
      console.warn('[router] message_ext failed:', e?.message ?? e);
    }
  }

  /**
   * Feature batch — Register an expected attachment. If chunks that raced ahead
   * of the EXT already complete it, finish right away (expect() reports that).
   */
  private armIncomingMedia(messageId: string, src: string, meta: MediaMeta): void {
    const done = this.assembler.expect(messageId, meta.chunks, meta.size);
    this.mediaProgress.emit({ messageId, done: 0, total: meta.chunks, direction: 'in' });
    if (done && done.done) void this.completeIncomingMedia(messageId, src, meta, done.bytes);
  }

  /**
   * Feature batch — One MEDIA chunk. Chunks for a stored message must come from
   * its sender and are bounded by the descriptor's chunk count. Chunks that
   * arrive before their EXT are held by the assembler until it is announced.
   */
  private deliverMedia(p: IncomingPacket): void {
    try {
      const src = bytesToHex(p.header.src);
      const plaintext = this.decryptFrom(p);
      if (!plaintext) return;
      const chunk = decodeBody(TYPE_MEDIA, plaintext) as MediaChunkPayload;

      const row = getMessageById(chunk.messageId);
      if (row) {
        const meta = row.attachmentMeta;
        if (row.senderDeviceId !== src || row.attachmentUri || !meta) return;
        if (chunk.index >= meta.chunks) return;
      } else if (chunk.index >= MAX_MEDIA_CHUNKS) {
        return;
      }

      const result = this.assembler.addChunk(chunk.messageId, chunk.index, chunk.data);
      if (result.done) {
        if (row && row.attachmentMeta) {
          void this.completeIncomingMedia(chunk.messageId, src, row.attachmentMeta, result.bytes);
        } else {
          // The row was deleted locally while its bytes were in flight. The
          // sender still deserves the ACK: the attachment did arrive.
          void bleService.sendAck(chunk.messageId, src);
        }
        return;
      }
      if (result.total > 0) {
        this.mediaProgress.emit({
          messageId: chunk.messageId,
          done: result.received,
          total: result.total,
          direction: 'in',
        });
      }
    } catch (e: any) {
      console.warn('[router] media chunk failed:', e?.message ?? e);
    }
  }

  /**
   * Feature batch — A fully received attachment: write it to disk, point the
   * row at it, refresh the UI, and only then ACK the sender.
   */
  private async completeIncomingMedia(
    messageId: string,
    src: string,
    meta: MediaMeta,
    bytes: Uint8Array,
  ): Promise<void> {
    try {
      if (!getMessageById(messageId)) {
        void bleService.sendAck(messageId, src);
        return;
      }
      const uri = await saveMediaBytes(messageId, meta.kind, bytes, meta.mime);
      setMessageAttachment(messageId, uri, meta);
      this.mediaProgress.emit({ messageId, done: meta.chunks, total: meta.chunks, direction: 'in' });
      this.messagesChanged.emit();
      void bleService.sendAck(messageId, src);
    } catch (e: any) {
      console.warn('[router] could not store received attachment:', e?.message ?? e);
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
   * The receive-side hop count is recorded so the UI can show "direct" or
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

    // A message from the peer means they are no longer typing.
    this.setRemoteTyping(senderFpHex, false);

    if (!alreadySeen) {
      const hops = receivedHopCount(p.header.ttl, DEFAULT_TTL);
      insertMessage(conversation.id, msg.senderDeviceId, msg.text, 'delivered', msg.id, hops);
      this.messagesChanged.emit();
      this.conversationsChanged.emit();
      this.messageReceived.emit({
        conversationId: conversation.id,
        peerDeviceId: msg.senderDeviceId,
        senderName: msg.senderDisplayName || msg.senderDeviceId,
        preview: msg.text,
        messageId: msg.id,
        kind: 'text',
      });
    }

    this.stats.delivered += 1;
    this.logRoute(p, 'deliver', { hops: receivedHopCount(p.header.ttl, DEFAULT_TTL) });

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
    this.lastTransmitAt.delete(ack.messageId);
    // Phase 5 — defensive: the outbox row is normally already gone by the
    // time an ACK arrives (removed on successful send), but a stale entry
    // here would otherwise retry a message that's already been delivered.
    removeFromOutbox(ack.messageId);
    this.messagesChanged.emit();
    this.conversationsChanged.emit();
  }

  /**
   * Phase 4 — Deliver a POSITION beacon addressed to us (broadcast).
   *
   * Decodes the position body and updates the shared location table keyed by
   * the sender's fingerprint (`header.src`). Arrival time is used for
   * staleness (robust against clock skew). This is how every node learns every
   * other node's GPS fix — the table that the greedy forwarding decision reads.
   */
  private deliverPosition(p: IncomingPacket): void {
    let pos: PositionPayload;
    try {
      pos = decodeBody(TYPE_POSITION, p.payloadBytes) as PositionPayload;
    } catch (e: any) {
      console.warn('[router] position body decode failed:', e?.message ?? e);
      return;
    }
    const senderFpHex = bytesToHex(p.header.src);
    getLocationTable().set(senderFpHex, pos.lat, pos.lon);
    this.stats.positionBeaconsRouted += 1;
    this.peersChanged.emit(); // neighbors' positions may have changed → refresh Nearby
  }

  /**
   * Phase 3 / Phase 4 — Forward a packet toward its destination.
   *
   * - **Broadcast** packets (POSITION, broadcast MESSAGE/ACK): flood to all
   *   neighbors except the arrival link. Positions must propagate to everyone.
   * - **Flood-mode** unicast packets (an upstream relay hit a local minimum):
   *   keep flooding; don't oscillate back to greedy.
   * - **Unicast, greedy mode**: consult the location table + neighbor
   *   positions. Forward to the single neighbor closest to the destination
   *   ("greedy"). On a local minimum / unknown destination, fall back to
   *   flooding and set FLAG_FLOOD_MODE so downstream nodes don't flip back.
   *
   * The msgId is preserved across hops (only TTL + flood-mode bit mutate), so
   * downstream nodes (and a loop-back) hit the seen-cache and drop duplicates.
   */
  private async forward(p: IncomingPacket): Promise<void> {
    const neighbors = bleService.getNeighbors();

    // Broadcast packets always flood (they go to everyone).
    if (isBroadcast(p.header.dst)) {
      this.flood(p, neighbors, undefined);
      return;
    }

    // Unicast — try greedy geographic forwarding (Phase 4).
    const dstHex = bytesToHex(p.header.dst);
    const decision = greedyForwardDecision({
      header: p.header,
      myFingerprintHex: this.myFingerprintHex,
      myPosition: positionProvider.getCurrent(),
      destinationPosition: getLocationTable().get(dstHex),
      neighbors: this.collectNeighborPositions(neighbors),
    });

    if (decision.strategy === 'greedy') {
      await this.forwardGreedy(p, decision, neighbors);
    } else {
      // Fall back to flooding for this packet; set flood-mode so downstream
      // relays don't re-enter greedy and oscillate.
      this.flood(p, neighbors, decision.reason);
    }
  }

  /**
   * Phase 4 — Greedy forward to a single neighbor. Falls back to flooding if
   * the targeted link dropped between the decision and the send (a packet is
   * never lost just because a link vanished mid-forward).
   */
  private async forwardGreedy(
    p: IncomingPacket,
    decision: Extract<ForwardDecision, { strategy: 'greedy' }>,
    neighbors: ReturnType<typeof bleService.getNeighbors>,
  ): Promise<void> {
    const forwardBytes = withTtlDecremented(p.packetBytes);
    const ok = await bleService.sendToNeighbor(decision.targetFingerprintHex, forwardBytes);
    if (ok) {
      this.stats.greedyForwards += 1;
      this.logRoute(p, 'greedy', {
        target: decision.targetFingerprintHex,
        progressMeters: decision.progressMeters,
        neighborCount: neighbors.length,
      });
      return;
    }
    // Link gone — fall back to flood so the packet isn't lost.
    this.flood(p, neighbors, 'link-dropped');
  }

  /**
   * Phase 3 / Phase 4 — Flood a packet to all neighbors except the arrival
   * link. For unicast packets falling back from greedy, set FLAG_FLOOD_MODE.
   */
  private flood(
    p: IncomingPacket,
    neighbors: ReturnType<typeof bleService.getNeighbors>,
    reason: string | undefined,
  ): void {
    const isUnicast = !isBroadcast(p.header.dst);
    // Set flood-mode only when a unicast packet falls back to flooding (so
    // downstream relays keep flooding). Broadcast packets and already-flood-
    // mode packets don't need the bit set (it's already set or irrelevant).
    const setFloodMode = isUnicast && !(p.header.flags & FLAG_FLOOD_MODE);
    const forwardBytes = withTtlDecremented(p.packetBytes, { setFloodMode });
    // Fire-and-forget: the seen-cache already recorded this msgId, so even if
    // the send is slow we won't re-process a looped copy.
    void bleService.broadcastPacket(forwardBytes, p.arrivalTransportKey);
    this.stats.floodForwards += 1;
    this.logRoute(p, 'flood', { reason, neighborCount: neighbors.length });
  }

  /** Phase 4 — Gather the fresh positions of all established neighbors. */
  private collectNeighborPositions(
    neighbors: ReturnType<typeof bleService.getNeighbors>,
  ): NeighborPosition[] {
    const table = getLocationTable();
    const out: NeighborPosition[] = [];
    for (const n of neighbors) {
      const pos = table.get(n.fingerprintHex);
      if (pos) out.push({ fingerprintHex: n.fingerprintHex, position: pos });
    }
    return out;
  }

  /** Phase 4 — Emit a routing-decision log entry + console line for the demo. */
  private logRoute(
    p: IncomingPacket,
    strategy: RouteLogEntry['strategy'],
    extra: { target?: string; reason?: string; progressMeters?: number; neighborCount?: number; hops?: number },
  ): void {
    const msgId = bytesToHex(p.header.msgId).slice(0, 8);
    const typeName = routeTypeLabel(p.header.type);
    const neighborCount = extra.neighborCount ?? bleService.getNeighbors().length;
    const entry: RouteLogEntry = {
      timestamp: Date.now(),
      type: typeName,
      msgId,
      strategy,
      target: extra.target?.slice(0, 8),
      reason: extra.reason,
      progressMeters: extra.progressMeters,
      neighborCount,
      hops: extra.hops,
    };
    this.routingLog.emit(entry);

    // Console line for the report / demo log. Compact and greppable.
    if (strategy === 'greedy') {
      console.log(
        `[route] ${typeName} ${msgId} GREEDY→${entry.target} ` +
          `(progress ${Math.round(entry.progressMeters ?? 0)} m, ${neighborCount} nbrs)`,
      );
    } else if (strategy === 'flood') {
      console.log(
        `[route] ${typeName} ${msgId} FLOOD (${extra.reason ?? 'broadcast'}, ${neighborCount} nbrs)`,
      );
    } else if (strategy === 'drop') {
      console.log(`[route] ${typeName} ${msgId} DROP (${extra.reason ?? 'unknown'})`);
    } else if (strategy === 'deliver') {
      console.log(
        `[route] ${typeName} ${msgId} DELIVER${entry.hops != null ? ` (via ${entry.hops} hop${entry.hops === 1 ? '' : 's'})` : ''}`,
      );
    }
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
