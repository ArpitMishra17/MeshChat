/**
 * Proximity helpers that do not need GPS. Right now: a rough distance
 * estimate from BLE signal strength, used to show linked neighbours that have
 * no position yet.
 */

const MIN_M = 0.1;
const MAX_M = 100;

/**
 * Rough distance from an RSSI reading, using the log-distance path-loss model
 * `d = 10^((txPowerAt1m - rssi) / (10 * n))`. `txPowerAt1m` is the RSSI
 * expected at 1 m and `n` the path-loss exponent (about 2 in open air, higher
 * indoors).
 *
 * This is a rough estimate only, about ±50%: RSSI swings with antenna
 * orientation, the body and walls. Read it as "roughly this far", never as a
 * measurement. The result is clamped to 0.1–100 m, and a non-finite reading
 * maps to the far end.
 */
export function rssiToMeters(rssi: number, txPowerAt1m = -59, pathLossExponent = 2.2): number {
  if (!Number.isFinite(rssi)) return MAX_M;
  const d = 10 ** ((txPowerAt1m - rssi) / (10 * pathLossExponent));
  return Math.min(MAX_M, Math.max(MIN_M, d));
}

/** Whole-metre label for a signal estimate, e.g. `~3m`. Never below `~1m`. */
export function formatSignalM(m: number): string {
  return `~${Math.max(1, Math.round(m))}m`;
}
