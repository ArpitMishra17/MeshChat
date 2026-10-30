import { TypingTracker, TYPING_HOLD_MS, TYPING_SEND_INTERVAL_MS } from '../src/services/typingTracker';

function clock(start = 10_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

describe('TypingTracker — remote typing state', () => {
  it('uses the spec defaults of 6 s hold and 3 s send interval', () => {
    expect(TYPING_HOLD_MS).toBe(6_000);
    expect(TYPING_SEND_INTERVAL_MS).toBe(3_000);
  });

  it('shows a peer as typing for 6 s after the last typing=1', () => {
    const c = clock();
    const t = new TypingTracker({ now: c.now });
    expect(t.isTyping('p1')).toBe(false);

    expect(t.markTyping('p1')).toBe(true); // state changed
    c.advance(5_999);
    expect(t.isTyping('p1')).toBe(true);
    c.advance(1);
    expect(t.isTyping('p1')).toBe(false);
  });

  it('extends the window when typing=1 arrives again, without reporting a change', () => {
    const c = clock();
    const t = new TypingTracker({ now: c.now });
    t.markTyping('p1');
    c.advance(4_000);
    expect(t.markTyping('p1')).toBe(false); // already typing
    c.advance(5_000); // 9 s after first signal, 5 s after second
    expect(t.isTyping('p1')).toBe(true);
    c.advance(1_000);
    expect(t.isTyping('p1')).toBe(false);
  });

  it('clears immediately on typing=0 and reports whether it was typing', () => {
    const c = clock();
    const t = new TypingTracker({ now: c.now });
    expect(t.clearTyping('p1')).toBe(false);
    t.markTyping('p1');
    expect(t.clearTyping('p1')).toBe(true);
    expect(t.isTyping('p1')).toBe(false);
  });

  it('tracks peers independently', () => {
    const c = clock();
    const t = new TypingTracker({ now: c.now });
    t.markTyping('a');
    c.advance(3_000);
    t.markTyping('b');
    c.advance(3_500);
    expect(t.isTyping('a')).toBe(false);
    expect(t.isTyping('b')).toBe(true);
  });
});

describe('TypingTracker — throttled typing=1 sends', () => {
  it('allows the first send and blocks sends within 3 s of it', () => {
    const c = clock();
    const t = new TypingTracker({ now: c.now });
    expect(t.tryAcquireSend('p1')).toBe(true);
    c.advance(2_999);
    expect(t.tryAcquireSend('p1')).toBe(false);
    c.advance(1);
    expect(t.tryAcquireSend('p1')).toBe(true);
  });

  it('throttles each peer separately', () => {
    const c = clock();
    const t = new TypingTracker({ now: c.now });
    expect(t.tryAcquireSend('p1')).toBe(true);
    expect(t.tryAcquireSend('p2')).toBe(true);
    expect(t.tryAcquireSend('p1')).toBe(false);
  });

  it('does not let a rejected attempt restart the interval', () => {
    const c = clock();
    const t = new TypingTracker({ now: c.now });
    expect(t.tryAcquireSend('p1')).toBe(true);
    c.advance(2_000);
    expect(t.tryAcquireSend('p1')).toBe(false);
    c.advance(1_000); // 3 s after the accepted send
    expect(t.tryAcquireSend('p1')).toBe(true);
  });

  it('does not block when the clock moves backwards', () => {
    const c = clock(10_000);
    const t = new TypingTracker({ now: c.now });
    expect(t.tryAcquireSend('p1')).toBe(true);
    c.set(5_000);
    expect(t.tryAcquireSend('p1')).toBe(true);
  });
});
