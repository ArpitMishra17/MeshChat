import { BleManager, Device, type Subscription } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import BlePeripheral from '../../modules/BlePeripheral';
import { ensureIdentity } from './identity';
import { upsertPeer } from '../db/database';
import { encodePayload, decodeChunk } from './protocol';
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

export type BLEState = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error';

type PeerDiscoveredCallback = (peer: Peer) => void;
type MessageReceivedCallback = (payload: MessagePayload) => void;
type AckReceivedCallback = (payload: AckPayload) => void;
type StateChangedCallback = (state: BLEState) => void;

class BLEService {
  private manager: BleManager;
  private scanning = false;
  private connectedDevice: Device | null = null;
  private subscriptions: Subscription[] = [];
  private state: BLEState = 'idle';
  private peripheralStarted = false;

  private onPeerDiscovered: PeerDiscoveredCallback | null = null;
  private onMessageReceived: MessageReceivedCallback | null = null;
  private onAckReceived: AckReceivedCallback | null = null;
  private onStateChanged: StateChangedCallback | null = null;

  private discoveredDevices = new Map<string, number>();
  public lastLog = '';

  constructor() {
    this.manager = new BleManager();
    this.setupPeripheralListeners();
  }

  // --- Peripheral (GATT Server) Setup ---

  private setupPeripheralListeners() {
    // Listen for writes from connected centrals (incoming messages)
    const writeSubscription = BlePeripheral.addListener(
      'onCharacteristicWriteRequest',
      (event: { characteristicUUID: string; value: string; deviceAddress: string }) => {
        console.log(`[BLE RECV] Write on ${event.characteristicUUID.slice(-4)} from ${event.deviceAddress.slice(-5)}, value len=${event.value?.length}`);
        try {
          const sourceKey = `${event.deviceAddress}_${event.characteristicUUID}`;
          const payload = this.decodeFromPeripheral(event.value, sourceKey);

          // payload is null if still assembling fragments
          if (!payload) return;

          console.log('[BLE Peripheral] Decoded payload:', payload.type);

          if (payload.type === 'message') {
            this.onMessageReceived?.(payload as MessagePayload);
          } else if (payload.type === 'ack') {
            this.onAckReceived?.(payload as AckPayload);
          } else if (payload.type === 'handshake') {
            const hp = payload as HandshakePayload;
            const peer: Peer = {
              deviceId: hp.deviceId,
              displayName: hp.displayName,
              lastSeen: Date.now(),
              rssi: null,
              bleId: event.deviceAddress,
            };
            upsertPeer(peer);
            this.onPeerDiscovered?.(peer);
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
        this.setState('idle');
      }
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

  // --- Listeners ---

  setOnPeerDiscovered(cb: PeerDiscoveredCallback | null) { this.onPeerDiscovered = cb; }
  setOnMessageReceived(cb: MessageReceivedCallback | null) { this.onMessageReceived = cb; }
  setOnAckReceived(cb: AckReceivedCallback | null) { this.onAckReceived = cb; }
  setOnStateChanged(cb: StateChangedCallback | null) { this.onStateChanged = cb; }

  getState(): BLEState { return this.state; }

  private setState(newState: BLEState) {
    this.state = newState;
    this.onStateChanged?.(newState);
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
      const timeout = setTimeout(() => {
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
            clearTimeout(timeout);
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
    this.manager.stopDeviceScan();
    this.scanning = false;
    this.setState('idle');
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
    };

    upsertPeer(peer);
    this.onPeerDiscovered?.(peer);
  }

  // --- Connection (Central connects to Peripheral) ---

  async connectToPeer(bleId: string): Promise<Device> {
    this.stopScan();
    this.setState('connecting');

    try {
      const device = await this.manager.connectToDevice(bleId, { timeout: 10000 });
      // Request larger MTU so payloads don't get truncated (default is 20 bytes)
      const mtuDevice = await device.requestMTU(512);
      console.log(`[BLE] Negotiated MTU: ${mtuDevice.mtu}`);
      await device.discoverAllServicesAndCharacteristics();
      this.connectedDevice = device;
      this.setState('connected');

      device.onDisconnected(() => {
        this.connectedDevice = null;
        this.cleanupSubscriptions();
        this.setState('idle');
      });

      await this.sendHandshake(device);
      this.subscribeToMessages(device);
      this.subscribeToAcks(device);

      return device;
    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connectedDevice) {
      try { await this.connectedDevice.cancelConnection(); } catch {}
      this.connectedDevice = null;
      this.cleanupSubscriptions();
      this.setState('idle');
    }
  }

  isConnected(): boolean {
    return this.connectedDevice !== null || BlePeripheral.getConnectedDeviceCount() > 0;
  }

  // --- Handshake ---

  private async sendHandshake(device: Device): Promise<void> {
    const identity = ensureIdentity();
    const payload: HandshakePayload = {
      type: 'handshake',
      deviceId: identity.deviceId,
      displayName: identity.displayName,
    };
    await this.writeFragments(device, HANDSHAKE_CHAR_UUID, payload);
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
    } catch {}
  }

  // --- Central subscriptions (listen to peripheral's notifications) ---

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
          const payload = decodeChunk(characteristic.value, `central_msg_${device.id}`);
          if (payload) {
            console.log('[BLE] Decoded message:', payload.type);
            if (payload.type === 'message') this.onMessageReceived?.(payload);
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
          const payload = decodeChunk(characteristic.value, `central_ack_${device.id}`);
          if (payload?.type === 'ack') this.onAckReceived?.(payload);
        } catch {}
      },
    );
    this.subscriptions.push(sub);
  }

  private cleanupSubscriptions() {
    this.subscriptions.forEach(s => s.remove());
    this.subscriptions = [];
  }

  // --- Encoding / Decoding via binary protocol with fragmentation ---

  private encodeFragments(payload: BLEPayload): string[] {
    return encodePayload(payload);
  }

  private decodeFromPeripheral(base64Value: string, sourceKey: string): BLEPayload | null {
    return decodeChunk(base64Value, sourceKey);
  }

  // --- Cleanup ---

  async destroy() {
    this.stopScan();
    this.cleanupSubscriptions();
    this.connectedDevice = null;
    await BlePeripheral.stop();
    this.peripheralStarted = false;
    this.manager.destroy();
  }
}

export const bleService = new BLEService();
