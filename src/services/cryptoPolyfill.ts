/**
 * Phase 2 — Polyfill `globalThis.crypto.getRandomValues` for React Native.
 *
 * `@noble/curves` and `@noble/ciphers` rely on the Web Crypto API
 * (`globalThis.crypto.getRandomValues`) for randomness. Hermes does not
 * provide this natively, so we shim it from `expo-crypto`'s native
 * implementation (which delegates to the platform CSPRNG: Android Keystore
 * / iOS SecRandomCopyBytes).
 *
 * This module must be imported before any key generation. It is imported
 * at the top of `index.ts` (the RN entry point) and is a no-op in the test
 * environment where Node provides `globalThis.crypto` natively.
 */
import * as Crypto from 'expo-crypto';

const g = globalThis as any;

if (!g.crypto?.getRandomValues) {
  g.crypto = {
    getRandomValues(array: Uint8Array): Uint8Array {
      Crypto.getRandomValues(array);
      return array;
    },
    randomUUID(): string {
      return Crypto.randomUUID();
    },
  };
}
