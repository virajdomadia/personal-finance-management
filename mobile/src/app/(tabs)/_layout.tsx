import { Tabs } from "expo-router";
import type { BottomTabBarProps } from "expo-router/tabs";
import { useEffect } from "react";
import { BottomNavigation, useTheme } from "react-native-paper";

import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";

const TAB_ICONS: Record<string, { focusedIcon: string; unfocusedIcon: string }> = {
  index: { focusedIcon: "view-dashboard", unfocusedIcon: "view-dashboard-outline" },
  profile: { focusedIcon: "account", unfocusedIcon: "account-outline" },
};

function MaterialTabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  return (
    <BottomNavigation.Bar
      navigationState={{
        index: state.index,
        routes: state.routes.map((route) => ({
          key: route.key,
          title: descriptors[route.key].options.title,
          ...TAB_ICONS[route.name],
        })),
      }}
      safeAreaInsets={insets}
      onTabPress={({ route }) => {
        const event = emitter.emit({
          type: "tabPress",
          target: route.key,
          canPreventDefault: true,
        });
        const focused = state.routes[state.index].key === route.key;
        if (!focused && !event.defaultPrevented) navigateToTab(route.key);
      }}
    />
  );
}

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
      tabBar={(props) => <MaterialTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Dashboard" }} />
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}
