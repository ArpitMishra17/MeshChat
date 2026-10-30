package expo.modules.bleperipheral

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

@SuppressLint("MissingPermission")
class BlePeripheralModule : Module() {
  private val TAG = "BlePeripheral"

  /** Upper bound on how long one notification may wait for onNotificationSent. */
  private val NOTIFY_TIMEOUT_MS = 1000L
  /** ATT default MTU; what a central gets before any MTU exchange. */
  private val DEFAULT_ATT_MTU = 23

  private var gattServer: BluetoothGattServer? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var advertising = false
  private val connectedDevices = mutableSetOf<BluetoothDevice>()
  private val characteristics = mutableMapOf<String, BluetoothGattCharacteristic>()

  // Callbacks run on Binder threads while the module methods run on Expo's
  // async queue, so the maps touched from both sides must be concurrent.
  /** Device address -> ATT MTU reported by onMtuChanged. Absent = default 23. */
  private val mtuByAddress = ConcurrentHashMap<String, Int>()
  /** Device address -> the in-flight notification waiting for onNotificationSent. */
  private val notifyWaiters = ConcurrentHashMap<String, CompletableFuture<Int>>()
  /** Device address -> lock that keeps one notification in flight per central. */
  private val notifyLocks = ConcurrentHashMap<String, Any>()

  // Buffer for prepared (long) writes: device address -> (char uuid -> accumulated bytes)
  private val preparedWriteBuffers = mutableMapOf<String, MutableMap<String, ByteArrayOutputStream>>()

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context not available")

  private val bluetoothManager: BluetoothManager
    get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager

  private fun emitWrite(deviceAddress: String, charUUID: String, value: ByteArray) {
    val base64Value = Base64.encodeToString(value, Base64.NO_WRAP)
    Log.i(TAG, "Emitting write: char=$charUUID, ${value.size} bytes from $deviceAddress")
    sendEvent("onCharacteristicWriteRequest", mapOf(
      "deviceAddress" to deviceAddress,
      "characteristicUUID" to charUUID,
      "value" to base64Value
    ))
  }

  /**
   * Notify one connected central and wait (bounded) for the stack to confirm
   * the send. Throws if the notify is rejected, the confirmation times out, or
   * the stack reports a non-success status, so the JS caller sees the failure.
   *
   * The waiter is registered BEFORE notifying so a fast onNotificationSent
   * cannot be missed. The per-device lock keeps one notification in flight per
   * central, so a confirmation can only belong to the waiter that is current.
   */
  @Suppress("DEPRECATION")
  private fun notifyDevice(device: BluetoothDevice, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
    val server = gattServer ?: throw Exception("GATT server is not running")
    val lock = notifyLocks.getOrPut(device.address) { Any() }

    synchronized(lock) {
      val waiter = CompletableFuture<Int>()
      notifyWaiters[device.address] = waiter
      try {
        val queued = if (Build.VERSION.SDK_INT >= 33) {
          // API 33+ takes the value directly and returns a status code, so the
          // shared characteristic.value is never mutated here.
          server.notifyCharacteristicChanged(device, characteristic, false, value) ==
            BluetoothStatusCodes.SUCCESS
        } else {
          // Legacy API: the value lives on the shared characteristic, so set
          // and notify under one lock so another central cannot swap it between.
          synchronized(characteristic) {
            characteristic.value = value
            server.notifyCharacteristicChanged(device, characteristic, false)
          }
        }
        if (!queued) throw Exception("Notify rejected for ${device.address}")

        val status = try {
          waiter.get(NOTIFY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
          throw Exception("Notify confirmation timed out for ${device.address}")
        }
        if (status != BluetoothGatt.GATT_SUCCESS) {
          throw Exception("Notify failed for ${device.address}, status $status")
        }
      } finally {
        notifyWaiters.remove(device.address, waiter)
      }
    }
  }

  private val gattCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        Log.i(TAG, "Device connected: ${device.address}")
        connectedDevices.add(device)
        // A fresh link starts at the default MTU until onMtuChanged reports otherwise.
        mtuByAddress.remove(device.address)
        sendEvent("onDeviceConnected", mapOf("deviceAddress" to device.address))
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        Log.i(TAG, "Device disconnected: ${device.address}")
        connectedDevices.remove(device)
        preparedWriteBuffers.remove(device.address)
        mtuByAddress.remove(device.address)
        // Fail a pending notify now instead of letting it run into its timeout.
        notifyWaiters[device.address]?.complete(BluetoothGatt.GATT_FAILURE)
        sendEvent("onDeviceDisconnected", mapOf("deviceAddress" to device.address))
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice, requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean, responseNeeded: Boolean,
      offset: Int, value: ByteArray
    ) {
      Log.i(TAG, "Write request: char=${characteristic.uuid}, prepared=$preparedWrite, offset=$offset, ${value.size} bytes")

      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      }

      if (preparedWrite) {
        // Buffer the chunk for later assembly in onExecuteWrite
        val deviceBuffers = preparedWriteBuffers.getOrPut(device.address) { mutableMapOf() }
        val charKey = characteristic.uuid.toString()
        val buffer = deviceBuffers.getOrPut(charKey) { ByteArrayOutputStream() }
        buffer.write(value)
        Log.i(TAG, "Buffered ${value.size} bytes, total now: ${buffer.size()}")
      } else {
        // Regular (non-prepared) write — emit immediately
        characteristic.value = value
        emitWrite(device.address, characteristic.uuid.toString(), value)
      }
    }

    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
      Log.i(TAG, "Execute write: execute=$execute from ${device.address}")
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)

      val deviceBuffers = preparedWriteBuffers.remove(device.address) ?: return

      if (execute) {
        // Commit all buffered writes
        for ((charUUID, buffer) in deviceBuffers) {
          val fullValue = buffer.toByteArray()
          Log.i(TAG, "Assembled long write: char=$charUUID, ${fullValue.size} bytes")
          val characteristic = characteristics[charUUID.lowercase()]
          characteristic?.value = fullValue
          emitWrite(device.address, charUUID, fullValue)
        }
      }
      // If !execute, just discard the buffers (already removed above)
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice, requestId: Int,
      offset: Int, characteristic: BluetoothGattCharacteristic
    ) {
      gattServer?.sendResponse(
        device, requestId, BluetoothGatt.GATT_SUCCESS, offset,
        characteristic.value ?: ByteArray(0)
      )
    }

    override fun onDescriptorReadRequest(
      device: BluetoothDevice, requestId: Int,
      offset: Int, descriptor: BluetoothGattDescriptor
    ) {
      gattServer?.sendResponse(
        device, requestId, BluetoothGatt.GATT_SUCCESS, offset,
        descriptor.value ?: BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
      )
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice, requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean, responseNeeded: Boolean,
      offset: Int, value: ByteArray
    ) {
      descriptor.value = value
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
      }
    }

    override fun onNotificationSent(device: BluetoothDevice, status: Int) {
      Log.d(TAG, "Notification sent to ${device.address}, status: $status")
      notifyWaiters[device.address]?.complete(status)
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      Log.i(TAG, "MTU changed to $mtu for ${device.address}")
      mtuByAddress[device.address] = mtu
    }
  }

  override fun definition() = ModuleDefinition {
    Name("BlePeripheral")

    Events(
      "onDeviceConnected",
      "onDeviceDisconnected",
      "onCharacteristicWriteRequest"
    )

    AsyncFunction("startServer") { serviceUUID: String, charUUIDs: List<String> ->
      bluetoothManager.adapter ?: throw Exception("Bluetooth not available")

      gattServer = bluetoothManager.openGattServer(context, gattCallback)
        ?: throw Exception("Failed to open GATT server")

      val service = BluetoothGattService(
        UUID.fromString(serviceUUID),
        BluetoothGattService.SERVICE_TYPE_PRIMARY
      )

      for (charUUID in charUUIDs) {
        val characteristic = BluetoothGattCharacteristic(
          UUID.fromString(charUUID),
          BluetoothGattCharacteristic.PROPERTY_READ or
            BluetoothGattCharacteristic.PROPERTY_WRITE or
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
          BluetoothGattCharacteristic.PERMISSION_READ or
            BluetoothGattCharacteristic.PERMISSION_WRITE
        )

        val cccd = BluetoothGattDescriptor(
          UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"),
          BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
        )
        characteristic.addDescriptor(cccd)
        service.addCharacteristic(characteristic)
        characteristics[charUUID.lowercase()] = characteristic
      }

      gattServer?.addService(service)
      Log.i(TAG, "GATT server started")
      "Server started"
    }

    AsyncFunction("startAdvertising") { serviceUUID: String, deviceName: String ->
      val adapter = bluetoothManager.adapter
        ?: throw Exception("Bluetooth not available")

      adapter.name = deviceName
      Log.i(TAG, "Adapter name set to: ${adapter.name}")

      advertiser = adapter.bluetoothLeAdvertiser
        ?: throw Exception("BLE advertising not supported")

      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(true)
        .setTimeout(0)
        .build()

      val data = AdvertiseData.Builder()
        .setIncludeDeviceName(false)
        .addServiceUuid(ParcelUuid(UUID.fromString(serviceUUID)))
        .build()

      val scanResponse = AdvertiseData.Builder()
        .setIncludeDeviceName(true)
        .build()

      var resultMsg = "pending"
      val latch = java.util.concurrent.CountDownLatch(1)

      advertiser?.startAdvertising(settings, data, scanResponse, object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
          advertising = true
          resultMsg = "Advertising started as $deviceName"
          Log.i(TAG, "Advertising started successfully")
          latch.countDown()
        }

        override fun onStartFailure(errorCode: Int) {
          advertising = false
          val reason = when (errorCode) {
            ADVERTISE_FAILED_DATA_TOO_LARGE -> "data too large"
            ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "too many advertisers"
            ADVERTISE_FAILED_ALREADY_STARTED -> "already started"
            ADVERTISE_FAILED_INTERNAL_ERROR -> "internal error"
            ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "feature unsupported"
            else -> "unknown ($errorCode)"
          }
          resultMsg = "Advertising FAILED: $reason"
          Log.e(TAG, "Advertising failed: $reason")
          latch.countDown()
        }
      })

      // Wait up to 3 seconds for the callback
      latch.await(3, java.util.concurrent.TimeUnit.SECONDS)
      resultMsg
    }

    // Phase 0 (P0.8) — legacy broadcast notify. Retained for compatibility but
    // Phase 3 prefers the addressed `sendNotificationToDevice` overload so a
    // GATT server with several centrals doesn't broadcast every packet to all
    // of them (which would amplify floods and leak addressed traffic).
    AsyncFunction("sendNotification") { charUUID: String, base64Value: String ->
      val characteristic = characteristics[charUUID.lowercase()]
        ?: throw Exception("Characteristic $charUUID not found")

      val value = Base64.decode(base64Value, Base64.NO_WRAP)
      characteristic.value = value

      for (device in connectedDevices.toList()) {
        try {
          gattServer?.notifyCharacteristicChanged(device, characteristic, false)
        } catch (e: Exception) {
          Log.w(TAG, "Failed to notify ${device.address}: ${e.message}")
        }
      }
      "Notification sent to ${connectedDevices.size} devices"
    }

    /**
     * Phase 3 — Addressed notification. Notifies a single connected central
     * identified by `deviceAddress` (the BLE MAC we received in
     * `onCharacteristicWriteRequest` / `onDeviceConnected`). This is what
     * makes per-link sending possible on the peripheral side: a relay no longer
     * echoes a forwarded packet to every central, only to the intended next hop.
     *
     * Returns "sent" on success, or throws if the device is not connected /
     * the characteristic is unknown. A per-device failure (e.g. the central
     * has unsubscribed) is logged and counted but does not abort the call —
     * the caller treats the whole send as best-effort.
     */
    AsyncFunction("sendNotificationToDevice") { deviceAddress: String, charUUID: String, base64Value: String ->
      val characteristic = characteristics[charUUID.lowercase()]
        ?: throw Exception("Characteristic $charUUID not found")

      val value = Base64.decode(base64Value, Base64.NO_WRAP)

      val device = connectedDevices.find { it.address == deviceAddress }
        ?: throw Exception("Device $deviceAddress is not connected")

      try {
        notifyDevice(device, characteristic, value)
      } catch (e: Exception) {
        Log.w(TAG, "Failed to notify ${device.address}: ${e.message}")
        throw e
      }
      "sent"
    }

    /**
     * Feature batch — ATT MTU negotiated with a connected central. JS uses it to
     * size notification fragments (MTU minus the 3-byte ATT header). 23 means
     * unknown or no MTU exchange yet.
     */
    Function("getMtu") { deviceAddress: String ->
      mtuByAddress[deviceAddress] ?: DEFAULT_ATT_MTU
    }

    Function("isAdvertising") { advertising }

    Function("getConnectedDeviceCount") { connectedDevices.size }

    /**
     * Phase 3 — Addresses of every central currently connected to our GATT
     * server. Used by the link pool to map a peripheral-side transport back to
     * a peer fingerprint (learned at HELLO time) and to address per-device
     * notifications.
     */
    Function("getConnectedDevices") {
      connectedDevices.map { it.address }
    }

    AsyncFunction("stop") {
      try { advertiser?.stopAdvertising(null) } catch (_: Exception) {}
      advertising = false
      try { gattServer?.close() } catch (_: Exception) {}
      gattServer = null
      connectedDevices.clear()
      characteristics.clear()
      preparedWriteBuffers.clear()
      mtuByAddress.clear()
      // Release any notify still waiting so its caller fails now, not at timeout.
      for (waiter in notifyWaiters.values) waiter.complete(BluetoothGatt.GATT_FAILURE)
      notifyWaiters.clear()
      "Stopped"
    }
  }
}
