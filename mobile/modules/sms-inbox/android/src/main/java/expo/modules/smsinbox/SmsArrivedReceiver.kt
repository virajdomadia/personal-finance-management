package expo.modules.smsinbox

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.provider.Telephony
import android.util.Log

// Hears a new SMS arrive and lets the JavaScript side read the inbox. Nothing from the message is
// passed on: the sync reads the inbox itself from where it last stopped, and decides there which
// senders are banks. Only the sender's address is looked at here, to skip messages from people.
//
// In the front, with the app listening, the running app gets an `onSmsArrived` event. Otherwise a
// headless JS task runs ("SmsArrived", see SmsArrivedTaskService). SMS_RECEIVED is one of the
// implicit broadcasts Android 8+ still delivers to manifest receivers, and the system puts the
// receiving app on a short allowlist, which is what lets the service start from the background.
class SmsArrivedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    // A crash here would take the app down on every SMS, so nothing escapes.
    try {
      val received = intent ?: return
      if (received.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
      if (!fromBusinessSender(received)) return
      if (isInForeground() && SmsInboxModule.notifyRunningApp()) return
      startTask(context.applicationContext)
    } catch (error: Throwable) {
      Log.w(TAG, "Couldn't hand on an arrived SMS", error)
    }
  }

  // Banks send from letter headers ("VM-HDFCBK-S"); a phone number is a person and never a bank,
  // so it doesn't wake the app. Unreadable PDUs wake it anyway: the sync decides properly.
  private fun fromBusinessSender(intent: Intent): Boolean {
    val messages = try {
      Telephony.Sms.Intents.getMessagesFromIntent(intent)
    } catch (error: Throwable) {
      null
    }
    if (messages.isNullOrEmpty()) return true
    return messages.any { message ->
      val address = message?.originatingAddress ?: return@any true
      address.any { it.isLetter() }
    }
  }

  private fun isInForeground(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private fun startTask(context: Context) {
    // Keeps the phone awake until the service holds its own wake lock (HeadlessJsTaskService takes
    // one in startTask and releases it in onDestroy). Times out by itself, so it can't leak.
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val bridge = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Gullak:SmsArrived")
    bridge.setReferenceCounted(false)
    bridge.acquire(BRIDGE_WAKE_MS)
    try {
      context.startService(Intent(context, SmsArrivedTaskService::class.java))
    } catch (error: Throwable) {
      // Android refused a background start (no allowlist this time). The next app open reads it.
      if (bridge.isHeld) bridge.release()
      Log.w(TAG, "Couldn't start the SMS task", error)
    }
  }

  companion object {
    private const val TAG = "SmsArrivedReceiver"
    private const val BRIDGE_WAKE_MS = 15_000L
  }
}
