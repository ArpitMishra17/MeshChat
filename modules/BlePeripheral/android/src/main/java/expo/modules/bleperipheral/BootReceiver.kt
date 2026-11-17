package expo.modules.bleperipheral

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Restarts the relay service after a reboot or an app update, if the user left
 * the background relay enabled.
 */
class BootReceiver : BroadcastReceiver() {

  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (!MeshRelayService.isEnabled(context)) return

    try {
      val service = Intent(context, MeshRelayService::class.java)
      if (Build.VERSION.SDK_INT >= 26) {
        context.startForegroundService(service)
      } else {
        context.startService(service)
      }
    } catch (e: Exception) {
      Log.w("BootReceiver", "Could not start relay service after $action", e)
    }
  }
}
