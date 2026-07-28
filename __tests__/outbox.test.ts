/**
 * Phase 5 unit tests for the outbox scheduling helpers.
 *
 * `backoffDelayMs`/`shouldGiveUp` are pure — no BLE, no DB — so they run
 * under a plain node Jest environment, mirroring how relay.test.ts covers
 * the flooding decision. This is where the retry math's correctness lives:
 * a wrong give-up threshold either abandons a deliverable message early or
 * retries forever; a wrong backoff either hammers the radio or stalls
 * delivery.
 */

import {
  backoffDelayMs,
  shouldGiveUp,
  OUTBOX_BASE_DELAY_MS,
  OUTBOX_MAX_DELAY_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_AGE_MS,
} from '../src/services/outbox';

describe('backoffDelayMs', () => {
  it('starts at the base delay on the first attempt (PLAN.md: 30 s)', () => {
    expect(backoffDelayMs(1)).toBe(OUTBOX_BASE_DELAY_MS);
    expect(backoffDelayMs(1)).toBe(30_000);
  });

  it('doubles each subsequent attempt (30s, 1m, 2m, 4m, 8m)', () => {
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(120_000);
    expect(backoffDelayMs(4)).toBe(240_000);
    expect(backoffDelayMs(5)).toBe(480_000);
  });

  it('caps at 10 minutes', () => {
    expect(backoffDelayMs(6)).toBe(OUTBOX_MAX_DELAY_MS);
    expect(backoffDelayMs(50)).toBe(OUTBOX_MAX_DELAY_MS);
  });

  it('treats 0/negative attempts the same as the first attempt (defensive)', () => {
    expect(backoffDelayMs(0)).toBe(OUTBOX_BASE_DELAY_MS);
    expect(backoffDelayMs(-3)).toBe(OUTBOX_BASE_DELAY_MS);
  });
});

describe('shouldGiveUp', () => {
  const now = 1_700_000_000_000;

  it('does not give up on a fresh, low-attempt entry', () => {
    expect(shouldGiveUp(1, now, now)).toBe(false);
  });

  it('gives up once the attempt cap is reached', () => {
    expect(shouldGiveUp(OUTBOX_MAX_ATTEMPTS - 1, now, now)).toBe(false);
    expect(shouldGiveUp(OUTBOX_MAX_ATTEMPTS, now, now)).toBe(true);
  });

  it('gives up once the entry is older than the max age, regardless of attempts', () => {
    const justUnder = now - (OUTBOX_MAX_AGE_MS - 1_000);
    const justOver = now - (OUTBOX_MAX_AGE_MS + 1_000);
    expect(shouldGiveUp(1, justUnder, now)).toBe(false);
    expect(shouldGiveUp(1, justOver, now)).toBe(true);
  });
});
