import { Tabs } from "expo-router";
import { useEffect } from "react";
import { useTheme } from "react-native-paper";

import { ChunkyTabBar } from "@/components/chunky-tab-bar";

import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function TabsLayout() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();

  useEffect(() => {
    // The stored token can be revoked or expire, and only the API can tell.
    apiFetch("/auth/session", { token: token ?? undefined }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) void logOut();
    });
  }, [token, logOut]);

  return (
    <Tabs
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
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}
