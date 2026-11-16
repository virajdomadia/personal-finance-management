import { Tabs } from "expo-router";
import { useEffect } from "react";
import { useTheme } from "react-native-paper";

import { ChunkyTabBar } from "@/components/chunky-tab-bar";

import { ApiError, apiFetch } from "@/lib/api";
import { useProfile } from "@/lib/profile";
import { useSession } from "@/lib/session";
import { useSmsSync } from "@/lib/sms/use-sms-sync";

export default function TabsLayout() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const { profileKey } = useProfile();
  useSmsSync(); // the phone's SMS are always the owner's, whichever profile is chosen

  useEffect(() => {
    // The stored token can be revoked or expire, and only the API can tell.
    apiFetch("/auth/session", { token: token ?? undefined }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) void logOut();
    });
  }, [token, logOut]);

  return (
    // Keyed on the chosen profile: switching starts every tab afresh, so none shows the last
    // profile's figures.
    <Tabs
      key={profileKey}
      tabBar={(props) => <ChunkyTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Dashboard" }} />
      <Tabs.Screen name="accounts" options={{ title: "Accounts" }} />
      <Tabs.Screen name="transactions" options={{ title: "Transactions" }} />
      <Tabs.Screen name="investments" options={{ title: "Investments" }} />
      <Tabs.Screen name="family" options={{ title: "Family" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}
