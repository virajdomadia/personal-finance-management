import { router } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { NotificationResponse } from "expo-notifications";

import { loadNotifications } from "@/lib/native";
import { useProfile } from "@/lib/profile";
import { disableReminder, refreshReminders } from "@/lib/reminder-schedule";
import { reminderTarget } from "@/lib/reminders";

// Coming back to the app more often than this doesn't refetch.
const REFRESH_EVERY_MS = 10 * 60 * 1000;

// Keeps the due reminders and budget alerts current while signed in: on start and whenever the app
// comes back to the front. Opens Upcoming or Budgets when one is tapped, switching back to the
// owner first (they are always the owner's). Logging out turns both off, so the next person to sign
// in on this phone isn't reminded of someone else's bills.
export function useReminders(token: string | null): void {
  const loggedIn = token !== null;
  const wasLoggedIn = useRef(loggedIn);
  const lastRefresh = useRef(0);
  const { profile, switchProfile } = useProfile();
  const viewingMember = useRef(profile !== null);

  useEffect(() => {
    viewingMember.current = profile !== null;
  }, [profile]);

  useEffect(() => {
    if (wasLoggedIn.current && !loggedIn) {
      void disableReminder("due").catch(() => {});
      void disableReminder("budget").catch(() => {});
    }
    wasLoggedIn.current = loggedIn;
  }, [loggedIn]);

  useEffect(() => {
    if (token === null) return;
    const refresh = () => {
      if (Date.now() - lastRefresh.current < REFRESH_EVERY_MS) return;
      lastRefresh.current = Date.now();
      void refreshReminders(token);
    };
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      subscription.remove();
      lastRefresh.current = 0;
    };
  }, [token]);

  useEffect(() => {
    const n = loadNotifications();
    if (!loggedIn || n === null) return;
    let active = true;
    const open = (response: NotificationResponse | null) => {
      if (!active || response === null) return;
      if (response.actionIdentifier !== n.DEFAULT_ACTION_IDENTIFIER) return;
      const target = reminderTarget(response.notification.request.content.data);
      if (target === null) return;
      n.clearLastNotificationResponse();
      if (viewingMember.current) {
        switchProfile(null);
        // After the tabs have started afresh for the owner.
        setTimeout(() => router.push(target), 0);
      } else {
        router.push(target);
      }
    };
    open(n.getLastNotificationResponse());
    const subscription = n.addNotificationResponseReceivedListener(open);
    return () => {
      active = false;
      subscription.remove();
    };
  }, [loggedIn, switchProfile]);
}
