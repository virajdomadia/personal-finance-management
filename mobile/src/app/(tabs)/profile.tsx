import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView } from "react-native";

import { ProfileView } from "@/components/profile-view";
import { type Streak } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function ProfileScreen() {
  const { token, logOut } = useSession();
  const [streak, setStreak] = useState<number | null>(null);
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
        onGoals={() => router.push("/goals")}
        onRecurring={() => router.push("/recurring")}
        onInsurance={() => router.push("/insurance")}
        onArchived={() => router.push("/archived-accounts")}
        onLogOut={() => void logOut()}
      />
    </ScrollView>
  );
}
