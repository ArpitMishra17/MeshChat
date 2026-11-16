/**
 * Phase 4 — Position provider: the bridge between the platform GPS
 * (`expo-location`) and the rest of the app.
 *
 * Responsibilities:
 *   - **Permission + watch:** request foreground location permission and run
 *     `watchPositionAsync` at best-for-navigation accuracy, no more often than
 *     every 2 s or every 1 m of movement. Accuracy is the priority: the fix
 *     is as precise as the phone can produce.
 *   - **Accuracy over privacy:** full-precision coordinates and the GPS
 *     accuracy radius are published as-is (no rounding or truncation). Exact
 *     coordinates are broadcast unencrypted in POSITION beacons and HELLO
 *     packets, so any node in radio range can read them. This is a deliberate
 *     product decision, not an oversight.
 *   - **Change events:** `changed` fires when the fix has moved ≥ 1 m from the
 *     last *published* fix, or its accuracy radius improved by ≥ 30%. Such
 *     events are throttled to at most one per 3 s. Fixes that don't qualify
 *     refresh `getCurrent()` silently; a qualifying fix that lands inside the
 *     throttle window is kept as current and carried by the next fix or the
 *     periodic beacon in ble.ts.
 *   - **Toggle:** GPS is opt-in per user (Settings). When disabled, the node
 *     originates no POSITION beacons and participates as a flooding-only
 *     relay. The toggle persists across launches in the settings table.
 *   - **Start/stop safety:** concurrent `start()` calls share one in-flight
 *     start, so only one GPS watch exists. `stop()` during a start cancels it:
 *     the subscription is removed as soon as it resolves.
 *
 * This module owns the GPS watch. Everything downstream (ble.ts,
 * messageRouter) consumes the abstract `GeoPosition`; NearbyScreen separately
 * reads the compass heading from `expo-location` for the radar.
 */

import * as Location from 'expo-location';
import { Emitter } from './events';
import { getDB, getBoolSetting, setBoolSetting } from '../db/database';
import { haversineMeters } from './location';
import type { GeoPosition } from '../types';

const SETTING_GPS_ENABLED = 'gps_enabled';

/** Minimum interval between GPS fixes requested from the platform (2 s). */
export const MIN_TIME_MS = 2_000;
/** Minimum movement between GPS fixes requested from the platform (1 m). */
export const MIN_DISTANCE_M = 1;
/** A fix that moved at least this far from the last published fix is published. */
export const MIN_MOVE_PUBLISH_M = 1;
/** A fix whose accuracy radius shrank by at least this fraction is published. */
export const ACCURACY_IMPROVEMENT_RATIO = 0.3;
/** At most one `changed` emit per this many ms. */
export const MIN_EMIT_INTERVAL_MS = 3_000;

class PositionProvider {
  /** Fires when a fix qualifies for publication (see the header comment). */
  readonly changed = new Emitter();

  private current: GeoPosition | null = null;
  /** The last fix that was announced via `changed`. Qualification compares against this. */
  private lastPublished: GeoPosition | null = null;
  /** Wall-clock time of the last `changed` emit, for throttling. */
  private lastEmitAt = 0;
  private watching = false;
  private subscription: Location.LocationSubscription | null = null;
  /** In-flight start, shared by concurrent `start()` callers. */
  private starting: Promise<boolean> | null = null;
  /** Bumped by `stop()`; an in-flight start whose generation is stale tears itself down. */
  private generation = 0;
  private enabled: boolean;

  constructor() {
    // Default OFF: GPS is opt-in (PLAN.md: "GPS optional per user").
    getDB();
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
   *
   * Concurrent callers share one in-flight start, so only one platform watch
   * is ever created (App.tsx calls this twice at launch).
   *
   * Called by App.tsx at startup (if the toggle is on) and by setEnabled.
   */
  start(): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    if (this.watching) return Promise.resolve(true);
    if (this.starting) return this.starting;

    const gen = this.generation;
    const pending: Promise<boolean> = this.doStart(gen).finally(() => {
      if (this.starting === pending) this.starting = null;
    });
    this.starting = pending;
    return pending;
  }

  private async doStart(gen: number): Promise<boolean> {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        console.warn('[position] foreground location permission denied');
        return false;
      }
      if (gen !== this.generation) return false; // stopped while asking
      const sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: MIN_TIME_MS,
          distanceInterval: MIN_DISTANCE_M,
        },
        loc => this.onLocation(loc),
      );
      if (gen !== this.generation) {
        // stop() was called while the watch was starting: tear it down now.
        void sub.remove();
        return false;
      }
      this.subscription = sub;
      this.watching = true;
      console.log('[position] GPS watch started');
      return true;
    } catch (e: any) {
      console.warn('[position] failed to start GPS watch:', e?.message ?? e);
      return false;
    }
  }

  /**
   * Stop the GPS watch and clear the current fix. Safe during an in-flight
   * `start()`: that start's subscription is removed once it resolves.
   */
  stop(): void {
    this.generation += 1;
    this.starting = null;
    if (this.subscription) {
      void this.subscription.remove();
      this.subscription = null;
    }
    this.watching = false;
    this.current = null;
    this.lastPublished = null;
    this.lastEmitAt = 0;
  }

  /**
   * The current position (full precision, with accuracy), or null if GPS is
   * disabled or no fix yet. Safe to share with the mesh.
   */
  getCurrent(): GeoPosition | null {
    return this.current;
  }

  private onLocation(loc: Location.LocationObject): void {
    const now = Date.now();
    const fix: GeoPosition = {
      lat: loc.coords.latitude,
      lon: loc.coords.longitude,
      timestamp: now,
      accuracy: loc.coords.accuracy ?? undefined,
    };
    // Always keep the freshest fix, so the periodic beacon sends the latest.
    this.current = fix;

    if (!this.qualifiesForPublish(fix)) return;
    // Throttle: a qualifying fix inside the window stays as `current` and is
    // carried by the next fix or the periodic beacon.
    if (now - this.lastEmitAt < MIN_EMIT_INTERVAL_MS) return;

    this.lastPublished = fix;
    this.lastEmitAt = now;
    this.changed.emit();
  }

  /** True if `fix` moved ≥ 1 m or improved its accuracy ≥ 30% vs the last published fix. */
  private qualifiesForPublish(fix: GeoPosition): boolean {
    const prev = this.lastPublished;
    if (!prev) return true;
    if (haversineMeters(prev, fix) >= MIN_MOVE_PUBLISH_M) return true;
    if (
      prev.accuracy !== undefined &&
      fix.accuracy !== undefined &&
      fix.accuracy <= prev.accuracy * (1 - ACCURACY_IMPROVEMENT_RATIO)
    ) {
      return true;
    }
    return false;
  }
}

export const positionProvider = new PositionProvider();
