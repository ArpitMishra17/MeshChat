import BlePeripheral from '../../modules/BlePeripheral';
import { getBoolSetting, getDB, getIdentity } from '../db/database';
import { messageRouter } from './messageRouter';
import { notifier } from './notifier';
import { mesh } from './mesh';
import { positionProvider } from './position';
import { telemetry } from './telemetry';

/**
 * Shared bootstrap for the mesh services. Called from two places in the same
 * JS runtime: the App component (foreground) and the "MeshRelay" headless task
 * (the background relay service). Both may run, so it is idempotent.
 *
 * Headless-safe: nothing here needs an Activity. `mesh.start()` requests BLE
 * permissions only when they are missing; that rejects without an Activity and
 * is caught inside the scan loop. `positionProvider.start()` requests location
 * permission inside a try, so a missing Activity returns false instead of
 * throwing. Permission prompts therefore only happen from the foreground App.
 */
let started = false;

/** Returns false when there is no identity yet (onboarding not finished). */
export function startMeshServices(): boolean {
  if (started) return true;
  try {
    getDB();
    if (!getIdentity()) return false;
    messageRouter.start();
    notifier.start();
    telemetry.start();
    mesh.start();
    void positionProvider.start();
    started = true;
    return true;
  } catch (e: any) {
    console.warn('[boot] mesh services failed to start:', e?.message ?? e);
    return false;
  }
}

/**
 * Keep the native foreground relay service in line with the
 * `background_relay_enabled` setting. Foreground only: Android 12+ forbids
 * starting a foreground service from the background.
 */
export function syncRelayService(): boolean {
  try {
    return getBoolSetting('background_relay_enabled', true)
      ? BlePeripheral.startRelayService()
      : BlePeripheral.stopRelayService();
  } catch (e: any) {
    console.warn('[boot] relay service sync failed:', e?.message ?? e);
    return false;
  }
}
