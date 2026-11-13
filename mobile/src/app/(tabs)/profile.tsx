import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView } from "react-native";

import { ProfileView } from "@/components/profile-view";
import { type Streak } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import { disableWeeklySummary, enableWeeklySummary, readSummaryPref } from "@/lib/weekly-summary";

const DENIED = "Notifications weren't allowed, so the summary stays off.";
const BLOCKED = "Notifications are off for Gullak. Allow them in your phone's settings, then turn this on again.";
const FAILED = "Couldn't set the reminder. Try again.";

export default function ProfileScreen() {
  const { token, logOut } = useSession();
  const [streak, setStreak] = useState<number | null>(null);
  const [summaryOn, setSummaryOn] = useState(readSummaryPref);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryNote, setSummaryNote] = useState<string | null>(null);

  // Asked only when the user turns it on; off cancels the schedule.
  const onSummary = async (on: boolean) => {
    setSummaryBusy(true);
    setSummaryNote(null);
    try {
      if (on) {
        const result = await enableWeeklySummary();
        setSummaryOn(result === "on");
        if (result === "denied") setSummaryNote(DENIED);
        if (result === "blocked") setSummaryNote(BLOCKED);
      } else {
        await disableWeeklySummary();
        setSummaryOn(false);
      }
    } catch {
      setSummaryOn(readSummaryPref());
      setSummaryNote(FAILED);
    } finally {
      setSummaryBusy(false);
    }
  };
  const latest = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const mine = ++latest.current;
      apiFetch<Streak>("/streak", { token: token ?? undefined }).then(
        (s) => {
          if (mine === latest.current) setStreak(s.days);
        },
        (err: unknown) => {
          if (mine !== latest.current) return;
          if (err instanceof ApiError && err.status === 401) void logOut();
        },
      );
    }, [token, logOut]),
  );

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
      <ProfileView
        streak={streak}
        summaryOn={summaryOn}
        summaryBusy={summaryBusy}
        summaryNote={summaryNote}
        onSummary={(on) => void onSummary(on)}
        onGoals={() => router.push("/goals")}
        onRecurring={() => router.push("/recurring")}
        onInsurance={() => router.push("/insurance")}
        onArchived={() => router.push("/archived-accounts")}
        onSms={() => router.push("/sms-settings")}
        onPayeeRules={() => router.push("/payee-rules")}
        onCategories={() => router.push("/categories")}
        onBudgets={() => router.push("/budgets")}
        onLogOut={() => void logOut()}
      />
    </ScrollView>
  );
}
