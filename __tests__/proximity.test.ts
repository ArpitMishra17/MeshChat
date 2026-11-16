import { rssiToMeters, formatSignalM } from '../src/services/proximity';

describe('rssiToMeters', () => {
  it('is about 1 m at the reference power', () => {
    expect(rssiToMeters(-59)).toBeCloseTo(1, 5);
  });

  it('gives a larger distance as the signal weakens', () => {
    expect(rssiToMeters(-70)).toBeGreaterThan(rssiToMeters(-59));
    expect(rssiToMeters(-85)).toBeGreaterThan(rssiToMeters(-70));
  });

  it('honours a custom reference power and exponent', () => {
    // Same reading, higher path loss exponent -> closer estimate at a weak signal
    expect(rssiToMeters(-80, -59, 3)).toBeLessThan(rssiToMeters(-80, -59, 2));
  });

  it('clamps to 0.1 m at the near end', () => {
    expect(rssiToMeters(-20)).toBe(0.1);
  });

  it('clamps to 100 m at the far end', () => {
    expect(rssiToMeters(-150)).toBe(100);
    expect(rssiToMeters(Number.NaN)).toBe(100);
  });
});

describe('formatSignalM', () => {
  it('rounds to whole metres and never reads below ~1m', () => {
    expect(formatSignalM(3.4)).toBe('~3m');
    expect(formatSignalM(0.2)).toBe('~1m');
  });
});
