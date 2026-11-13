import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";

import { notificationTarget } from "@/lib/digest";
import { disableWeeklySummary, restoreWeeklySummary } from "@/lib/weekly-summary";

// A summary arriving while the app is open still shows as a normal notification.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Opens the digest screen when the weekly summary is tapped, from a cold start (the last response)
// or while running (the listener), and puts the schedule back on start if it should be there.
// Only once signed in: the digest is a signed-in screen, and the app lock still covers it. Logging
// out cancels the reminder, so the next person to sign in on this phone isn't nudged by it.
export function useWeeklySummary(loggedIn: boolean): void {
  const wasLoggedIn = useRef(loggedIn);

  useEffect(() => {
    if (wasLoggedIn.current && !loggedIn) void disableWeeklySummary().catch(() => {});
    wasLoggedIn.current = loggedIn;
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    let active = true;
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!active || response === null) return;
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const target = notificationTarget(response.notification.request.content.data);
      if (target === null) return;
      router.push(target);
      Notifications.clearLastNotificationResponse();
    };
    open(Notifications.getLastNotificationResponse());
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    void restoreWeeklySummary().catch(() => {});
    return () => {
      active = false;
      subscription.remove();
    };
  }, [loggedIn]);
}
