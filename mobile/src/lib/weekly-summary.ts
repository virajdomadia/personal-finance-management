// The weekly summary reminder: a local, repeating expo-notifications notification on Sunday at
// 7 pm (phone time). No push server and no FCM: the phone schedules it itself. It is off until the
// user turns it on in Profile; the choice is kept per phone in SecureStore.
//
// expo-notifications is loaded only when this build has its native modules (see native.ts). An
// older build without them keeps working; the reminder just can't be turned on there.

import * as SecureStore from "expo-secure-store";
import type * as NotificationsPackage from "expo-notifications";

import { SUMMARY_PREF_KEY, WEEKLY_SUMMARY, parseSummaryPref, summaryPrefValue } from "@/lib/digest";
import { loadNotifications } from "@/lib/native";

export type EnableResult = "on" | "denied" | "blocked" | "needs-update";

type Notifications = typeof NotificationsPackage;

// The package, or null on a build that doesn't have it.
export function notifications(): Notifications | null {
  return loadNotifications();
}

export function readSummaryPref(): boolean {
  try {
    return parseSummaryPref(SecureStore.getItem(SUMMARY_PREF_KEY));
  } catch {
    return false;
  }
}

function saveSummaryPref(on: boolean): void {
  try {
    SecureStore.setItem(SUMMARY_PREF_KEY, summaryPrefValue(on));
  } catch {
    // Not remembered; the schedule itself still stands until it is cancelled.
  }
}

// Android 13+ shows the permission prompt only once a channel exists, so this comes first.
async function ensureChannel(n: Notifications): Promise<void> {
  await n.setNotificationChannelAsync(WEEKLY_SUMMARY.channelId, {
    name: WEEKLY_SUMMARY.channelName,
    description: "A Sunday evening nudge to look at your week",
    importance: n.AndroidImportance.DEFAULT,
  });
}

// Replaces any earlier schedule under our identifier, so calling it twice never doubles up.
async function schedule(n: Notifications): Promise<void> {
  await n.cancelScheduledNotificationAsync(WEEKLY_SUMMARY.id).catch(() => {});
  await n.scheduleNotificationAsync({
    identifier: WEEKLY_SUMMARY.id,
    content: {
      title: WEEKLY_SUMMARY.title,
      body: WEEKLY_SUMMARY.body,
      data: { url: WEEKLY_SUMMARY.url },
    },
    trigger: {
      type: n.SchedulableTriggerInputTypes.WEEKLY,
      weekday: WEEKLY_SUMMARY.weekday,
      hour: WEEKLY_SUMMARY.hour,
      minute: WEEKLY_SUMMARY.minute,
      channelId: WEEKLY_SUMMARY.channelId,
    },
  });
}

// Asks for permission when needed, then schedules. "blocked" means Android won't ask again and the
// user has to allow notifications in the phone's settings.
export async function enableWeeklySummary(): Promise<EnableResult> {
  const n = notifications();
  if (n === null) return "needs-update";
  await ensureChannel(n);
  let permission = await n.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await n.requestPermissionsAsync();
  if (!permission.granted) {
    saveSummaryPref(false);
    return permission.canAskAgain ? "denied" : "blocked";
  }
  await schedule(n);
  saveSummaryPref(true);
  return "on";
}

export async function disableWeeklySummary(): Promise<void> {
  saveSummaryPref(false);
  const n = notifications();
  if (n === null) return;
  await n.cancelScheduledNotificationAsync(WEEKLY_SUMMARY.id).catch(() => {});
}

// On app start: a stored "on" puts the schedule back if it went missing (a reinstall restore, an
// OS that dropped it). Permission taken away in settings turns the switch off instead.
export async function restoreWeeklySummary(): Promise<void> {
  if (!readSummaryPref()) return;
  const n = notifications();
  if (n === null) return;
  const permission = await n.getPermissionsAsync();
  if (!permission.granted) {
    saveSummaryPref(false);
    return;
  }
  const scheduled = await n.getAllScheduledNotificationsAsync();
  if (!scheduled.some((s) => s.identifier === WEEKLY_SUMMARY.id)) {
    await ensureChannel(n);
    await schedule(n);
  }
}
