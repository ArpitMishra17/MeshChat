import { NativeModule, requireNativeModule } from 'expo';

type BlePeripheralEvents = {
  onDeviceConnected(event: { deviceAddress: string }): void;
  onDeviceDisconnected(event: { deviceAddress: string }): void;
  onCharacteristicWriteRequest(event: {
    deviceAddress: string;
    characteristicUUID: string;
    value: string;
  }): void;
};

declare class BlePeripheralNative extends NativeModule<BlePeripheralEvents> {
  startServer(serviceUUID: string, charUUIDs: string[]): Promise<string>;
  startAdvertising(serviceUUID: string, deviceName: string): Promise<string>;
  sendNotification(charUUID: string, base64Value: string): Promise<string>;
  /** Phase 3 — notify a single connected central by BLE MAC address. */
  sendNotificationToDevice(deviceAddress: string, charUUID: string, base64Value: string): Promise<string>;
  isAdvertising(): boolean;
  getConnectedDeviceCount(): number;
  /** Phase 3 — BLE MAC addresses of all centrals connected to our GATT server. */
  getConnectedDevices(): string[];
  /**
   * Feature batch — ATT MTU negotiated with a connected central, as reported by
   * onMtuChanged. Returns 23 (the BLE default) when unknown or disconnected.
   */
  getMtu(deviceAddress: string): number;
  stop(): Promise<string>;
  /**
   * Background relay — persist the "relay on" flag and start the foreground
   * service. Call only from the foreground (Android 12+ forbids starting a
   * foreground service from the background). Returns false on failure.
   */
  startRelayService(): boolean;
  /** Background relay — clear the flag and stop the foreground service. */
  stopRelayService(): boolean;
  /** Whether the user left the background relay enabled. */
  isRelayServiceEnabled(): boolean;
  /** Whether Android has exempted the app from battery optimisation. */
  isIgnoringBatteryOptimizations(): boolean;
  /** Opens the system battery-optimisation exemption prompt. */
  requestIgnoreBatteryOptimizations(): boolean;
}

export default requireNativeModule<BlePeripheralNative>('BlePeripheral');
