package expo.modules.bleperipheral

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import android.app.Service
import android.os.IBinder
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener

/**
 * Keeps the mesh alive while the app is backgrounded or swiped away. It runs a
 * headless JS task ("MeshRelay") that starts the mesh services and keeps the JS
 * timers running. The foreground notification is what lets Android leave the
 * process (and its BLE work) alive.
 *
 * It deliberately does not extend RN's HeadlessJsTaskService: that class takes a
 * PARTIAL_WAKE_LOCK in a final method and holds it until the service dies, which
 * would keep the CPU awake for as long as the relay runs. BLE callbacks wake the
 * CPU on their own, so the task is started directly with no wake lock.
 */
class MeshRelayService : Service(), HeadlessJsTaskEventListener {

  private var taskContext: HeadlessJsTaskContext? = null

  /** Whether this service instance already started its headless JS task. */
  private var headlessStarted = false

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification()
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // Android 14+ throws SecurityException when Bluetooth runtime permissions are
      // missing. Starting without the foreground promotion is not allowed, so stop.
      Log.e(TAG, "startForeground failed, stopping relay service", e)
      stopSelf()
      return START_NOT_STICKY
    }

    // A redelivered or repeated start must not stack another headless task.
    if (!headlessStarted) {
      headlessStarted = true
      UiThreadUtil.runOnUiThread { startHeadlessTask() }
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  /** Start the "MeshRelay" JS task, booting the React instance first if needed. */
  private fun startHeadlessTask() {
    val host = (application as? ReactApplication)?.reactHost
    if (host == null) {
      Log.e(TAG, "no ReactHost, stopping relay service")
      stopSelf()
      return
    }
    val current = host.currentReactContext
    if (current != null) {
      runTask(current)
      return
    }
    host.addReactInstanceEventListener(object : ReactInstanceEventListener {
      override fun onReactContextInitialized(context: ReactContext) {
        host.removeReactInstanceEventListener(this)
        runTask(context)
      }
    })
    host.start()
  }

  private fun runTask(context: ReactContext) {
    val tasks = HeadlessJsTaskContext.getInstance(context)
    taskContext = tasks
    tasks.addTaskEventListener(this)
    UiThreadUtil.runOnUiThread {
      try {
        // timeout 0 = no limit; allowed in foreground because the service is promoted.
        tasks.startTask(HeadlessJsTaskConfig("MeshRelay", Arguments.createMap(), 0, true))
      } catch (e: Exception) {
        Log.e(TAG, "could not start MeshRelay task", e)
        stopSelf()
      }
    }
  }

  override fun onHeadlessJsTaskStart(taskId: Int) = Unit

  /** The JS task only returns when there is no identity yet: nothing to relay. */
  override fun onHeadlessJsTaskFinish(taskId: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    taskContext?.removeTaskEventListener(this)
    taskContext = null
    super.onDestroy()
  }

  private fun ensureChannel() {
    val channel = NotificationChannelCompat.Builder(
      CHANNEL_ID,
      NotificationManagerCompat.IMPORTANCE_LOW,
    )
      .setName("Background relay")
      .setDescription("Shown while MeshChat relays messages in the background")
      .setSound(null, null)
      .setShowBadge(false)
      .build()
    NotificationManagerCompat.from(this).createNotificationChannel(channel)
  }

  private fun buildNotification(): android.app.Notification {
    val smallIcon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon

    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(
        this, 0, it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("MeshChat relay on")
      .setContentText("Relaying messages for people nearby")
      .setSmallIcon(smallIcon)
      .setOngoing(true)
      .setSilent(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(contentIntent)
      .build()
  }

  companion object {
    private const val TAG = "MeshRelayService"
    const val CHANNEL_ID = "mesh_relay"
    const val NOTIFICATION_ID = 4711

    /** Preferences file and key that remember whether the relay should run. */
    const val PREFS_NAME = "meshchat_relay"
    const val PREF_ENABLED = "enabled"

    fun isEnabled(context: Context): Boolean =
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(PREF_ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
      context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        .edit().putBoolean(PREF_ENABLED, enabled).apply()
    }
  }
}
