/**
 * Pure bookkeeping for the typing indicator — no BLE, no DB, no timers.
 *
 * Two independent concerns, both driven by an injected clock so the rules are
 * unit-testable:
 *  - Remote side: a peer is shown as typing for `holdMs` after their last
 *    typing=1 signal; typing=0 or a received message clears it early.
 *  - Local side: our own typing=1 signals are throttled to one per
 *    `sendIntervalMs` per peer, so a fast typist does not flood the mesh.
 *    typing=0 is never throttled and is not tracked here.
 *
 * `messageRouter.ts` owns the timers that announce expiry and the decision to
 * send; this class only answers "is it typing" and "may I send now".
 */

export const TYPING_HOLD_MS = 6_000;
export const TYPING_SEND_INTERVAL_MS = 3_000;

export interface TypingTrackerOptions {
  now?: () => number;
  holdMs?: number;
  sendIntervalMs?: number;
}

export class TypingTracker {
  private readonly now: () => number;
  private readonly holdMs: number;
  private readonly sendIntervalMs: number;
  /** peer fingerprint -> time at which their typing indicator lapses. */
  private readonly remoteExpiry = new Map<string, number>();
  /** peer fingerprint -> time of our last typing=1 send to them. */
  private readonly lastSendAt = new Map<string, number>();

  constructor(opts: TypingTrackerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.holdMs = opts.holdMs ?? TYPING_HOLD_MS;
    this.sendIntervalMs = opts.sendIntervalMs ?? TYPING_SEND_INTERVAL_MS;
  }

  /** Whether `peer` is currently shown as typing. */
  isTyping(peer: string): boolean {
    const until = this.remoteExpiry.get(peer);
    return until !== undefined && this.now() < until;
  }

  /**
   * Record a typing=1 from `peer` (extends the hold window). Returns true when
   * the peer was not already typing, i.e. the visible state just changed.
   */
  markTyping(peer: string): boolean {
    const wasTyping = this.isTyping(peer);
    this.remoteExpiry.set(peer, this.now() + this.holdMs);
    this.pruneExpired();
    return !wasTyping;
  }

  /**
   * Clear `peer`'s typing state (typing=0 or a message arrived). Returns true
   * when they were typing a moment ago.
   */
  clearTyping(peer: string): boolean {
    const wasTyping = this.isTyping(peer);
    this.remoteExpiry.delete(peer);
    return wasTyping;
  }

  /**
   * Ask whether a typing=1 may be sent to `peer` now. When it may, the send is
   * recorded so the next one waits out the interval. A clock that moved
   * backwards does not block sending.
   */
  tryAcquireSend(peer: string): boolean {
    const now = this.now();
    const last = this.lastSendAt.get(peer);
    if (last !== undefined && now >= last && now - last < this.sendIntervalMs) {
      return false;
    }
    this.lastSendAt.set(peer, now);
    return true;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [peer, until] of this.remoteExpiry) {
      if (now >= until) this.remoteExpiry.delete(peer);
    }
  }
}
