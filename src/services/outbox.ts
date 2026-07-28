/**
 * Phase 5 — pure scheduling helpers for the store-and-forward outbox.
 *
 * No BLE, no DB — just the backoff/give-up math, mirroring how `relay.ts`
 * keeps the flooding decision testable without hardware. `messageRouter.ts`
 * owns the actual persistence (database.ts) and side effects (bleService).
 *
 * Schedule (PLAN.md Phase 5): 30 s, 1 m, 2 m, 4 m, 8 m, capped at 10 m.
 * Give-up: 50 attempts or 7 days old, whichever comes first — the message
 * then becomes `failed` (terminal, tap-to-retry).
 */

export const OUTBOX_BASE_DELAY_MS = 30_000;
export const OUTBOX_MAX_DELAY_MS = 10 * 60_000;
export const OUTBOX_MAX_ATTEMPTS = 50;
export const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * How long a `sent` message may go without an ACK before the watchdog
 * treats it as undelivered and requeues it for retry (PLAN.md testing note:
 * "kill B mid-conversation ... Phase 5 turns this into queued-and-retried").
 */
export const SENT_ACK_TIMEOUT_MS = 20_000;

/**
 * Delay before the Nth retry, where `attempts` is the number of failed send
 * attempts so far (1 = first failure). Doubles each time, capped.
 */
export function backoffDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(OUTBOX_BASE_DELAY_MS * 2 ** exponent, OUTBOX_MAX_DELAY_MS);
}

/** True if an outbox entry has exhausted its retry budget. */
export function shouldGiveUp(attempts: number, createdAt: number, now: number): boolean {
  return attempts >= OUTBOX_MAX_ATTEMPTS || now - createdAt > OUTBOX_MAX_AGE_MS;
}
