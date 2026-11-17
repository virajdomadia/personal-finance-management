// Schedules the due reminders and posts the budget alerts planned by reminders.ts, each on its own
// Android channel. Both are off until turned on in Profile; the choice is kept per phone in
// SecureStore. They are refreshed when the app comes to the front and after an SMS sync (the
// background task too), so a paid bill drops out and a new one is picked up without a push server.
//
// expo-notifications is loaded only when this build has it (see native.ts). Every refresh swallows
// its own failures: a missed reminder must never break a screen or an SMS sync.

import * as SecureStore from "expo-secure-store";
import type * as NotificationsPackage from "expo-notifications";

import { apiFetch } from "@/lib/api";
import { BUDGETS_PATH, type BudgetMonth } from "@/lib/budgets";
import { loadNotifications } from "@/lib/native";
import {
  BUDGET_CHANNEL,
  BUDGET_PREF_KEY,
  BUDGET_SENT_KEY,
  DUE_CHANNEL,
  DUE_ID_PREFIX,
  DUE_PREF_KEY,
  type SentBudgetAlerts,
  parsePref,
  parseSent,
  planBudgetAlerts,
  planDueReminders,
  prefValue,
} from "@/lib/reminders";
import { UPCOMING_PATH, type Upcoming } from "@/lib/upcoming";

type Notifications = typeof NotificationsPackage;

export type ReminderKind = "due" | "budget";
export type EnableResult = "on" | "denied" | "blocked" | "needs-update";

const PREF_KEYS: Record<ReminderKind, string> = { due: DUE_PREF_KEY, budget: BUDGET_PREF_KEY };

export function readReminderPref(kind: ReminderKind): boolean {
  try {
    return parsePref(SecureStore.getItem(PREF_KEYS[kind]));
  } catch {
    return false;
  }
}

function savePref(kind: ReminderKind, on: boolean): void {
  try {
    SecureStore.setItem(PREF_KEYS[kind], prefValue(on));
  } catch {
    // Not remembered; it reads as off next time.
  }
}

function readSent(): SentBudgetAlerts | null {
  try {
    return parseSent(SecureStore.getItem(BUDGET_SENT_KEY));
  } catch {
    return null;
  }
}

function saveSent(sent: SentBudgetAlerts): void {
  try {
    SecureStore.setItem(BUDGET_SENT_KEY, JSON.stringify(sent));
  } catch {
    // An alert may be sent again; better than never.
  }
}

// Android 13+ shows the permission prompt only once a channel exists, so these come first.
async function ensureChannel(n: Notifications, kind: ReminderKind): Promise<void> {
  const channel = kind === "due" ? DUE_CHANNEL : BUDGET_CHANNEL;
  await n.setNotificationChannelAsync(channel.id, {
    name: channel.name,
    description: channel.description,
    importance: n.AndroidImportance.DEFAULT,
  });
}

async function granted(n: Notifications): Promise<boolean> {
  try {
    return (await n.getPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

// ---- Due reminders ----

async function cancelDue(n: Notifications): Promise<void> {
  const scheduled = await n.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((s) => s.identifier.startsWith(DUE_ID_PREFIX))
      .map((s) => n.cancelScheduledNotificationAsync(s.identifier).catch(() => {})),
  );
}

// Clears the old schedule and lays down a fresh one from the next 30 days. A failed fetch leaves
// the old schedule standing: stale reminders beat none.
async function scheduleDue(n: Notifications, token: string): Promise<void> {
  const upcoming = await apiFetch<Upcoming>(UPCOMING_PATH, { token, asOwner: true });
  const plan = planDueReminders(upcoming.items, new Date());
  await ensureChannel(n, "due");
  await cancelDue(n);
  for (const r of plan) {
    await n.scheduleNotificationAsync({
      identifier: r.id,
      content: { title: r.title, body: r.body, data: { url: r.url } },
      trigger: { type: n.SchedulableTriggerInputTypes.DATE, date: r.at, channelId: DUE_CHANNEL.id },
    });
  }
}

// ---- Budget alerts ----

async function budgetPlan(token: string) {
  const book = await apiFetch<BudgetMonth>(BUDGETS_PATH, { token, asOwner: true });
  return planBudgetAlerts(book, readSent(), new Date());
}

async function postBudgetAlerts(n: Notifications, token: string): Promise<void> {
  const { alerts, sent } = await budgetPlan(token);
  if (alerts.length > 0) {
    await ensureChannel(n, "budget");
    for (const a of alerts) {
      await n.scheduleNotificationAsync({
        identifier: a.id,
        content: { title: a.title, body: a.body, data: { url: a.url } },
        trigger: { channelId: BUDGET_CHANNEL.id },
      });
    }
  }
  saveSent(sent);
}

// ---- Turning them on and off ----

// Asks for permission when needed, then starts. "blocked" means Android won't ask again and the
// user has to allow notifications in the phone's settings.
export async function enableReminder(kind: ReminderKind, token: string): Promise<EnableResult> {
  const n = loadNotifications();
  if (n === null) return "needs-update";
  await ensureChannel(n, kind);
  let permission = await n.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await n.requestPermissionsAsync();
  if (!permission.granted) {
    savePref(kind, false);
    return permission.canAskAgain ? "denied" : "blocked";
  }
  savePref(kind, true);
  if (kind === "due") {
    await scheduleDue(n, token);
  } else {
    // Budgets already past a line when this is turned on are noted quietly, not announced in a
    // burst; the next one to cross a line is.
    const { sent } = await budgetPlan(token);
    saveSent(sent);
  }
  return "on";
}

export async function disableReminder(kind: ReminderKind): Promise<void> {
  savePref(kind, false);
  if (kind === "budget") return;
  const n = loadNotifications();
  if (n !== null) await cancelDue(n).catch(() => {});
}

// ---- Refreshing ----

let inFlight: Promise<void> | null = null;

// Reschedules the due reminders and posts any new budget alerts, for whichever are on. Joined, not
// repeated, while one is running. Never rejects.
export function refreshReminders(token: string): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const due = readReminderPref("due");
      const budget = readReminderPref("budget");
      if (!due && !budget) return;
      const n = loadNotifications();
      if (n === null || !(await granted(n))) return;
      await Promise.all([
        due ? scheduleDue(n, token).catch((e: unknown) => warn("due reminders", e)) : null,
        budget ? postBudgetAlerts(n, token).catch((e: unknown) => warn("budget alerts", e)) : null,
      ]);
    } catch (error) {
      warn("reminders", error);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function warn(what: string, error: unknown): void {
  if (__DEV__) console.warn(`Couldn't refresh ${what}`, error);
}
