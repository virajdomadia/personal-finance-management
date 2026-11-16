// The headless JS task the native receiver runs when a bank SMS arrives while the app is in the
// background or closed (see modules/sms-inbox, SmsArrivedTaskService). No screen exists here: it
// reads the stored token and settings itself, runs the usual sync and posts notifications. The
// native side gives it 60 seconds and keeps the phone awake until it resolves.

import { AppRegistry, PermissionsAndroid } from "react-native";

import { readStoredToken } from "@/lib/stored-token";
import { SMS_ARRIVED_TASK, isAvailable, setReceiverEnabled } from "../../../modules/sms-inbox";

import { syncArrived } from "./runner";
import { loadSmsSettings } from "./settings";

export async function smsArrivedTask(): Promise<void> {
  try {
    if (!isAvailable()) return;
    const settings = await loadSmsSettings();
    const token = readStoredToken();
    // Signed out or reading off: stop being woken. Signing in or turning reading on enables the
    // receiver again (use-sms-sync.ts).
    if (token === null || !settings.enabled) {
      setReceiverEnabled(false);
      return;
    }
    if (!(await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS))) return;
    await syncArrived(token);
  } catch (error) {
    // Quiet: whatever wasn't sent is read on the next arrival or app open.
    if (__DEV__) console.warn("SMS arrival task failed", error);
  }
}

// Called from the entry file (index.js) before the app registers, so the task exists even when
// Android starts the JS runtime with no screen. Harmless on a build without the receiver.
export function registerSmsArrivedTask(): void {
  AppRegistry.registerHeadlessTask(SMS_ARRIVED_TASK, () => smsArrivedTask);
}
