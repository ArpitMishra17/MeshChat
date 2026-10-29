<p align="center"><img src="assets/icon.png" width="120" alt="MeshChat logo"></p>

# MeshChat

An offline messenger for Android. Phones talk to each other over Bluetooth Low Energy, and messages hop through nearby devices to reach people who are out of direct range. There are no servers, no accounts and no internet.

> Inspired by [bitchat](https://github.com/permissionlesstech/bitchat) by Jack Dorsey.

## Features

- **Peer-to-peer over BLE** – discover nearby phones and chat directly.
- **Multi-hop relaying** – TTL-limited flooding with duplicate suppression, plus GPS-aware forwarding.
- **End-to-end encryption** – X25519 key exchange and AES-256-GCM; identity is a public-key fingerprint.
- **Store-and-forward** – an outbox holds messages until a route to the recipient appears.
- **Local-only storage** – chats live in an on-device SQLite database.
- **Mesh and Wire tabs** – live telemetry of links, packets, drops and the raw protocol.

## Tech stack

| Area | Tools |
|---|---|
| App | React Native 0.83, Expo SDK 55, TypeScript, React Navigation |
| Bluetooth | `react-native-ble-plx` (scan and connect), custom Kotlin `BlePeripheral` module (advertise) |
| Crypto | `@noble/curves`, `@noble/ciphers`, `@noble/hashes`, `expo-crypto`, `expo-secure-store` |
| Storage | `expo-sqlite` |
| Location | `expo-location` |
| Tests | Jest, `jest-expo` |

## Run it

Needs Node, JDK 17 (Android Studio's bundled one works), the Android SDK, and a phone with USB debugging on. Bluetooth does not work in an emulator.

```bash
npm install
npx expo run:android --device                    # dev build (needs Metro)
npx expo run:android --device --variant release  # standalone build
npm test
```

Install it on at least two phones to see messages travel. Android only; the native `BlePeripheral` module is not available on iOS.

## Layout

```
src/services/   BLE, protocol, crypto, relay, outbox, routing, telemetry
src/screens/    Chats, Nearby, Mesh, Wire, Settings, Onboarding
src/db/         SQLite schema and queries
modules/BlePeripheral/   native Android BLE advertiser
```
