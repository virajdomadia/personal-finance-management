import { router } from "expo-router";
import { useEffect, useRef } from "react";
import type { NotificationResponse } from "expo-notifications";

import { notificationTarget } from "@/lib/digest";
import { disableWeeklySummary, notifications, restoreWeeklySummary } from "@/lib/weekly-summary";

// A summary arriving while the app is open still shows as a normal notification. Set once, and only
// on a build that has expo-notifications.
let handlerSet = false;
function setHandler(): void {
  const n = notifications();
  if (n === null || handlerSet) return;
  n.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  handlerSet = true;
}

// Opens the digest screen when the weekly summary is tapped, from a cold start (the last response)
// or while running (the listener), and puts the schedule back on start if it should be there.
// Only once signed in: the digest is a signed-in screen, and the app lock still covers it. Logging
// out cancels the reminder, so the next person to sign in on this phone isn't nudged by it.
export function useWeeklySummary(loggedIn: boolean): void {
  const wasLoggedIn = useRef(loggedIn);

  useEffect(() => {
    setHandler();
  }, []);

  useEffect(() => {
    if (wasLoggedIn.current && !loggedIn) void disableWeeklySummary().catch(() => {});
    wasLoggedIn.current = loggedIn;
  }, [loggedIn]);

  useEffect(() => {
    const n = notifications();
    if (!loggedIn || n === null) return;
    let active = true;
    const open = (response: NotificationResponse | null) => {
      if (!active || response === null) return;
      if (response.actionIdentifier !== n.DEFAULT_ACTION_IDENTIFIER) return;
      const target = notificationTarget(response.notification.request.content.data);
      if (target === null) return;
      router.push(target);
      n.clearLastNotificationResponse();
    };
    open(n.getLastNotificationResponse());
    const subscription = n.addNotificationResponseReceivedListener(open);
    void restoreWeeklySummary().catch(() => {});
    return () => {
      active = false;
      subscription.remove();
    };
  }, [loggedIn]);
}
