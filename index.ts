import { registerRootComponent } from 'expo';

// Phase 2 — polyfill `globalThis.crypto.getRandomValues` before any module
// that uses @noble/curves / @noble/ciphers (which rely on the Web Crypto
// API for randomness). Must come before `App` is imported, since App's
// module graph pulls in identity.ts → crypto.ts → @noble.
import './src/services/cryptoPolyfill';

import { AppRegistry } from 'react-native';
import { startMeshServices } from './src/services/boot';
import App from './App';

// Background relay (MeshRelayService) runs this headless task. Starting the
// services from here keeps the BLE mesh, the scan duty cycle and the outbox
// retries alive while the UI is closed. The never-resolving promise keeps JS
// timers running: JavaTimerManager pauses them on host pause otherwise. If
// there is no identity yet, the task ends and the service stops itself.
AppRegistry.registerHeadlessTask('MeshRelay', () => async () => {
  if (!startMeshServices()) return;
  await new Promise<void>(() => {});
});

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
