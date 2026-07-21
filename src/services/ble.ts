import { BleManager, Device, type Subscription } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import BlePeripheral from '../../modules/BlePeripheral';
import { ensureIdentity, getCrypto } from './identity';
import { upsertPeer, checkPeerKeyChange, getAllPeers } from '../db/database';
import {
  encodeBLEPayload,
  encodeRawPacket,
  decodeBLEChunkRaw,
  encodeBody,
  decodeBody,
  buildHeaderBytes,
  headerToAAD,
  BROADCAST_DST,
  DEFAULT_TTL,
  TYPE_MESSAGE,
  FLAG_ENCRYPTED,
} from './protocol';
import { fingerprintHexFromPubKey, NONCE_SIZE, GCM_TAG_SIZE } from './crypto';
import { generatePacketId, bytesToHex } from './ids';
import type {
  Peer,
  BLEPayload,
  HandshakePayload,
  MessagePayload,
  AckPayload,
} from '../types';

const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
const HANDSHAKE_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef1';
const MESSAGE_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef2';
const ACK_CHAR_UUID = '12345678-1234-5678-1234-56789abcdef3';

/** P0.3 — How long the central waits for the peripheral's HELLO notification. */
const HANDSHAKE_TIMEOUT_MS = 8000;

export type BLEState = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error';

type StateChangedCallback = (state: BLEState) => void;

/**
 * Result of `connectToPeer`. The caller (NearbyScreen) awaits the handshake
 * exchange before opening a conversation, so the conversation is keyed on the
 * peer's real deviceId — never on the rotating BLE MAC (P0.3).
 */
export interface ConnectResult {
  device: Device;
  handshake: HandshakePayload;
}

/**
 * Typed emitter that carries a payload to its listeners.
 * Tiny wrapper around the payload-less `Emitter` in events.ts.
 */
class PayloadEmitter<T> {
  private listeners = new Set<(payload: T) => void>();
  subscribe(fn: (payload: T) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  emit(payload: T): void {
    const snapshot = Array.from(this.listeners);
    for (const fn of snapshot) {
      try { fn(payload); } catch (e) { console.warn('[BLE emitter] listener threw:', e); }
    }
  }
}

class BLEService {
  private manager: BleManager;
  private scanning = false;
  /** P0.4 — armed by startScan, cleared by stopScan / connectToPeer. */
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedDevice: Device | null = null;
  /** P0.7 — MTU negotiated on the central side, plumbed into encodeBLEPayload. */
  private negotiatedMtu: number | null = null;
  /**
   * Phase 1 — 8-byte fingerprints for the v2 packet header's src/dst fields.
   * `peerFingerprint` is learned from the peer's HELLO (Phase 2: derived from
   * their X25519 public key). Phase 0 was single-link, so a single peer slot
   * matches that assumption — Phase 3 will replace this with a per-link map.
   */
  private peerFingerprint: Uint8Array | null = null;
  private subscriptions: Subscription[] = [];
  private state: BLEState = 'idle';
  private peripheralStarted = false;

  // P0.1 — multi-subscriber emitters so the MessageRouter (always-on) and a
  // mounted screen (ephemeral) can both listen without one clobbering the
  // other. The previous single-slot setters caused the router to lose
  // callbacks whenever a screen null'd the slot on unmount.
  readonly peerDiscovered = new PayloadEmitter<Peer>();
  readonly messageReceived = new PayloadEmitter<MessagePayload>();
  readonly ackReceived = new PayloadEmitter<AckPayload>();
  readonly handshakeReceived = new PayloadEmitter<{ payload: HandshakePayload; bleId: string | null }>();
  readonly stateChanged = new PayloadEmitter<BLEState>();
  /** Phase 2 — fires when a known peer's public key has changed (TOFU violation). */
  readonly keyWarning = new PayloadEmitter<{ deviceId: string; displayName: string }>();

  private discoveredDevices = new Map<string, number>();
  public lastLog = '';

  constructor() {
    this.manager = new BleManager();
    this.setupPeripheralListeners();
  }

  // --- Peripheral (GATT Server) Setup ---

  private setupPeripheralListeners() {
    // Listen for writes from connected centrals (incoming messages / handshakes).
    const writeSubscription = BlePeripheral.addListener(
      'onCharacteristicWriteRequest',
      (event: { characteristicUUID: string; value: string; deviceAddress: string }) => {
        console.log(
          `[BLE RECV] Write on ${event.characteristicUUID.slice(-4)} ` +
            `from ${event.deviceAddress.slice(-5)}, value len=${event.value?.length}`,
        );
        try {
          const sourceKey = `${event.deviceAddress}_${event.characteristicUUID}`;
          const payload = this.decodeIncoming(event.value, sourceKey);
          // payload is null if still assembling fragments or decrypt failed
          if (!payload) return;

          console.log('[BLE Peripheral] Decoded payload:', payload.type);

          if (payload.type === 'message') {
            this.messageReceived.emit(payload as MessagePayload);
          } else if (payload.type === 'ack') {
            this.ackReceived.emit(payload as AckPayload);
          } else if (payload.type === 'handshake') {
            this.handleHandshakeReceived(payload as HandshakePayload, event.deviceAddress);

            // P0.3 — peripheral responds with its own handshake notification
            // so the central learns our real identity. Broadcast is fine
            // here because Phase 0 is single-link; per-device addressing lands
            // in Phase 3.
            void this.notifyHandshake();
          }
        } catch (e) {
          console.warn('[BLE Peripheral] Failed to parse write:', e);
        }
      },
    );

    BlePeripheral.addListener('onDeviceConnected', (event: { deviceAddress: string }) => {
      console.log('[BLE Peripheral] Central connected:', event.deviceAddress);
      this.setState('connected');
    });

    BlePeripheral.addListener('onDeviceDisconnected', (event: { deviceAddress: string }) => {
      console.log('[BLE Peripheral] Central disconnected:', event.deviceAddress);
      if (BlePeripheral.getConnectedDeviceCount() === 0 && !this.connectedDevice) {
        // Phase 1 — peer link is gone; forget the fingerprint so we don't
        // address packets to a peer that is no longer reachable.
        this.peerFingerprint = null;
        this.setState('idle');
      }
    });

    void writeSubscription;
  }

  async startPeripheral(): Promise<string> {
    if (this.peripheralStarted) return 'already started';

    const identity = ensureIdentity();
    const advName = `MC_${identity.displayName.slice(0, 8)}`;

    console.log('[BLE] Starting GATT server...');
    await BlePeripheral.startServer(SERVICE_UUID, [
      HANDSHAKE_CHAR_UUID,
      MESSAGE_CHAR_UUID,
      ACK_CHAR_UUID,
    ]);

    console.log('[BLE] Starting advertising as:', advName);
    const result = await BlePeripheral.startAdvertising(SERVICE_UUID, advName);
    console.log('[BLE] Advertising result:', result);
    this.peripheralStarted = true;
    console.log('[BLE] Peripheral fully started');
    return result;
  }

  // --- Listeners (multi-subscriber; see PayloadEmitter) ---
  //
  // All BLE callbacks are exposed as emitters. This fixes the original
  // single-slot bug where the MessageRouter (always-on) and a mounted
  // screen (ephemeral) would fight over `onPeerDiscovered` — the screen's
  // unmount would null the slot and the router would silently stop
  // receiving events.

  /** Subscribe to BLE state changes. Returns an unsubscribe function. */
  subscribeState(cb: StateChangedCallback): () => void {
    return this.stateChanged.subscribe(cb);
  }

  getState(): BLEState { return this.state; }

  private setState(newState: BLEState) {
    this.state = newState;
    this.stateChanged.emit(newState);
  }

  // --- Permissions ---

  async requestPermissions(): Promise<boolean> {
    if (Platform.OS === 'android') {
      const apiLevel = Platform.Version;
      if (apiLevel >= 31) {
        const results = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
      } else {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        return result === PermissionsAndroid.RESULTS.GRANTED;
      }
    }
    return true;
  }

  // --- Scanning (Central) ---

  async startScan(durationMs = 15000): Promise<void> {
    if (this.scanning) return;

    const permitted = await this.requestPermissions();
    if (!permitted) {
      this.setState('error');
      throw new Error('BLE permissions not granted');
    }

    // Start peripheral advertising so OTHER phones scanning can find us
    try {
      const advResult = await this.startPeripheral();
      this.lastLog = `[ADV] ${advResult}`;
    } catch (e: any) {
      this.lastLog = `[ERR] peripheral: ${e.message}`;
    }

    this.scanning = true;
    this.setState('scanning');
    this.discoveredDevices.clear();

    return new Promise((resolve, reject) => {
      // P0.4 — track the timer so connectToPeer / stopScan can cancel it.
      this.scanTimer = setTimeout(() => {
        this.stopScan();
        resolve();
      }, durationMs);

      // Scan without UUID filter — many Android devices don't advertise
      // service UUIDs reliably. We filter by name prefix instead.
      this.manager.startDeviceScan(
        null,
        { allowDuplicates: false },
        (error, device) => {
          if (error) {
            this.clearScanTimer();
            this.scanning = false;
            this.setState('error');
            reject(error);
            return;
          }
          if (device) {
            // Filter: only show MeshChat devices (name starts with MC_)
            const name = device.localName || device.name || '';
            if (name.startsWith('MC_')) {
              this.handleDiscoveredDevice(device);
            }
          }
        },
      );
    });
  }

  stopScan(): void {
    // P0.4 — cancel the pending timeout so it can't fire setState('idle')
    // after we've already moved on to connecting / connected.
    this.clearScanTimer();
    this.manager.stopDeviceScan();
    this.scanning = false;
    // P0.4 — restore 'connected' if a link is up; otherwise we're idle.
    this.setState(this.isAnyLinkUp() ? 'connected' : 'idle');
  }

  private clearScanTimer(): void {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private isAnyLinkUp(): boolean {
    return this.connectedDevice !== null || BlePeripheral.getConnectedDeviceCount() > 0;
  }

  private handleDiscoveredDevice(device: Device) {
    const now = Date.now();
    const name = device.localName || device.name || '';
    // Deduplicate by name (Android rotates BLE MAC addresses)
    const dedupeKey = name || device.id;
    const lastSeen = this.discoveredDevices.get(dedupeKey);
    if (lastSeen && now - lastSeen < 2000) return;
    this.discoveredDevices.set(dedupeKey, now);

    const peer: Peer = {
      deviceId: device.id,
      displayName: device.localName || device.name || `device_${device.id.slice(-6)}`,
      lastSeen: now,
      rssi: device.rssi,
      bleId: device.id,
      publicKey: null,
      keyPinned: false,
    };

    // Phase 2 — scan-discovered peers are NOT persisted to the DB. Their
    // real identity (fingerprint + pubkey) is only learned at handshake
    // time. Persisting a BLE MAC as deviceId would recreate the P0.3
    // identity-fragmentation bug. The Nearby screen shows scan results
    // live via the emitter; the DB only holds handshake-completed peers.
    this.peerDiscovered.emit(peer);
  }

  // --- Connection (Central connects to Peripheral) ---

  /**
   * Connect to a peer by BLE MAC and complete the mutual handshake before
   * returning. The caller must NOT create a conversation from the BLE MAC —
   * it should use the returned `handshake.deviceId` instead (P0.3).
   */
  async connectToPeer(bleId: string): Promise<ConnectResult> {
    // P0.4 — stopScan clears the timer; state becomes 'connecting'.
    this.stopScan();
    this.setState('connecting');

    try {
      const device = await this.manager.connectToDevice(bleId, { timeout: 10000 });
      // Request larger MTU so payloads don't get truncated (default is 20 bytes)
      const mtuDevice = await device.requestMTU(512);
      const mtu = mtuDevice.mtu ?? 23;
      this.negotiatedMtu = mtu;
      console.log(`[BLE] Negotiated MTU: ${mtu}`);
      await device.discoverAllServicesAndCharacteristics();
      this.connectedDevice = device;
      this.setState('connected');

      device.onDisconnected(() => {
        this.connectedDevice = null;
        this.negotiatedMtu = null;
        this.peerFingerprint = null;
        this.cleanupSubscriptions();
        this.setState('idle');
      });

      // P0.3 — subscribe to the peripheral's handshake notification BEFORE
      // we send our own, so we don't race the reply. The promise resolves
      // when the peripheral's HELLO arrives (or rejects on timeout).
      const handshakePromise = this.subscribeToHandshake(device);

      await this.sendHandshake(device);
      this.subscribeToMessages(device);
      this.subscribeToAcks(device);

      const handshake = await handshakePromise;
      // Phase 2 — the peer's fingerprint is derived from their public key
      // (received in HELLO). The crypto service has already remembered the
      // peer's key (in handleHandshakeReceived) so MESSAGE encrypt/decrypt
      // works. Store the 8-byte fingerprint for addressing packets.
      this.peerFingerprint = getCrypto().rememberPeer(handshake.publicKey);
      return { device, handshake };
    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connectedDevice) {
      try { await this.connectedDevice.cancelConnection(); } catch {}
      this.connectedDevice = null;
      this.negotiatedMtu = null;
      this.peerFingerprint = null;
      this.cleanupSubscriptions();
      this.setState('idle');
    }
  }

  isConnected(): boolean {
    return this.isAnyLinkUp();
  }

  // --- Handshake ---

  private async sendHandshake(device: Device): Promise<void> {
    const identity = ensureIdentity();
    const payload: HandshakePayload = {
      type: 'handshake',
      deviceId: identity.deviceId,
      displayName: identity.displayName,
      publicKey: identity.publicKey,
    };
    await this.writeFragments(device, HANDSHAKE_CHAR_UUID, payload);
  }

  /**
   * P0.3 — peripheral-side reply. Notifies our handshake back on the handshake
   * characteristic so the central learns who we are. Broadcasts to all
   * subscribed centrals (Phase 0 is single-link; per-device addressing is
   * Phase 3's job).
   *
   * Phase 2 — carries our 32-byte X25519 public key so the central can
   * derive the shared secret and our fingerprint.
   */
  private async notifyHandshake(): Promise<void> {
    if (BlePeripheral.getConnectedDeviceCount() === 0) return;
    const identity = ensureIdentity();
    const payload: HandshakePayload = {
      type: 'handshake',
      deviceId: identity.deviceId,
      displayName: identity.displayName,
      publicKey: identity.publicKey,
    };
    try {
      const fragments = this.encodeFragments(payload);
      for (const frag of fragments) {
        await BlePeripheral.sendNotification(HANDSHAKE_CHAR_UUID, frag);
      }
    } catch (e: any) {
      console.warn('[BLE] notifyHandshake failed:', e?.message ?? e);
    }
  }

  private async writeFragments(device: Device, charUUID: string, payload: BLEPayload): Promise<void> {
    const fragments = this.encodeFragments(payload);
    console.log(`[BLE] Sending ${fragments.length} fragment(s) to ${charUUID.slice(-4)}`);
    for (const frag of fragments) {
      await device.writeCharacteristicWithResponseForService(SERVICE_UUID, charUUID, frag);
    }
  }

  // --- Messaging ---

  async sendMessage(messagePayload: MessagePayload): Promise<void> {
    // Try sending as Central (writing to peer's GATT server)
    if (this.connectedDevice) {
      console.log('[BLE] Sending as CENTRAL (write to peer GATT)');
      await this.writeFragments(this.connectedDevice, MESSAGE_CHAR_UUID, messagePayload);
      return;
    }

    // Fallback: send as Peripheral (notify connected centrals)
    const connCount = BlePeripheral.getConnectedDeviceCount();
    console.log(`[BLE] No central connection. Peripheral has ${connCount} connected device(s)`);
    if (connCount > 0) {
      console.log('[BLE] Sending as PERIPHERAL (notification)');
      const fragments = this.encodeFragments(messagePayload);
      for (const frag of fragments) {
        const result = await BlePeripheral.sendNotification(MESSAGE_CHAR_UUID, frag);
        console.log('[BLE] Notification result:', result);
      }
      return;
    }

    throw new Error('Not connected to any device');
  }

  async sendAck(messageId: string): Promise<void> {
    const payload: AckPayload = { type: 'ack', messageId };

    try {
      if (this.connectedDevice) {
        await this.writeFragments(this.connectedDevice, ACK_CHAR_UUID, payload);
      } else if (BlePeripheral.getConnectedDeviceCount() > 0) {
        const fragments = this.encodeFragments(payload);
        for (const frag of fragments) {
          await BlePeripheral.sendNotification(ACK_CHAR_UUID, frag);
        }
      }
    } catch (e: any) {
      // P0.8 — was `catch {}`. Log so delivery failures surface during testing.
      console.warn(`[BLE] sendAck failed for ${messageId}:`, e?.message ?? e);
    }
  }

  // --- Central subscriptions (listen to peripheral's notifications) ---

  /**
   * P0.3 — Subscribe to the peripheral's handshake notification and resolve
   * with the first HELLO we receive. Times out after `timeoutMs` so the
   * caller isn't stuck if the peripheral never responds.
   *
   * Phase 2 — the HELLO carries the peer's 32-byte public key; we derive
   * the fingerprint from it, remember the peer's shared key, and pin the
   * pubkey (trust-on-first-use).
   */
  private subscribeToHandshake(device: Device): Promise<HandshakePayload> {
    return new Promise((resolve, reject) => {
      // Declare `sub` first so the timeout + monitor callbacks can reference
      // it without a TDZ smell. Assigned immediately below.
      let sub: Subscription;
      const timeout = setTimeout(() => {
        sub.remove();
        const idx = this.subscriptions.indexOf(sub);
        if (idx >= 0) this.subscriptions.splice(idx, 1);
        reject(new Error('Handshake notification timeout'));
      }, HANDSHAKE_TIMEOUT_MS);

      sub = device.monitorCharacteristicForService(
        SERVICE_UUID, HANDSHAKE_CHAR_UUID,
        (error, characteristic) => {
          if (error) {
            clearTimeout(timeout);
            console.warn('[BLE] Handshake monitor error:', error.message);
            reject(error);
            return;
          }
          if (!characteristic?.value) return;
          try {
            const payload = this.decodeIncoming(
              characteristic.value,
              `central_handshake_${device.id}`,
            );
            if (payload?.type === 'handshake') {
              clearTimeout(timeout);
              const hp = payload as HandshakePayload;
              this.handleHandshakeReceived(hp, device.id);
              sub.remove();
              const idx = this.subscriptions.indexOf(sub);
              if (idx >= 0) this.subscriptions.splice(idx, 1);
              resolve(hp);
            }
          } catch (e: any) {
            console.warn('[BLE] Failed to decode handshake notification:', e?.message ?? e);
          }
        },
      );
      this.subscriptions.push(sub);
    });
  }

  private subscribeToMessages(device: Device) {
    console.log(`[BLE] Subscribing to message notifications from ${device.id.slice(-8)}`);
    const sub = device.monitorCharacteristicForService(
      SERVICE_UUID, MESSAGE_CHAR_UUID,
      (error, characteristic) => {
        if (error) {
          console.warn('[BLE] Message monitor error:', error.message);
          return;
        }
        if (!characteristic?.value) return;
        console.log(`[BLE] Received notification on MESSAGE char, ${characteristic.value.length} bytes`);
        try {
          const payload = this.decodeIncoming(characteristic.value, `central_msg_${device.id}`);
          if (payload) {
            console.log('[BLE] Decoded message:', payload.type);
            if (payload.type === 'message') this.messageReceived.emit(payload);
            else if (payload.type === 'handshake') {
              // A late handshake notification (after the initial one resolved).
              this.handleHandshakeReceived(payload as HandshakePayload, device.id);
            }
          }
        } catch (e: any) {
          console.warn('[BLE] Failed to decode notification:', e.message);
        }
      },
    );
    this.subscriptions.push(sub);
  }

  private subscribeToAcks(device: Device) {
    console.log(`[BLE] Subscribing to ack notifications from ${device.id.slice(-8)}`);
    const sub = device.monitorCharacteristicForService(
      SERVICE_UUID, ACK_CHAR_UUID,
      (error, characteristic) => {
        if (error) {
          console.warn('[BLE] Ack monitor error:', error.message);
          return;
        }
        if (!characteristic?.value) return;
        try {
          const payload = this.decodeIncoming(characteristic.value, `central_ack_${device.id}`);
          if (payload?.type === 'ack') this.ackReceived.emit(payload);
        } catch (e: any) {
          console.warn('[BLE] Failed to decode ack notification:', e?.message ?? e);
        }
      },
    );
    this.subscriptions.push(sub);
  }

  private cleanupSubscriptions() {
    this.subscriptions.forEach(s => s.remove());
    this.subscriptions = [];
  }

  // --- Encoding / Decoding via the v2 binary protocol with fragmentation ---
  //
  // Phase 2 — MESSAGE payloads are encrypted end-to-end (AES-256-GCM with
  // the header as AAD). HELLO and ACK stay plaintext: HELLO must carry the
  // pubkey to establish the shared key; ACKs leak only the msgId already
  // visible in the header.

  private encodeFragments(payload: BLEPayload): string[] {
    // msgId is a fresh random 64-bit id per packet (Phase 3 flooding dedup key).
    // P0.7 — negotiated MTU on the central path; peripheral-notify path
    // falls back to the default (unknown MTU on the GATT server side).
    const isHandshake = payload.type === 'handshake';

    if (payload.type === 'message') {
      // Phase 2 — encrypt the message body end-to-end before framing.
      return this.encodeEncryptedMessage(payload as MessagePayload);
    }

    // HELLO / ACK — plaintext.
    return encodeBLEPayload(payload, {
      src: this.getMyFingerprint(),
      dst: isHandshake ? BROADCAST_DST : (this.peerFingerprint ?? BROADCAST_DST),
      msgId: generatePacketId(),
      ttl: DEFAULT_TTL,
      mtu: this.negotiatedMtu ?? undefined,
    });
  }

  /**
   * Phase 2 — Encrypt a MESSAGE payload end-to-end and frame it as a v2
   * packet. The plaintext is the serialized message body; the encrypted
   * payload (nonce ‖ ciphertext ‖ tag) becomes the packet's payload field.
   *
   * The packet header (with TTL zeroed) is bound as AAD so a relay cannot
   * alter src/dst/msgId without failing authentication. The encrypted
   * length is deterministic (nonce + plaintext + tag), so we can compute
   * the AAD header before encrypting.
   */
  private encodeEncryptedMessage(message: MessagePayload): string[] {
    const myFp = this.getMyFingerprint();
    const peerFp = this.peerFingerprint;
    if (!peerFp) {
      throw new Error('Cannot encrypt message — no peer fingerprint (handshake not complete)');
    }

    const msgId = generatePacketId();
    const plaintext = encodeBody(message);

    // Encrypted payload = nonce(12) + ciphertext + tag(16). Length is
    // deterministic, so the AAD header (which includes payloadLen) can be
    // built before encryption.
    const encryptedLen = NONCE_SIZE + plaintext.length + GCM_TAG_SIZE;

    // Build the header with the real fields, then zero the TTL byte for AAD.
    // TTL is excluded from authentication because relays decrement it.
    const headerForAAD = buildHeaderBytes({
      type: TYPE_MESSAGE,
      flags: FLAG_ENCRYPTED,
      ttl: DEFAULT_TTL,
      msgId,
      src: myFp,
      dst: peerFp,
      payloadLen: encryptedLen,
    });
    const aad = headerToAAD(headerForAAD);

    const encrypted = getCrypto().encrypt(peerFp, plaintext, aad);

    return encodeRawPacket(TYPE_MESSAGE, encrypted, {
      src: myFp,
      dst: peerFp,
      msgId,
      ttl: DEFAULT_TTL,
      flags: FLAG_ENCRYPTED,
      mtu: this.negotiatedMtu ?? undefined,
    });
  }

  private getMyFingerprint(): Uint8Array {
    // Phase 2 — fingerprint is SHA-256(pubkey)[:8], derived from the
    // X25519 keypair. The crypto service caches it after ensureIdentity().
    return getCrypto().getFingerprint();
  }

  /**
   * Phase 2 — Unified decode path for all incoming BLE traffic.
   *
   * Reassembles fragments, decodes the packet header, and — if the
   * FLAG_ENCRYPTED bit is set — decrypts the payload before body
   * deserialization. For HELLO packets, the fingerprint is derived from
   * the enclosed public key (done in `handleHandshakeReceived`).
   *
   * Returns null for: incomplete fragments, version mismatches, malformed
   * packets, and decryption failures (so a single bad chunk never kills
   * the monitor callback).
   */
  private decodeIncoming(base64Value: string, sourceKey: string): BLEPayload | null {
    const raw = decodeBLEChunkRaw(base64Value, sourceKey);
    if (!raw) return null;
    const { header, headerBytes, payload } = raw;

    if (header.flags & FLAG_ENCRYPTED) {
      // Encrypted MESSAGE — decrypt before body deserialization.
      try {
        const aad = headerToAAD(headerBytes);
        // header.src is the sender's fingerprint — the key we need to decrypt.
        const plaintext = getCrypto().decrypt(header.src, payload, aad);
        return decodeBody(header.type, plaintext);
      } catch (e: any) {
        console.warn('[BLE] Decrypt failed:', e?.message ?? e);
        return null;
      }
    }

    // Unencrypted (HELLO, ACK).
    try {
      return decodeBody(header.type, payload);
    } catch (e: any) {
      console.warn('[BLE] Body decode failed:', e?.message ?? e);
      return null;
    }
  }

  /**
   * Phase 2 — Process a received HELLO: derive the sender's fingerprint
   * from their public key, remember the shared key for encrypt/decrypt,
   * persist the peer (with TOFU key pinning), and emit discovery events.
   *
   * Called from both the peripheral side (write handler) and the central
   * side (handshake / message notification handler).
   */
  private handleHandshakeReceived(hp: HandshakePayload, bleId: string | null): void {
    // Derive the fingerprint from the public key (replaces the old
    // UUID-based deviceId). The HELLO body leaves deviceId empty; we
    // fill it in here.
    hp.deviceId = fingerprintHexFromPubKey(hp.publicKey);

    // Remember the peer's public key → derive + cache the shared AES key.
    const peerFp = getCrypto().rememberPeer(hp.publicKey);
    this.peerFingerprint = peerFp;

    const pubKeyHex = bytesToHex(hp.publicKey);

    // Trust-on-first-use: check if this fingerprint already has a different
    // pinned key. First contact pins the key; a changed key emits a warning.
    const keyStatus = checkPeerKeyChange(hp.deviceId, pubKeyHex);
    if (keyStatus === 'changed') {
      console.warn(
        `[BLE] KEY CHANGE WARNING: peer ${hp.displayName} (${hp.deviceId}) ` +
          `has a different public key than the pinned one. This could be a ` +
          `reinstall or a man-in-the-middle attempt.`,
      );
      this.keyWarning.emit({ deviceId: hp.deviceId, displayName: hp.displayName });
    } else if (keyStatus === 'unknown') {
      // New fingerprint. Check if the display name matches an existing peer
      // with a *different* fingerprint — that's the reinstall scenario
      // (same person, new keypair → new fingerprint). The old peer row
      // stays (history is preserved); we just warn the user.
      const existingByName = getAllPeers().find(
        p => p.displayName === hp.displayName && p.deviceId !== hp.deviceId,
      );
      if (existingByName) {
        console.warn(
          `[BLE] KEY CHANGE WARNING: "${hp.displayName}" has a new fingerprint ` +
            `(was ${existingByName.deviceId.slice(0, 8)}, now ${hp.deviceId.slice(0, 8)}). ` +
            `Likely a reinstall.`,
        );
        this.keyWarning.emit({ deviceId: hp.deviceId, displayName: hp.displayName });
      }
    }

    const peer: Peer = {
      deviceId: hp.deviceId,
      displayName: hp.displayName,
      lastSeen: Date.now(),
      rssi: null,
      bleId,
      publicKey: pubKeyHex,
      keyPinned: keyStatus !== 'unknown',
    };
    upsertPeer(peer);
    this.peerDiscovered.emit(peer);
    this.handshakeReceived.emit({ payload: hp, bleId });
  }

  // --- Cleanup ---

  async destroy() {
    this.stopScan();
    this.cleanupSubscriptions();
    this.connectedDevice = null;
    this.negotiatedMtu = null;
    this.peerFingerprint = null;
    await BlePeripheral.stop();
    this.peripheralStarted = false;
    this.manager.destroy();
  }
}

export const bleService = new BLEService();
