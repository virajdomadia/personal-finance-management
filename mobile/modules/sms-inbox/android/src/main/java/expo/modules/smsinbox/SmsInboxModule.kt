package expo.modules.smsinbox

import android.Manifest
import android.content.pm.PackageManager
import android.provider.Telephony
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SmsPermissionException : CodedException("ERR_SMS_PERMISSION", "READ_SMS permission is not granted", null)

// Reads received SMS newer than a time, oldest first, so a caller can page forward. Nothing
// else: no sending, no listening in the background. Which senders matter is decided in JavaScript.
class SmsInboxModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SmsInbox")

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
}
