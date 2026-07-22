import { BleManager, Device, type Subscription } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import BlePeripheral from '../../modules/BlePeripheral';
import { ensureIdentity, getCrypto } from './identity';
import { upsertPeer, checkPeerKeyChange, getAllPeers, getPeerByFingerprint } from '../db/database';
import {
  decodeBLEChunkRaw,
  decodeBody,
  encodeBody,
  encodePacket,
  buildHeaderBytes,
  headerToAAD,
  fragmentPacket,
  BROADCAST_DST,
  DEFAULT_TTL,
  TYPE_HELLO,
  TYPE_MESSAGE,
  TYPE_ACK,
  FLAG_ENCRYPTED,
  type PacketHeader,
} from './protocol';
import { fingerprintHexFromPubKey, NONCE_SIZE, GCM_TAG_SIZE } from './crypto';
import { generatePacketId, bytesToHex, hexToBytes } from './ids';
import type {
  Peer,
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
 * Phase 3 — A "link" is an established, HELLO-completed association with one
 * peer, keyed by their 8-byte fingerprint (hex). A link may carry up to two
 * underlying BLE transports:
 *
 *   - `central`: WE initiated `connectToDevice` and are the GATT client. We
 *     hold a ble-plx `Device`, a negotiated MTU, and per-characteristic
 *     monitor subscriptions. Sending on this side = `writeCharacteristic`.
 *
 *   - `peripheral`: THEY initiated a connection to our GATT server. We know
 *     only their BLE MAC (the `deviceAddress` from the native module).
 *     Sending on this side = `sendNotificationToDevice(address, ...)`.
 *
 * Both transports can coexist for the same peer (if both nodes connected to
 * each other simultaneously); we prefer the central side for sending because
 * of the larger negotiated MTU. The seen-cache in the relay engine makes the
 * resulting duplicate packets harmless.
 *
 * Before Phase 3 the service held ONE `connectedDevice`, ONE `peerFingerprint`,
 * and ONE `subscriptions[]` array — a single-link state machine. The mesh
 * needs N concurrent links, so all of that per-link state now lives here.
 */
interface Link {
  fingerprintHex: string;        // 16-char hex — primary key, the peer's identity
  fingerprint: Uint8Array;       // 8 bytes — for packet header src/dst
  displayName: string;
  central: CentralConn | null;   // we are the GATT client
  peripheralAddress: string | null; // we are the GATT server, they connected to us
  established: boolean;          // HELLO completed → linkUp fired
  lastSeen: number;
  rssi: number | null;
  connectedAt: number;
}

/** In-flight or established central-side connection to one BLE MAC. */
interface CentralConn {
  bleId: string;
  device: Device;
  mtu: number;
  subs: Subscription[];
  /** Set when the peer's HELLO arrives, so onDisconnected can detach the link. */
  fingerprintHex: string | null;
}

/** A chosen outbound transport for a link (central preferred over peripheral). */
type TransportRef =
  | { kind: 'central'; bleId: string; device: Device; mtu: number }
  | { kind: 'peripheral'; address: string; mtu: number | null };

/**
 * Phase 3 — A fully-decoded incoming packet handed to the relay engine.
 *
 * The relay engine (messageRouter) needs the whole packet (`packetBytes`) to
 * forward it (decrement TTL, re-fragment) and the raw `payloadBytes` to
 * decrypt MESSAGE bodies when they are addressed to us. `arrivalTransportKey`
 * identifies the BLE transport the packet came in on so we don't echo it back
 * out the same path when flooding.
 */
export interface IncomingPacket {
  header: PacketHeader;
  headerBytes: Uint8Array;       // first HEADER_SIZE bytes (for AAD computation)
  payloadBytes: Uint8Array;      // raw payload (encrypted for MESSAGE)
  packetBytes: Uint8Array;       // full packet — forward this, do NOT re-encode
  arrivalFingerprintHex: string | null; // peer fingerprint if HELLO completed
  arrivalTransportKey: string;   // bleId (central) or deviceAddress (peripheral)
}

export interface LinkEvent {
  fingerprintHex: string;
  displayName: string;
  rssi: number | null;
}

export interface NeighborInfo {
  fingerprintHex: string;
  displayName: string;
  rssi: number | null;
  lastSeen: number;
  hasCentral: boolean;
  hasPeripheral: boolean;
}

/**
 * Result of `connectToPeer`. The caller (NearbyScreen) awaits the handshake
 * exchange before opening a conversation, so the conversation is keyed on the
 * peer's real fingerprint — never on the rotating BLE MAC (P0.3).
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

  /** Phase 3 — the link pool. Keyed by peer fingerprint hex. */
  private links = new Map<string, Link>();
  /** Central-side connections keyed by BLE MAC (the ble-plx device id). */
  private centralConnections = new Map<string, CentralConn>();
  /** Transport key (bleId or deviceAddress) → peer fingerprint hex. Populated at HELLO. */
  private transportToFingerprint = new Map<string, string>();
  /** BLE MACs we are currently establishing a central connection to. */
  private connectingBleIds = new Set<string>();

  /** Dedupe scan hits within a 2 s window (Android re-advertises aggressively). */
  private discoveredDevices = new Map<string, number>();

  private state: BLEState = 'idle';
  private peripheralStarted = false;

  // P0.1 — multi-subscriber emitters so the MessageRouter (always-on) and a
  // mounted screen (ephemeral) can both listen without one clobbering the
  // other.
  readonly peerDiscovered = new PayloadEmitter<Peer>();
  /** Raw scan hits (BLE MAC, RSSI, advertising name) — not yet handshake'd. */
  readonly scanResult = new PayloadEmitter<Peer>();
  /** Phase 3 — fully-decoded incoming MESSAGE/ACK packets for the relay engine. */
  readonly packetReceived = new PayloadEmitter<IncomingPacket>();
  /** Phase 3 — link established (HELLO completed). */
  readonly linkUp = new PayloadEmitter<LinkEvent>();
  /** Phase 3 — both transports of a link dropped. */
  readonly linkDown = new PayloadEmitter<{ fingerprintHex: string }>();
  readonly handshakeReceived = new PayloadEmitter<{ payload: HandshakePayload; bleId: string | null }>();
  readonly stateChanged = new PayloadEmitter<BLEState>();
  /** Phase 2 — fires when a known peer's public key has changed (TOFU violation). */
  readonly keyWarning = new PayloadEmitter<{ deviceId: string; displayName: string }>();

  public lastLog = '';

  constructor() {
    this.manager = new BleManager();
    this.setupPeripheralListeners();
  }

  // --- Peripheral (GATT Server) Setup ---

  private setupPeripheralListeners() {
    // Phase 3 — single write handler for all three characteristics. Routes
    // each chunk through `handleIncomingChunk`, which defragments and either
    // processes the HELLO (link layer) or emits a packet for the relay engine.
    BlePeripheral.addListener(
      'onCharacteristicWriteRequest',
      (event: { characteristicUUID: string; value: string; deviceAddress: string }) => {
        console.log(
          `[BLE RECV] Write on ${event.characteristicUUID.slice(-4)} ` +
            `from ${event.deviceAddress.slice(-5)}, value len=${event.value?.length}`,
        );
        this.handleIncomingChunk(event.value, event.deviceAddress, event.characteristicUUID);
      },
    );

    BlePeripheral.addListener('onDeviceConnected', (event: { deviceAddress: string }) => {
      console.log('[BLE Peripheral] Central connected:', event.deviceAddress);
      this.recomputeState();
    });

    BlePeripheral.addListener('onDeviceDisconnected', (event: { deviceAddress: string }) => {
      console.log('[BLE Peripheral] Central disconnected:', event.deviceAddress);
      this.handlePeripheralDisconnected(event.deviceAddress);
    });
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

  // --- State ---

  subscribeState(cb: StateChangedCallback): () => void {
    return this.stateChanged.subscribe(cb);
  }

  getState(): BLEState { return this.state; }

  private setState(newState: BLEState) {
    if (this.state === newState) return;
    this.state = newState;
    this.stateChanged.emit(newState);
  }

  /**
   * Phase 3 — Derive the aggregate BLE state from the link pool. With multiple
   * links, 'connected' means "at least one established link"; 'connecting'
   * means a central-side connect is in flight and no link is up yet.
   */
  private recomputeState(): void {
    if (this.scanning) { this.setState('scanning'); return; }
    if (this.links.size > 0) { this.setState('connected'); return; }
    if (this.connectingBleIds.size > 0 || this.centralConnections.size > 0) {
      this.setState('connecting'); return;
    }
    this.setState('idle');
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
              this.handleScanResult(device);
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
    this.recomputeState();
  }

  private clearScanTimer(): void {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private handleScanResult(device: Device) {
    const now = Date.now();
    const name = device.localName || device.name || '';
    // Deduplicate by name (Android rotates BLE MAC addresses)
    const dedupeKey = name || device.id;
    const lastSeen = this.discoveredDevices.get(dedupeKey);
    if (lastSeen && now - lastSeen < 2000) return;
    this.discoveredDevices.set(dedupeKey, now);

    const peer: Peer = {
      deviceId: device.id, // BLE MAC — fingerprint is learned at HELLO time
      displayName: name,
      lastSeen: now,
      rssi: device.rssi,
      bleId: device.id,
      publicKey: null,
      keyPinned: false,
    };

    // Phase 2 — scan-discovered peers are NOT persisted to the DB. Their
    // real identity (fingerprint + pubkey) is only learned at handshake
    // time. Persisting a BLE MAC as deviceId would recreate the P0.3
    // identity-fragmentation bug. mesh.ts auto-connects; the Nearby screen
    // shows scan results live via the emitter.
    this.scanResult.emit(peer);
  }

  // --- Connection (Central connects to Peripheral) ---

  /**
   * Connect to a peer by BLE MAC and complete the mutual handshake before
   * returning. The caller must NOT create a conversation from the BLE MAC —
   * it should use the returned `handshake.deviceId` (fingerprint) instead.
   *
   * Phase 3 — multiple concurrent central connections are supported; each
   * lives in `centralConnections` keyed by BLE MAC and is attached to a
   * `Link` (keyed by fingerprint) once HELLO completes.
   */
  async connectToPeer(bleId: string): Promise<ConnectResult> {
    if (this.centralConnections.has(bleId) || this.connectingBleIds.has(bleId)) {
      throw new Error(`Already connected/connecting to ${bleId}`);
    }
    this.connectingBleIds.add(bleId);
    this.recomputeState();

    try {
      const device = await this.manager.connectToDevice(bleId, { timeout: 10000 });
      const mtuDevice = await device.requestMTU(512);
      const mtu = mtuDevice.mtu ?? 23;
      console.log(`[BLE] Negotiated MTU: ${mtu} with ${bleId.slice(-8)}`);
      await device.discoverAllServicesAndCharacteristics();

      const central: CentralConn = { bleId, device, mtu, subs: [], fingerprintHex: null };
      this.centralConnections.set(bleId, central);
      this.connectingBleIds.delete(bleId);

      device.onDisconnected(() => this.handleCentralDisconnected(bleId));

      // Subscribe to handshake (resolves on first HELLO) + ongoing MESSAGE/ACK
      // traffic for the life of this central connection.
      const handshakePromise = this.subscribeToHandshake(central);
      this.subscribeToTraffic(central);
      this.recomputeState();

      // Send our HELLO; the peripheral's HELLO arrives on the handshake char.
      await this.sendHelloCentral(central);

      const handshake = await handshakePromise;
      return { device, handshake };
    } catch (error) {
      this.connectingBleIds.delete(bleId);
      this.recomputeState();
      this.setState('error');
      throw error;
    }
  }

  private connectedBleIdsAdd(_bleId: string) { /* no-op placeholder kept for clarity */ }

  /**
   * Phase 3 — Disconnect a specific peer link (both transports). Used by the
   * neighbor manager to prune stale links if needed.
   */
  async disconnectLink(fingerprintHex: string): Promise<void> {
    const link = this.links.get(fingerprintHex);
    if (!link) return;
    if (link.central) {
      try { await link.central.device.cancelConnection(); } catch {}
      // onDisconnected handler will detach + prune.
    }
    if (link.peripheralAddress) {
      // The native module has no "kick this central" API; the link is pruned
      // locally and will be fully dropped when the central disconnects on its
      // own. Clear our side now so we stop sending to it.
      link.peripheralAddress = null;
      this.pruneLinkIfDead(link);
      this.recomputeState();
    }
  }

  isConnected(): boolean {
    return this.links.size > 0;
  }

  /** Phase 3 — Number of central-side GATT connections we hold. */
  getCentralConnectionCount(): number {
    return this.centralConnections.size;
  }

  /** Phase 3 — Snapshot of established links for the UI / mesh manager. */
  getNeighbors(): NeighborInfo[] {
    return Array.from(this.links.values())
      .filter(l => l.established)
      .map(l => ({
        fingerprintHex: l.fingerprintHex,
        displayName: l.displayName,
        rssi: l.rssi,
        lastSeen: l.lastSeen,
        hasCentral: !!l.central,
        hasPeripheral: !!l.peripheralAddress,
      }));
  }

  /** Phase 3 — True if we have an established link to this fingerprint. */
  hasLink(fingerprintHex: string): boolean {
    const l = this.links.get(fingerprintHex);
    return !!l && l.established;
  }

  // --- Handshake (HELLO) ---

  private async sendHelloCentral(central: CentralConn): Promise<void> {
    const packet = this.buildHelloPacket();
    const frags = fragmentPacket(packet, central.mtu);
    console.log(`[BLE] Sending HELLO (${frags.length} frag) to ${central.bleId.slice(-8)}`);
    for (const frag of frags) {
      await central.device.writeCharacteristicWithResponseForService(SERVICE_UUID, HANDSHAKE_CHAR_UUID, frag);
    }
  }

  /**
   * Phase 3 — Peripheral-side HELLO reply, addressed to the SPECIFIC central
   * that just wrote to us (not broadcast to all centrals). Uses the new
   * `sendNotificationToDevice` native overload (P0.8 / Phase 3 task 1).
   */
  private async sendHelloToPeripheral(deviceAddress: string): Promise<void> {
    const packet = this.buildHelloPacket();
    const frags = fragmentPacket(packet); // peripheral-side MTU unknown → default
    for (const frag of frags) {
      try {
        await BlePeripheral.sendNotificationToDevice(deviceAddress, HANDSHAKE_CHAR_UUID, frag);
      } catch (e: any) {
        console.warn('[BLE] notifyHello failed:', e?.message ?? e);
      }
    }
  }

  /**
   * P0.3 — Subscribe to the peripheral's handshake notification and resolve
   * with the first HELLO we receive. Times out after HANDSHAKE_TIMEOUT_MS.
   *
   * Phase 2 — the HELLO carries the peer's 32-byte public key; we derive the
   * fingerprint, remember the peer's shared key, and pin the pubkey (TOFU).
   *
   * Phase 3 — the subscription stays alive after the first HELLO so subsequent
   * re-handshakes (e.g. the peer reconnects) update the link. `processHello`
   * is idempotent for an established link.
   */
  private subscribeToHandshake(central: CentralConn): Promise<HandshakePayload> {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Handshake notification timeout'));
        }
      }, HANDSHAKE_TIMEOUT_MS);

      const sub = central.device.monitorCharacteristicForService(
        SERVICE_UUID, HANDSHAKE_CHAR_UUID,
        (error, characteristic) => {
          if (error) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              reject(error);
            }
            return;
          }
          if (!characteristic?.value) return;
          const raw = decodeBLEChunkRaw(characteristic.value, `${central.bleId}:${HANDSHAKE_CHAR_UUID}`);
          if (!raw || raw.header.type !== TYPE_HELLO) return;
          const hp = this.processHello(raw.payload, central.bleId, false);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(hp);
          }
        },
      );
      central.subs.push(sub);
    });
  }

  /** Phase 3 — Subscribe to MESSAGE/ACK notifications for the link's lifetime. */
  private subscribeToTraffic(central: CentralConn): void {
    for (const charUUID of [MESSAGE_CHAR_UUID, ACK_CHAR_UUID]) {
      const sub = central.device.monitorCharacteristicForService(
        SERVICE_UUID, charUUID,
        (error, characteristic) => {
          if (error) {
            console.warn(`[BLE] ${charUUID.slice(-4)} monitor error:`, error.message);
            return;
          }
          if (!characteristic?.value) return;
          this.handleIncomingChunk(characteristic.value, central.bleId, charUUID);
        },
      );
      central.subs.push(sub);
    }
  }

  // --- Incoming packet dispatch ---

  /**
   * Phase 3 — Unified defrag + dispatch for a single BLE chunk, from either
   * transport side. HELLO is consumed by the link layer (`processHello`);
   * MESSAGE/ACK are emitted raw via `packetReceived` for the relay engine.
   */
  private handleIncomingChunk(base64Value: string, transportKey: string, charUUID: string): void {
    // Reassembly buffers are per (transport, characteristic) so two messages
    // interleaved from the same peer on different chars don't corrupt each
    // other, and a stale buffer from char A can't be misassembled by char B.
    const sourceKey = `${transportKey}:${charUUID}`;
    const raw = decodeBLEChunkRaw(base64Value, sourceKey);
    if (!raw) return; // still assembling fragments, or malformed

    const { header, headerBytes, payload, packetBytes } = raw;

    if (header.type === TYPE_HELLO) {
      // Link-layer handshake. isPeripheralSide = we are NOT the central for
      // this transport (it arrived via a write to our GATT server).
      this.processHello(payload, transportKey, !this.centralConnections.has(transportKey));
      return;
    }

    // MESSAGE / ACK — hand to the relay engine with the raw packet bytes so
    // it can forward (decrement TTL + re-fragment) without re-encoding.
    const arrivalFingerprintHex = this.transportToFingerprint.get(transportKey) ?? null;
    this.packetReceived.emit({
      header,
      headerBytes,
      payloadBytes: payload,
      packetBytes,
      arrivalFingerprintHex,
      arrivalTransportKey: transportKey,
    });
  }

  /**
   * Phase 2 / Phase 3 — Process a received HELLO: derive the sender's
   * fingerprint from their public key, remember the shared key, persist the
   * peer (TOFU), create/update the link, and fire `linkUp` on first
   * establishment. On the peripheral side, reply with our own HELLO (addressed
   * to the specific central).
   *
   * Returns the handshake payload (with `deviceId` filled in) so the central
   * side's connect promise can resolve with it.
   */
  private processHello(
    helloBody: Uint8Array,
    transportKey: string,
    isPeripheralSide: boolean,
  ): HandshakePayload {
    let hp: HandshakePayload;
    try {
      hp = decodeBody(TYPE_HELLO, helloBody) as HandshakePayload;
    } catch (e: any) {
      console.warn('[BLE] Failed to decode HELLO body:', e?.message ?? e);
      throw e;
    }

    hp.deviceId = fingerprintHexFromPubKey(hp.publicKey);
    const peerFp = getCrypto().rememberPeer(hp.publicKey);
    const peerFpHex = hp.deviceId;
    const pubKeyHex = bytesToHex(hp.publicKey);

    // Trust-on-first-use: check if this fingerprint already has a different
    // pinned key. First contact pins the key; a changed key emits a warning.
    const keyStatus = checkPeerKeyChange(hp.deviceId, pubKeyHex);
    if (keyStatus === 'changed') {
      console.warn(
        `[BLE] KEY CHANGE WARNING: peer ${hp.displayName} (${hp.deviceId}) ` +
          `has a different public key than the pinned one.`,
      );
      this.keyWarning.emit({ deviceId: hp.deviceId, displayName: hp.displayName });
    } else if (keyStatus === 'unknown') {
      const existingByName = getAllPeers().find(
        p => p.displayName === hp.displayName && p.deviceId !== hp.deviceId,
      );
      if (existingByName) {
        console.warn(
          `[BLE] KEY CHANGE WARNING: "${hp.displayName}" has a new fingerprint ` +
            `(likely a reinstall).`,
        );
        this.keyWarning.emit({ deviceId: hp.deviceId, displayName: hp.displayName });
      }
    }

    // Create / update the link.
    let link = this.links.get(peerFpHex);
    const wasEstablished = link?.established ?? false;
    if (!link) {
      link = {
        fingerprintHex: peerFpHex,
        fingerprint: peerFp,
        displayName: hp.displayName,
        central: null,
        peripheralAddress: null,
        established: false,
        lastSeen: Date.now(),
        rssi: null,
        connectedAt: Date.now(),
      };
      this.links.set(peerFpHex, link);
    }
    link.displayName = hp.displayName;
    link.lastSeen = Date.now();
    this.transportToFingerprint.set(transportKey, peerFpHex);

    if (isPeripheralSide) {
      link.peripheralAddress = transportKey;
    } else {
      // Central side — attach the CentralConn we created in connectToPeer.
      const central = this.centralConnections.get(transportKey);
      if (central) {
        link.central = central;
        central.fingerprintHex = peerFpHex;
      }
    }

    if (!wasEstablished) {
      link.established = true;
      console.log(`[BLE] linkUp: ${hp.displayName} (${peerFpHex.slice(0, 8)})`);
      this.linkUp.emit({ fingerprintHex: peerFpHex, displayName: hp.displayName, rssi: link.rssi });
      this.recomputeState();
    }

    const peer: Peer = {
      deviceId: peerFpHex,
      displayName: hp.displayName,
      lastSeen: Date.now(),
      rssi: link.rssi,
      bleId: transportKey,
      publicKey: pubKeyHex,
      keyPinned: keyStatus !== 'unknown',
    };
    upsertPeer(peer);
    this.peerDiscovered.emit(peer);
    this.handshakeReceived.emit({ payload: hp, bleId: transportKey });

    // Peripheral side: reply with our HELLO so the central learns our identity.
    if (isPeripheralSide) {
      void this.sendHelloToPeripheral(transportKey);
    }

    return hp;
  }

  // --- Sending ---

  /**
   * Phase 3 — Send a chat message, end-to-end encrypted to `dstFingerprintHex`.
   * The packet is then FLOODED to every neighbor (broadcast to all links),
   * because in a mesh we don't know the path to the destination — relays
   * forward based on `dst` until it reaches the destination. If the
   * destination is a direct neighbor, it delivers locally on the first hop.
   *
   * For multi-hop, the destination's public key must already be in the peers
   * table (a prior direct encounter). `ensurePeerKey` re-derives the shared
   * AES key from the stored pubkey if it isn't cached in memory.
   */
  async sendMessage(message: MessagePayload, dstFingerprintHex: string): Promise<void> {
    const packet = this.buildMessagePacket(message, dstFingerprintHex);
    await this.broadcastPacket(packet);
  }

  /**
   * Phase 3 — Send an ACK (delivery receipt) addressed to the original sender
   * `dstFingerprintHex`. Like MESSAGE, ACKs are flooded — that's what makes
   * end-to-end `delivered` status work across hops. Plaintext: an ACK leaks
   * only the msgId already visible in the packet header.
   */
  async sendAck(messageId: string, dstFingerprintHex: string): Promise<void> {
    try {
      const packet = this.buildAckPacket(messageId, dstFingerprintHex);
      await this.broadcastPacket(packet);
    } catch (e: any) {
      console.warn(`[BLE] sendAck failed for ${messageId}:`, e?.message ?? e);
    }
  }

  /**
   * Phase 3 — Flood `packetBytes` to every established neighbor, optionally
   * excluding the transport the packet arrived on (so we don't echo it back).
   *
   * This is the relay engine's forward primitive AND the originator's send
   * primitive (an originated packet is just a flood with no exclusion). Each
   * link gets its own fragmentation pass sized to its MTU; the central side
   * (known MTU, often 512) gets bigger chunks than the peripheral side
   * (unknown MTU → default 18-byte chunks).
   */
  async broadcastPacket(packetBytes: Uint8Array, excludeTransportKey?: string): Promise<void> {
    const type = packetBytes[1];
    const charUUID = this.charForType(type);
    if (!charUUID) {
      console.warn(`[BLE] broadcastPacket: unknown packet type ${type}`);
      return;
    }

    const sends: Promise<void>[] = [];
    for (const link of this.links.values()) {
      if (!link.established) continue;
      const transport = this.preferredTransport(link);
      if (!transport) continue;
      if (excludeTransportKey && this.transportMatches(link, excludeTransportKey)) continue;
      const mtu = transport.kind === 'central' ? transport.mtu : null;
      const frags = fragmentPacket(packetBytes, mtu ?? undefined);
      sends.push(this.sendFragments(transport, charUUID, frags));
    }
    await Promise.all(sends);
  }

  private async sendFragments(
    transport: TransportRef,
    charUUID: string,
    frags: string[],
  ): Promise<void> {
    try {
      if (transport.kind === 'central') {
        for (const frag of frags) {
          await transport.device.writeCharacteristicWithResponseForService(SERVICE_UUID, charUUID, frag);
        }
      } else {
        for (const frag of frags) {
          await BlePeripheral.sendNotificationToDevice(transport.address, charUUID, frag);
        }
      }
    } catch (e: any) {
      console.warn(`[BLE] sendFragments (${transport.kind}) failed:`, e?.message ?? e);
    }
  }

  private charForType(type: number): string | null {
    switch (type) {
      case TYPE_HELLO: return HANDSHAKE_CHAR_UUID;
      case TYPE_MESSAGE: return MESSAGE_CHAR_UUID;
      case TYPE_ACK: return ACK_CHAR_UUID;
      default: return null;
    }
  }

  private preferredTransport(link: Link): TransportRef | null {
    // Prefer the central side: larger negotiated MTU → fewer fragments.
    if (link.central) {
      return { kind: 'central', bleId: link.central.bleId, device: link.central.device, mtu: link.central.mtu };
    }
    if (link.peripheralAddress) {
      return { kind: 'peripheral', address: link.peripheralAddress, mtu: null };
    }
    return null;
  }

  private transportMatches(link: Link, transportKey: string): boolean {
    if (link.central && link.central.bleId === transportKey) return true;
    if (link.peripheralAddress === transportKey) return true;
    return false;
  }

  // --- Packet construction ---

  private buildHelloPacket(): Uint8Array {
    const identity = ensureIdentity();
    const payload: HandshakePayload = {
      type: 'handshake',
      deviceId: identity.deviceId,
      displayName: identity.displayName,
      publicKey: identity.publicKey,
    };
    const body = encodeBody(payload);
    // ttl = 1: HELLO is link-local. The relay engine ignores HELLO anyway,
    // but a TTL of 1 documents intent — never relay a handshake.
    return encodePacket({
      type: TYPE_HELLO,
      flags: 0,
      ttl: 1,
      msgId: generatePacketId(),
      src: this.getMyFingerprint(),
      dst: BROADCAST_DST,
      payload: body,
    });
  }

  /**
   * Phase 2 / Phase 3 — Encrypt a MESSAGE end-to-end to `dstFingerprintHex`
   * and frame it as a v2 packet. The header (TTL zeroed) is bound as AAD so
   * a relay cannot alter src/dst/msgId without failing authentication.
   *
   * Phase 3 — the destination may be multiple hops away. `ensurePeerKey`
   * recovers the shared AES key from the peer's stored pubkey so we can
   * encrypt to a peer that isn't currently connected (but whom we've met
   * before — required for any TOFU-based mesh).
   */
  private buildMessagePacket(message: MessagePayload, dstFingerprintHex: string): Uint8Array {
    const myFp = this.getMyFingerprint();
    const peerFp = this.ensurePeerKey(dstFingerprintHex);
    const msgId = generatePacketId();
    const plaintext = encodeBody(message);

    const encryptedLen = NONCE_SIZE + plaintext.length + GCM_TAG_SIZE;
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

    return encodePacket({
      type: TYPE_MESSAGE,
      flags: FLAG_ENCRYPTED,
      ttl: DEFAULT_TTL,
      msgId,
      src: myFp,
      dst: peerFp,
      payload: encrypted,
    });
  }

  private buildAckPacket(messageId: string, dstFingerprintHex: string): Uint8Array {
    const myFp = this.getMyFingerprint();
    const dstFp = hexToBytes(dstFingerprintHex);
    const body = encodeBody({ type: 'ack', messageId } as AckPayload);
    return encodePacket({
      type: TYPE_ACK,
      flags: 0,
      ttl: DEFAULT_TTL,
      msgId: generatePacketId(),
      src: myFp,
      dst: dstFp,
      payload: body,
    });
  }

  private getMyFingerprint(): Uint8Array {
    return getCrypto().getFingerprint();
  }

  /**
   * Phase 3 — Recover the per-peer shared AES key for `fingerprintHex`,
   * re-deriving it from the stored pubkey if it isn't in the in-memory cache.
   * Multi-hop destinations aren't currently connected, so their key is usually
   * only in the DB (from a prior direct encounter). Throws if we have never
   * met this peer — without their pubkey we cannot encrypt end-to-end, and
   * mesh key-discovery is out of scope for Phase 3.
   */
  private ensurePeerKey(fingerprintHex: string): Uint8Array {
    const fp = hexToBytes(fingerprintHex);
    if (getCrypto().hasPeerKey(fp)) return fp;
    const peer = getPeerByFingerprint(fingerprintHex);
    if (!peer || !peer.publicKey) {
      throw new Error(
        `No public key for peer ${fingerprintHex.slice(0, 8)} — cannot encrypt ` +
          `(multi-hop destination never met; mesh key-discovery is out of scope)`,
      );
    }
    return getCrypto().rememberPeer(hexToBytes(peer.publicKey));
  }

  // --- Link teardown ---

  private handleCentralDisconnected(bleId: string): void {
    console.log(`[BLE] Central link down: ${bleId.slice(-8)}`);
    const central = this.centralConnections.get(bleId);
    if (central) {
      central.subs.forEach(s => s.remove());
      this.centralConnections.delete(bleId);
      if (central.fingerprintHex) {
        const link = this.links.get(central.fingerprintHex);
        if (link && link.central === central) {
          link.central = null;
          this.pruneLinkIfDead(link);
        }
      }
    }
    this.transportToFingerprint.delete(bleId);
    this.recomputeState();
  }

  private handlePeripheralDisconnected(deviceAddress: string): void {
    console.log(`[BLE] Peripheral link down: ${deviceAddress.slice(-5)}`);
    this.transportToFingerprint.delete(deviceAddress);
    for (const link of this.links.values()) {
      if (link.peripheralAddress === deviceAddress) {
        link.peripheralAddress = null;
        this.pruneLinkIfDead(link);
        break;
      }
    }
    this.recomputeState();
  }

  /**
   * Remove a link entirely once it has no transport left, firing `linkDown`
   * so the UI and relay engine stop considering it a neighbor.
   */
  private pruneLinkIfDead(link: Link): void {
    if (link.central || link.peripheralAddress) return;
    this.links.delete(link.fingerprintHex);
    if (link.established) {
      console.log(`[BLE] linkDown: ${link.displayName} (${link.fingerprintHex.slice(0, 8)})`);
      this.linkDown.emit({ fingerprintHex: link.fingerprintHex });
    }
  }

  // --- Cleanup ---

  async destroy() {
    this.stopScan();
    for (const central of this.centralConnections.values()) {
      central.subs.forEach(s => s.remove());
      try { await central.device.cancelConnection(); } catch {}
    }
    this.centralConnections.clear();
    this.links.clear();
    this.transportToFingerprint.clear();
    this.connectingBleIds.clear();
    await BlePeripheral.stop();
    this.peripheralStarted = false;
    this.manager.destroy();
  }
}

export const bleService = new BLEService();
