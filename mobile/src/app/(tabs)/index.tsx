import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Card, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DueList } from "@/components/due-list";
import { Signed } from "@/components/signed";
import { type Dashboard, formatDueDate, formatRupees } from "@/lib/accounts";
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

  const load = useCallback(async () => {
    const mine = ++latest.current;
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
        <Button mode="contained" onPress={() => void refresh()} loading={refreshing} disabled={refreshing}>
          Try again
        </Button>
      </View>
    );
  }

  const due = data.next_card_due;
  const used = data.credit_used;

  return (
    <ScrollView
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      contentContainerStyle={[styles.content, { paddingTop: top + 16 }]}
    >
      <Text variant="headlineSmall" accessibilityRole="header" style={styles.title}>
        Dashboard
      </Text>

      {failed ? (
        <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.error }}>
          {FAILED} Pull down to try again.
        </Text>
      ) : null}

      <Card mode="contained">
        <Card.Content style={styles.hero}>
          <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
            Net worth
          </Text>
          <Text variant="displaySmall" adjustsFontSizeToFit numberOfLines={1} style={styles.heroAmount}>
            {formatRupees(data.net_worth)}
          </Text>
          {data.investments ? (
            <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
              Includes investments at their latest price (or cost if no price yet)
            </Text>
          ) : null}
          {!data.has_accounts ? (
            <Button mode="contained" onPress={openAccounts} style={styles.addButton}>
              Add your first account
            </Button>
          ) : null}
        </Card.Content>
      </Card>

      <DueList items={data.recurring ?? []} onChanged={() => void load()} />

      {data.has_accounts ? (
        <>
          <Card mode="outlined" onPress={openAccounts} accessibilityRole="button">
            <Card.Content style={styles.figure}>
              <Text variant="labelLarge">You have</Text>
              <Text variant="titleLarge" style={styles.figureAmount}>
                {formatRupees(data.total_have)}
              </Text>
            </Card.Content>
          </Card>
          <Card mode="outlined" onPress={openAccounts} accessibilityRole="button">
            <Card.Content style={styles.figure}>
              <Text variant="labelLarge">You owe</Text>
              <Text variant="titleLarge" style={styles.figureAmount}>
                {formatRupees(data.total_owe)}
              </Text>
            </Card.Content>
          </Card>
        </>
      ) : null}

      {data.investments ? (
        <Card mode="outlined" onPress={() => router.navigate("/investments")} accessibilityRole="button">
          <Card.Content style={styles.investments}>
            <View style={styles.figure}>
              <Text variant="labelLarge">Investments</Text>
              <Text variant="titleLarge" style={styles.figureAmount}>
                {formatRupees(data.investments.value)}
              </Text>
            </View>
            <View style={styles.unrealised}>
              <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                Unrealised
              </Text>
              <Signed value={data.investments.unrealised} variant="bodySmall" />
              <Signed value={data.investments.unrealised_percent} percent variant="bodySmall" />
            </View>
          </Card.Content>
        </Card>
      ) : null}

      {due || used ? (
        <>
          <Text variant="titleSmall" accessibilityRole="header" style={{ color: colors.primary }}>
            Needs attention
          </Text>
          {due ? (
            <Card mode="outlined" onPress={openAccounts} accessibilityRole="button">
              <Card.Content>
                <Text variant="bodyLarge">
                  {due.name} due {formatDueDate(due.due_date)}
                </Text>
              </Card.Content>
            </Card>
          ) : null}
          {used ? (
            <Card mode="outlined" onPress={openAccounts} accessibilityRole="button">
              <Card.Content>
                <Text variant="bodyLarge">{used.percent}% of credit limit used</Text>
              </Card.Content>
            </Card>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  title: { marginBottom: 4 },
  hero: { gap: 6 },
  heroAmount: { fontWeight: "600" },
  addButton: { marginTop: 8, alignSelf: "flex-start" },
  figure: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  figureAmount: { flexShrink: 1, textAlign: "right" },
  investments: { gap: 4 },
  unrealised: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 },
});
