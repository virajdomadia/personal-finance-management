package expo.modules.smsinbox

import android.Manifest
import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Telephony
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

class SmsPermissionException : CodedException("ERR_SMS_PERMISSION", "READ_SMS permission is not granted", null)

// Reads received SMS newer than a time, oldest first, so a caller can page forward, and says when a
// new SMS arrives (SmsArrivedReceiver): an `onSmsArrived` event while the app is in the front, a
// headless JS task otherwise. Nothing from the message travels with either; the JavaScript side
// reads the inbox itself and decides there which senders matter. No sending.
class SmsInboxModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SmsInbox")

    // Lets JavaScript tell this build from one made before the receiver existed.
    Constant("receivesSms") { true }

    Events(ARRIVED_EVENT)

    OnStartObserving(ARRIVED_EVENT) {
      listening = WeakReference(this@SmsInboxModule)
    }

    OnStopObserving(ARRIVED_EVENT) {
      if (listening?.get() === this@SmsInboxModule) listening = null
    }

    OnDestroy {
      if (listening?.get() === this@SmsInboxModule) listening = null
    }

    // The receiver is off in the manifest and turned on only while SMS reading is on.
    Function("setReceiverEnabled") { enabled: Boolean ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val state =
        if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      context.packageManager.setComponentEnabledSetting(
        ComponentName(context, SmsArrivedReceiver::class.java),
        state,
        PackageManager.DONT_KILL_APP
      )
    }

    AsyncFunction("readInbox") { sinceMillis: Double, limit: Int ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      if (context.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
        throw SmsPermissionException()
      }
      val messages = mutableListOf<Map<String, Any>>()
      val projection = arrayOf(
        Telephony.Sms._ID,
        Telephony.Sms.ADDRESS,
        Telephony.Sms.BODY,
        Telephony.Sms.DATE
      )
      context.contentResolver.query(
        Telephony.Sms.Inbox.CONTENT_URI,
        projection,
        "${Telephony.Sms.DATE} > ?",
        arrayOf(sinceMillis.toLong().toString()),
        "${Telephony.Sms.DATE} ASC"
      )?.use { cursor ->
        val idColumn = cursor.getColumnIndexOrThrow(Telephony.Sms._ID)
        val addressColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
        val bodyColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
        val dateColumn = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
        // The limit is applied here rather than in the sort order, which some providers reject.
        while (messages.size < limit && cursor.moveToNext()) {
          messages.add(
            mapOf(
              "id" to cursor.getLong(idColumn).toString(),
              "address" to (cursor.getString(addressColumn) ?: ""),
              "body" to (cursor.getString(bodyColumn) ?: ""),
              "date" to cursor.getLong(dateColumn).toDouble()
            )
          )
        }
      }
      messages
    }
  }

  companion object {
    const val ARRIVED_EVENT = "onSmsArrived"
    private const val TAG = "SmsInboxModule"

    // The module whose JavaScript is listening for arrivals, if any.
    @Volatile
    private var listening: WeakReference<SmsInboxModule>? = null

    // Tells the running app an SMS arrived. False when nothing is listening (signed out, or the
    // runtime is gone), so the caller runs the headless task instead.
    fun notifyRunningApp(): Boolean {
      val module = listening?.get() ?: return false
      return try {
        module.sendEvent(ARRIVED_EVENT, Bundle())
        true
      } catch (error: Throwable) {
        Log.w(TAG, "Couldn't tell the app an SMS arrived", error)
        false
      }
    }
  }
}
