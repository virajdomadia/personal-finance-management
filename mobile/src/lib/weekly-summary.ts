// The weekly summary reminder: a local, repeating expo-notifications notification on Sunday at
// 7 pm (phone time). No push server and no FCM: the phone schedules it itself. It is off until the
// user turns it on in Profile; the choice is kept per phone in SecureStore.

import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import * as SecureStore from "expo-secure-store";

import { SUMMARY_PREF_KEY, WEEKLY_SUMMARY, parseSummaryPref, summaryPrefValue } from "@/lib/digest";

export type EnableResult = "on" | "denied" | "blocked";

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
async function ensureChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(WEEKLY_SUMMARY.channelId, {
    name: WEEKLY_SUMMARY.channelName,
    description: "A Sunday evening nudge to look at your week",
    importance: AndroidImportance.DEFAULT,
  });
}

// Replaces any earlier schedule under our identifier, so calling it twice never doubles up.
async function schedule(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(WEEKLY_SUMMARY.id).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    identifier: WEEKLY_SUMMARY.id,
    content: {
      title: WEEKLY_SUMMARY.title,
      body: WEEKLY_SUMMARY.body,
      data: { url: WEEKLY_SUMMARY.url },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
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
  await ensureChannel();
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) {
    saveSummaryPref(false);
    return permission.canAskAgain ? "denied" : "blocked";
  }
  await schedule();
  saveSummaryPref(true);
  return "on";
}

export async function disableWeeklySummary(): Promise<void> {
  saveSummaryPref(false);
  await Notifications.cancelScheduledNotificationAsync(WEEKLY_SUMMARY.id).catch(() => {});
}

// On app start: a stored "on" puts the schedule back if it went missing (a reinstall restore, an
// OS that dropped it). Permission taken away in settings turns the switch off instead.
export async function restoreWeeklySummary(): Promise<void> {
  if (!readSummaryPref()) return;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) {
    saveSummaryPref(false);
    return;
  }
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  if (!scheduled.some((n) => n.identifier === WEEKLY_SUMMARY.id)) {
    await ensureChannel();
    await schedule();
  }
}
