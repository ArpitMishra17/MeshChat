/**
 * Pure presentational helpers for photo and voice attachments. No native
 * imports, so they can be unit-tested directly.
 */
/** Recordings shorter than this are discarded silently (accidental taps). */
export const MIN_VOICE_MS = 700;

/** Longest edge-to-edge width of an image bubble, in dp. */
export const IMAGE_BUBBLE_WIDTH = 220;
/** Cap on bubble height so a tall portrait photo does not dominate the list. */
export const IMAGE_BUBBLE_MAX_HEIGHT = 300;

/** Duration as m:ss. Negative, NaN and infinite inputs render as 0:00. */
export function formatDuration(ms: number | null | undefined): string {
  const safe = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Clamped 0..1 fraction for progress bars. Unknown totals read as 0. */
export function progressFraction(done: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(done)) return 0;
  return Math.min(1, Math.max(0, done / total));
}

/** Placeholder caption while a transfer is in flight, e.g. "receiving 3/12". */
export function progressLabel(direction: 'in' | 'out', done: number, total: number): string {
  const verb = direction === 'in' ? 'receiving' : 'sending';
  return `${verb} ${Math.min(done, total)}/${total}`;
}

/**
 * Bubble size for an image, keeping its aspect ratio. Falls back to 4:3 when
 * the descriptor carries no dimensions (should not happen for our own sends).
 */
export function imageBoxSize(
  width: number | undefined,
  height: number | undefined,
  maxWidth = IMAGE_BUBBLE_WIDTH,
  maxHeight = IMAGE_BUBBLE_MAX_HEIGHT,
): { width: number; height: number } {
  const validW = typeof width === 'number' && width > 0;
  const validH = typeof height === 'number' && height > 0;
  const ratio = validW && validH ? height! / width! : 0.75;
  let w = maxWidth;
  let h = Math.round(w * ratio);
  if (h > maxHeight) {
    h = maxHeight;
    w = Math.round(h / ratio);
  }
  return { width: w, height: h };
}

/** True when a finished recording is too short to send. */
export function isTooShortVoice(durationMs: number): boolean {
  return durationMs < MIN_VOICE_MS;
}

/** Clamp a measured recording length to the cap, so auto-stop and taps agree. */
export function clampVoiceMs(elapsedMs: number, maxMs: number): number {
  return Math.max(0, Math.min(maxMs, Math.round(elapsedMs)));
}
