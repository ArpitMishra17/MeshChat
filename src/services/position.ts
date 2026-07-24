/**
 * Phase 4 — Position provider: the bridge between the platform GPS
 * (`expo-location`) and the rest of the app.
 *
 * Responsibilities:
 *   - **Permission + watch:** request foreground location permission and run
 *     `watchPositionAsync` with balanced accuracy, no more often than every
 *     30 s or 50 m (PLAN.md Phase 4). Keeps the battery cost of GPS bounded
 *     for the demo.
 *   - **Privacy:** coordinates are truncated to ~3 decimal places (~110 m)
 *     before being published (returned via `getCurrent()`). The full-precision
 *     fix is never exposed to the mesh — relays and peers only ever see the
 *     truncated value. This is the documented privacy trade-off: positions
 *     must be visible to the mesh for geographic routing to work, but their
 *     precision is deliberately blunted.
 *   - **Toggle:** GPS is opt-in per user (Settings). When disabled, the node
 *     originates no POSITION beacons and participates as a flooding-only
 *     relay. The toggle persists across launches in the settings table.
 *   - **Change events:** fires `changed` whenever a fresh truncated fix
 *     arrives, so ble.ts can emit a POSITION beacon on movement.
 *
 * This module is the only place that imports `expo-location`. Everything
 * downstream (ble.ts, messageRouter) consumes the abstract `GeoPosition`.
 */

import * as Location from 'expo-location';
import { Emitter } from './events';
import { getBoolSetting, setBoolSetting } from '../db/database';
import type { GeoPosition } from '../types';

const SETTING_GPS_ENABLED = 'gps_enabled';

/** Minimum interval between GPS fixes (PLAN.md: 30 s). */
const MIN_TIME_MS = 30_000;
/** Minimum distance change to trigger a fix (PLAN.md: 50 m). */
const MIN_DISTANCE_M = 50;
/** Decimal places to retain when publishing (~110 m precision). */
const PUBLISH_DECIMALS = 3;

class PositionProvider {
  /** Fires with the new truncated position whenever a fresh fix arrives. */
  readonly changed = new Emitter();

  private current: GeoPosition | null = null;
  private watching = false;
  private subscription: Location.LocationSubscription | null = null;
  private enabled: boolean;

  constructor() {
    // Default OFF: GPS is opt-in (PLAN.md: "GPS optional per user").
    this.enabled = getBoolSetting(SETTING_GPS_ENABLED, false);
  }

  /** Whether the user has enabled GPS routing. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable/disable GPS. When enabled, starts the watch (if permissions are
   * granted); when disabled, stops it and clears the current fix so the node
   * reverts to flooding-only. Persists to the settings table.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    setBoolSetting(SETTING_GPS_ENABLED, enabled);
    if (enabled) {
      await this.start();
    } else {
      this.stop();
    }
  }

  /**
   * Begin watching the GPS. Idempotent. Requests permission first; if the
   * user denies, the provider stays disabled-by-effect (returns false).
   * Safe to call when already watching.
   *
   * Called by App.tsx at startup (if the toggle is on) and by setEnabled.
   */
  async start(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.watching) return true;

    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        console.warn('[position] foreground location permission denied');
        return false;
      }
      this.subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: MIN_TIME_MS,
          distanceInterval: MIN_DISTANCE_M,
        },
        loc => this.onLocation(loc),
      );
      this.watching = true;
      console.log('[position] GPS watch started');
      return true;
    } catch (e: any) {
      console.warn('[position] failed to start GPS watch:', e?.message ?? e);
      return false;
    }
  }

  /** Stop the GPS watch and clear the current fix. */
  stop(): void {
    if (this.subscription) {
      void this.subscription.remove();
      this.subscription = null;
    }
    this.watching = false;
    this.current = null;
  }

  /**
   * The current truncated position, or null if GPS is disabled or no fix yet.
   * The returned object is safe to share — it is already truncated to
   * PUBLISH_DECIMALS for privacy.
   */
  getCurrent(): GeoPosition | null {
    return this.current;
  }

  private onLocation(loc: Location.LocationObject): void {
    const truncated = truncate(loc.coords.latitude, loc.coords.longitude);
    // Suppress no-op updates: if the truncated coords didn't change, don't
    // fire (avoids beacon storms when stationary). The timestamp still
    // refreshes so staleness reflects the last real fix.
    if (
      this.current &&
      this.current.lat === truncated.lat &&
      this.current.lon === truncated.lon
    ) {
      this.current = { ...truncated, timestamp: Date.now() };
      return;
    }
    this.current = { ...truncated, timestamp: Date.now() };
    this.changed.emit();
  }
}

/**
 * Truncate lat/lon to PUBLISH_DECIMALS (~110 m at the equator). This blunts
 * precision for privacy: a relay learns roughly where you are (enough to
 * route) but not exactly. Math.trunc keeps the value toward zero, which is
 * fine for routing (relative distances are preserved).
 */
function truncate(lat: number, lon: number): { lat: number; lon: number } {
  const factor = Math.pow(10, PUBLISH_DECIMALS);
  return {
    lat: Math.trunc(lat * factor) / factor,
    lon: Math.trunc(lon * factor) / factor,
  };
}

export const positionProvider = new PositionProvider();
