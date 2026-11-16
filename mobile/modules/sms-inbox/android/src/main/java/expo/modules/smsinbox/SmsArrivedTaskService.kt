package expo.modules.smsinbox

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

// Runs the JavaScript task "SmsArrived" without any screen: it reads the inbox through the usual
// sync and posts notifications. HeadlessJsTaskService starts React Native if it isn't running (in
// bridgeless mode through the app's ReactHost) and holds a wake lock until the task finishes or
// times out.
class SmsArrivedTaskService : HeadlessJsTaskService() {
  private val handler = Handler(Looper.getMainLooper())
  // A last resort: if React Native never starts, the task's own timeout never runs either.
  private val giveUp = Runnable { stopSelf() }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    // Allowed in the foreground too: the app may come to the front while the task starts, and a
    // task refused there would throw on the UI thread.
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), TIMEOUT_MS, true)

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    handler.removeCallbacks(giveUp)
    handler.postDelayed(giveUp, TIMEOUT_MS + GRACE_MS)
    try {
      super.onStartCommand(intent, flags, startId)
    } catch (error: Throwable) {
      Log.w(TAG, "Couldn't start the SMS task", error)
      stopSelf()
    }
    // Not redelivered after the process dies: the next arrival or app open reads the inbox anyway.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(giveUp)
    try {
      super.onDestroy()
    } catch (error: Throwable) {
      Log.w(TAG, "Couldn't stop the SMS task cleanly", error)
    }
  }

  companion object {
    const val TASK_NAME = "SmsArrived"
    private const val TAG = "SmsArrivedTaskService"
    private const val TIMEOUT_MS = 60_000L
    private const val GRACE_MS = 30_000L
  }
}
