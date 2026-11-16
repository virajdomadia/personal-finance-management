import { router } from "expo-router";
import { useEffect, useRef } from "react";
import type { NotificationResponse } from "expo-notifications";

import { loadNotifications } from "@/lib/native";
import { useProfile } from "@/lib/profile";

import { smsNoticeTarget } from "./notify";

// Opens what a tapped SMS notification is about: the recorded transaction, the To review item, or
// the Transactions or To review list. Works from a cold start too (the last response), like the
// weekly summary. Only once signed in; the app lock still covers the screen. SMS are always the
// owner's, so a family member being viewed is switched back to the owner first, or the screen
// would load that member's data.
export function useSmsNotificationTaps(loggedIn: boolean): void {
  const { profile, switchProfile } = useProfile();
  const viewingMember = useRef(profile !== null);

  useEffect(() => {
    viewingMember.current = profile !== null;
  }, [profile]);

  useEffect(() => {
    const n = loadNotifications();
    if (!loggedIn || n === null) return;
    let active = true;
    const open = (response: NotificationResponse | null) => {
      if (!active || response === null) return;
      if (response.actionIdentifier !== n.DEFAULT_ACTION_IDENTIFIER) return;
      const target = smsNoticeTarget(response.notification.request.content.data);
      if (target === null) return;
      n.clearLastNotificationResponse();
      if (viewingMember.current) {
        switchProfile(null);
        // After the tabs have started afresh for the owner.
        setTimeout(() => router.push(target as never), 0);
      } else {
        router.push(target as never);
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
