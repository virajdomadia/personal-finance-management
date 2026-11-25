// Posts the SMS notifications planned by notify.ts, on their own Android channel, and asks for the
// permission to. expo-notifications is loaded only when this build has it (see native.ts); without
// it nothing is posted and the setting says the app needs updating.

import type * as NotificationsPackage from "expo-notifications";

import { loadNotifications } from "@/lib/native";
import { ensurePrivateChannel } from "@/lib/notification-channels";

import { SMS_CHANNEL, type SmsNotice, noticeData } from "./notify";

type Notifications = typeof NotificationsPackage;

export type PermissionResult = "granted" | "denied" | "blocked" | "needs-update";

// Android 13+ asks for notification permission only once a channel exists, so this comes first.
async function ensureChannel(n: Notifications): Promise<void> {
  await ensurePrivateChannel(n, SMS_CHANNEL);
}

// Asks for notification permission when it can. "blocked" means Android won't ask again.
export async function askNotificationPermission(): Promise<PermissionResult> {
  const n = loadNotifications();
  if (n === null) return "needs-update";
  await ensureChannel(n);
  let permission = await n.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await n.requestPermissionsAsync();
  if (permission.granted) return "granted";
  return permission.canAskAgain ? "denied" : "blocked";
}

export async function notificationsAllowed(): Promise<boolean> {
  const n = loadNotifications();
  if (n === null) return false;
  try {
    return (await n.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

// Shows each notice now. Never asks for permission (this may run with no screen); without it,
// nothing is shown. Failures are swallowed: a missed notification must not fail the sync.
export async function postNotices(notices: SmsNotice[]): Promise<void> {
  if (notices.length === 0) return;
  const n = loadNotifications();
  if (n === null) return;
  try {
    if (!(await n.getPermissionsAsync()).granted) return;
    await ensureChannel(n);
    for (const notice of notices) {
      await n.scheduleNotificationAsync({
        identifier: notice.id,
        content: { title: notice.title, body: notice.body, data: noticeData(notice) },
        trigger: { channelId: SMS_CHANNEL.id },
      });
    }
  } catch (error) {
    if (__DEV__) console.warn("Couldn't post SMS notifications", error);
  }
}
