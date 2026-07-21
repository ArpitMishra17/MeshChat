import { registerRootComponent } from 'expo';

// Phase 2 — polyfill `globalThis.crypto.getRandomValues` before any module
// that uses @noble/curves / @noble/ciphers (which rely on the Web Crypto
// API for randomness). Must come before `App` is imported, since App's
// module graph pulls in identity.ts → crypto.ts → @noble.
import './src/services/cryptoPolyfill';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
