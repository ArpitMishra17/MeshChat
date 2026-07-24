import { bleService, type IncomingPacket } from './ble';
import { ensureIdentity, getCrypto } from './identity';
import { SeenCache, decideRelay, withTtlDecremented, hopCount, isBroadcast } from './relay';
import {
  decodeBody,
  headerToAAD,
  DEFAULT_TTL,
  TYPE_MESSAGE,
  TYPE_ACK,
  TYPE_POSITION,
  FLAG_FLOOD_MODE,
} from './protocol';
import { bytesToHex, hexToBytes } from './ids';
import {
  getLocationTable,
  greedyForwardDecision,
  type NeighborPosition,
  type ForwardDecision,
} from './location';
import { positionProvider } from './position';
import type { AckPayload, MessagePayload, PositionPayload } from '../types';
import {
  getOrCreateConversation,
  insertMessage,
  markMessageDelivered,
  messageExists,
  getPeerByFingerprint,
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
  type: 'MESSAGE' | 'ACK' | 'POSITION';
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

  private started = false;
  /** Transport-level flood dedup. In-memory for Phase 3 (persisted best-effort is Phase 5). */
  private seen = new SeenCache();
  private myFingerprintHex = '';
  private unsubscribers: Array<() => void> = [];
  /** Phase 4 — routing counters for the report. */
  private stats: RouteStats = { greedyForwards: 0, floodForwards: 0, delivered: 0, positionBeaconsRouted: 0 };

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

  /** Phase 4 — cumulative routing counters (for the Nearby screen / report). */
  getRouteStats(): RouteStats {
    return { ...this.stats };
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
        // Duplicate (seen-cache hit) or TTL exhausted. Either way, no work.
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

    this.stats.delivered += 1;
    this.logRoute(p, 'deliver', { hops: hopCount(p.header.ttl, DEFAULT_TTL) });

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
    const typeName =
      p.header.type === TYPE_MESSAGE ? 'MESSAGE' :
      p.header.type === TYPE_ACK ? 'ACK' : 'POSITION';
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
