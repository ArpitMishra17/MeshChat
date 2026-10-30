/**
 * Pure presentational helpers for photo and voice attachments. These run
 * without native modules, so the attachment components themselves are not
 * rendered here.
 */
import {
  formatDuration,
  progressFraction,
  progressLabel,
  imageBoxSize,
  isTooShortVoice,
  clampVoiceMs,
  IMAGE_BUBBLE_WIDTH,
  IMAGE_BUBBLE_MAX_HEIGHT,
  MIN_VOICE_MS,
} from '../src/components/attachmentFormat';

// Keep any timer-based helpers from outliving the test run (see viz.test.tsx).
beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('formatDuration', () => {
  it('renders m:ss with zero-padded seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(4_999)).toBe('0:04');
    expect(formatDuration(9_000)).toBe('0:09');
    expect(formatDuration(20_000)).toBe('0:20');
    expect(formatDuration(61_000)).toBe('1:01');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  it('treats missing, negative and non-finite input as zero', () => {
    expect(formatDuration(null)).toBe('0:00');
    expect(formatDuration(undefined)).toBe('0:00');
    expect(formatDuration(-500)).toBe('0:00');
    expect(formatDuration(NaN)).toBe('0:00');
    expect(formatDuration(Infinity)).toBe('0:00');
  });
});

describe('progressFraction', () => {
  it('is done/total, clamped to 0..1', () => {
    expect(progressFraction(3, 12)).toBeCloseTo(0.25);
    expect(progressFraction(12, 12)).toBe(1);
    expect(progressFraction(20, 12)).toBe(1);
    expect(progressFraction(-1, 12)).toBe(0);
  });

  it('reads an unknown or zero total as 0 rather than dividing by zero', () => {
    expect(progressFraction(0, 0)).toBe(0);
    expect(progressFraction(3, 0)).toBe(0);
    expect(progressFraction(NaN, 10)).toBe(0);
  });
});

describe('progressLabel', () => {
  it('says receiving for inbound and sending for outbound transfers', () => {
    expect(progressLabel('in', 3, 12)).toBe('receiving 3/12');
    expect(progressLabel('out', 3, 12)).toBe('sending 3/12');
  });

  it('never shows more done than total', () => {
    expect(progressLabel('in', 14, 12)).toBe('receiving 12/12');
  });
});

describe('imageBoxSize', () => {
  it('uses the bubble width and keeps the aspect ratio for landscape images', () => {
    const box = imageBoxSize(640, 480);
    expect(box.width).toBe(IMAGE_BUBBLE_WIDTH);
    expect(box.height).toBe(Math.round(IMAGE_BUBBLE_WIDTH * 0.75));
  });

  it('caps the height on tall portrait images and keeps the ratio', () => {
    const box = imageBoxSize(480, 1200);
    expect(box.height).toBe(IMAGE_BUBBLE_MAX_HEIGHT);
    expect(box.width).toBeCloseTo(IMAGE_BUBBLE_MAX_HEIGHT * (480 / 1200), 0);
  });

  it('falls back to 4:3 when dimensions are missing', () => {
    expect(imageBoxSize(undefined, undefined)).toEqual({
      width: IMAGE_BUBBLE_WIDTH,
      height: Math.round(IMAGE_BUBBLE_WIDTH * 0.75),
    });
  });
});

describe('voice length rules', () => {
  it('rejects recordings shorter than the minimum, accepts the minimum itself', () => {
    expect(MIN_VOICE_MS).toBe(700);
    expect(isTooShortVoice(699)).toBe(true);
    expect(isTooShortVoice(0)).toBe(true);
    expect(isTooShortVoice(700)).toBe(false);
    expect(isTooShortVoice(5_000)).toBe(false);
  });

  it('clamps the measured length to the cap and never below zero', () => {
    expect(clampVoiceMs(12_345.6, 20_000)).toBe(12_346);
    expect(clampVoiceMs(25_000, 20_000)).toBe(20_000);
    expect(clampVoiceMs(-10, 20_000)).toBe(0);
  });
});
