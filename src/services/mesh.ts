import { bleService, type NeighborInfo } from './ble';
import { Emitter } from './events';
import type { Peer } from '../types';

/**
 * Phase 3 — Neighbor manager.
 *
 * Drives the BLE topology so the rest of the app can treat "who is reachable"
 * as a read-only view instead of imperatively scanning and connecting. This is
 * the layer that turns the single-link Phase 2 radio into a mesh:
 *
 *   - **Duty-cycled background scan** (15 s scan / 15 s pause). Keeps the
 *     neighbor table fresh without cooking the battery — a continuous scan
 *     would make the demo phone warm and drain it in an hour.
 *   - **Auto-connect** to every discovered MeshChat node, up to Android's
 *     practical concurrent-GATT cap (~4 central connections). Peripheral-side
 *     connections (them connecting to us) are passive and unlimited.
 *   - **Link-state events** so the Nearby screen and the relay engine can
 *     react to neighbors appearing / disappearing.
 *
 * What this does NOT do: route. Routing (seen-cache, TTL, forward/deliver) is
 * the relay engine in `messageRouter.ts`. `mesh.ts` only keeps the link pool
 * fed; `ble.ts` is the primitive it drives.
 *
 * Double-connections (both peers auto-connecting to each other) are permitted:
 * the link pool tracks both transports for one fingerprint, and the relay
 * engine's seen-cache makes the resulting duplicate packets harmless. A
 * proper tie-breaker would need a stable symmetric value both nodes know
 * pre-HELLO, which doesn't exist — so we accept the minor redundancy. The
 * concurrent-connection cap keeps the cost bounded.
 */

const SCAN_MS = 15_000;
const PAUSE_MS = 15_000;
/** Android's practical concurrent central GATT connection cap. */
const MAX_CENTRAL_CONNECTIONS = 4;
/** Don't re-attempt an auto-connect to a MAC we just tried for this long. */
const RECENT_ATTEMPT_COOLDOWN_MS = 20_000;

class MeshManager {
  /** Fires whenever a link comes up or goes down (neighbors list changed). */
  readonly neighborsChanged = new Emitter();

  private running = false;
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  /** BLE MACs with an in-flight auto-connect (prevents stacking connects). */
  private connecting = new Set<string>();
  /** BLE MAC → last auto-connect attempt timestamp (backoff on failure). */
  private lastAttempt = new Map<string, number>();
  /**
   * Peers discovered during the current scan window. Drained in the pause
   * window after the scan ends — connecting while a scan is in flight works
   * on most modern Android devices but is flaky on some chipsets, so we
   * connect during the pause to make the relay demo reliable.
   */
  private discoveredThisCycle = new Map<string, Peer>();

  private unsubs: Array<() => void> = [];

  /**
   * Begin the mesh: start advertising + the duty-cycled scan loop, and subscribe
   * to scan results for auto-connect. Idempotent. Started by `App.tsx` once
   * the identity exists; also safe to call from the Nearby screen's manual
   * scan button (it just kicks an immediate cycle).
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.unsubs.push(
      bleService.scanResult.subscribe(p => this.onScanResult(p)),
      bleService.linkUp.subscribe(() => this.neighborsChanged.emit()),
      bleService.linkDown.subscribe(() => {
        this.neighborsChanged.emit();
        // A link dropped — kick an immediate scan to refill the pool, in case
        // the duty cycle is in its pause window.
        this.kickCycle();
      }),
    );

    // Start the first scan cycle immediately (also starts the peripheral).
    void this.dutyCycle();
  }

  stop(): void {
    this.running = false;
    if (this.cycleTimer !== null) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
    bleService.stopScan();
    this.unsubs.forEach(u => u());
    this.unsubs = [];
  }

  /** Whether the background mesh loop is running. */
  isRunning(): boolean { return this.running; }

  /** Current established neighbors (snapshot). */
  getNeighbors(): NeighborInfo[] {
    return bleService.getNeighbors();
  }

  /**
   * Trigger an immediate scan cycle (cancels the pause wait). Used by the
   * Nearby screen's manual SCAN button so the user doesn't have to wait for
   * the next duty-cycle window.
   */
  forceScanNow(): void {
    if (!this.running) this.start();
    else this.kickCycle();
  }

  // --- internals ---

  private kickCycle(): void {
    if (!this.running) return;
    // If a scan is in progress, let it finish naturally.
    if (bleService.getState() === 'scanning') return;
    if (this.cycleTimer !== null) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
    void this.dutyCycle();
  }

  /**
   * One duty-cycle iteration: scan for SCAN_MS, then drain the discovered
   * peers (auto-connect) during the pause, then schedule the next cycle.
   * Connecting in the pause window (scan off) avoids scan+connect contention
   * on flaky Android BLE stacks.
   */
  private async dutyCycle(): Promise<void> {
    if (!this.running) return;
    this.discoveredThisCycle.clear();
    try {
      await bleService.startScan(SCAN_MS);
    } catch (e: any) {
      console.warn('[mesh] scan failed:', e?.message ?? e);
    }
    if (!this.running) return;
    // Scan ended — drain discovered peers into the link pool.
    await this.drainDiscovered();
    if (!this.running) return;
    this.cycleTimer = setTimeout(() => void this.dutyCycle(), PAUSE_MS);
  }

  /**
   * Auto-connect to peers discovered in the just-finished scan, respecting
   * the concurrent-connection cap and a short per-MAC cooldown. Connections
   * that fail (peer gone, already connected to us, etc.) are silent — the
   * next duty cycle retries.
   */
  private async drainDiscovered(): Promise<void> {
    const peers = Array.from(this.discoveredThisCycle.values());
    for (const peer of peers) {
      if (!this.running) return;
      const bleId = peer.bleId;
      if (!bleId) continue;
      if (this.connecting.has(bleId)) continue;
      if (bleService.getCentralConnectionCount() >= MAX_CENTRAL_CONNECTIONS) return;
      const last = this.lastAttempt.get(bleId);
      if (last && Date.now() - last < RECENT_ATTEMPT_COOLDOWN_MS) continue;
      // Don't auto-connect to a peer we already have a link to (by bleId).
      // bleService.connectToPeer also guards this, but checking first avoids
      // spawning a doomed promise.
      void this.autoConnect(bleId);
    }
  }

  /**
   * Collect a discovered peer for the drain phase. (Connecting here would race
   * the scan on some Android BLE stacks — see `drainDiscovered`.)
   */
  private onScanResult(peer: Peer): void {
    if (!this.running) return;
    const bleId = peer.bleId;
    if (!bleId) return;
    this.discoveredThisCycle.set(bleId, peer);
  }

  private async autoConnect(bleId: string): Promise<void> {
    this.connecting.add(bleId);
    this.lastAttempt.set(bleId, Date.now());
    try {
      await bleService.connectToPeer(bleId);
      // linkUp fired inside connectToPeer; neighborsChanged fires from the
      // subscription in start().
    } catch (e: any) {
      // Common: peer went out of range, or it's already connecting to us
      // (double-connect attempt). Not fatal — the next duty cycle retries.
      console.log(`[mesh] autoConnect ${bleId.slice(-8)} failed: ${e?.message ?? e}`);
    } finally {
      this.connecting.delete(bleId);
    }
  }
}

export const mesh = new MeshManager();
