import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyButton } from "@/components/chunky";
import { DashboardView } from "@/components/dashboard-view";
import { DueList } from "@/components/due-list";
import { type Dashboard } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";

const FAILED = "We couldn't load your dashboard.";

export default function DashboardScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const { top } = useSafeAreaInsets();
  const [data, setData] = useState<Dashboard | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  // Bumped on every reload, so the safe-to-spend card fetches again with the dashboard.
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setVersion(mine);
    try {
      const result = await apiFetch<Dashboard>("/dashboard", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setData(result);
      setFailed(false);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setFailed(true); // keeps the last data, if any
    }
  }, [token, logOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const openAccounts = () => router.navigate("/accounts");

  if (data === null && !failed) {
    return (
      <View style={[styles.center, { paddingTop: top }]}>
        <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading dashboard" />
      </View>
    );
  }

  if (data === null) {
    return (
      <View style={[styles.center, { paddingTop: top }]}>
        <Text variant="bodyLarge" style={styles.centerText}>
          {FAILED}
        </Text>
        <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
      </View>
    );
  }

  return (
    <ScrollView
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      contentContainerStyle={styles.content}
    >
      <DashboardView
        data={data}
        failed={failed}
        onOpenAccounts={openAccounts}
        refreshKey={version}
        dueList={<DueList items={data.recurring ?? []} goals={data.goals_due ?? []} onChanged={() => void load()} />}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { paddingBottom: 24 },
});
