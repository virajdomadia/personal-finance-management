import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Appbar, Button, Card, ProgressBar, SegmentedButtons, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Banner } from "@/components/form-parts";
import { openGoal } from "@/components/goal-tag";
import { ApiError, apiFetch } from "@/lib/api";
import { type Goal, type GoalList, paceText, progressText } from "@/lib/goals";
import { useSession } from "@/lib/session";

type Shown = "active" | "archived";
const FAILED = "We couldn't load your goals.";

// One goal on the list: its progress, how it is pacing and anything that needs a look.
function GoalSummary({ goal, onPress }: { goal: Goal; onPress: () => void }) {
  const { colors } = useTheme();
  const progress = progressText(goal);
  const pace = paceText(goal);
  const emergency = goal.kind === "emergency";
  return (
    <Card
      mode="outlined"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[goal.name, emergency ? "emergency fund" : null, progress, pace, ...goal.warnings]
        .filter(Boolean)
        .join(". ")}
      accessibilityHint="Opens the goal"
    >
      <Card.Content style={styles.card}>
        <View style={styles.cardTop}>
          <Text variant="titleMedium" style={styles.cardName}>
            {goal.name}
          </Text>
          {emergency ? (
            <Text variant="labelMedium" style={{ color: colors.primary }}>
              Emergency fund
            </Text>
          ) : null}
        </View>
        <Text variant="bodyMedium">{progress}</Text>
        {goal.target !== null ? (
          <ProgressBar
            progress={goal.reached ? 1 : (goal.percent ?? 0) / 100}
            color={goal.reached ? colors.tertiary : colors.primary}
            style={styles.bar}
          />
        ) : null}
        {pace ? (
          <Text variant="bodySmall" style={{ color: goal.overdue ? colors.error : colors.onSurfaceVariant }}>
            {pace}
          </Text>
        ) : null}
        {goal.warnings.map((warning) => (
          <Text key={warning} variant="bodySmall" style={{ color: colors.error }}>
            {warning}
          </Text>
        ))}
      </Card.Content>
    </Card>
  );
}

export default function GoalsScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<Shown>("active");
  const [goals, setGoals] = useState<Record<Shown, Goal[] | null>>({ active: null, archived: null });
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const navigating = useRef(false);
  const latest = useRef(0);

  // Both lists at once, so switching between them is instant and the toggle knows if any are archived.
  const load = useCallback(async () => {
    const mine = ++latest.current;
    const auth = { token: token ?? undefined };
    try {
      const [active, archived] = await Promise.all([
        apiFetch<GoalList>("/goals?archived=false", auth),
        apiFetch<GoalList>("/goals?archived=true", auth),
      ]);
      if (mine !== latest.current) return;
      setGoals({ active: active.goals, archived: archived.goals });
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
      navigating.current = false;
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

  const go = (open: () => void) => {
    if (navigating.current) return;
    navigating.current = true;
    open();
  };
  const add = () => go(() => router.push("/goal-form"));

  const list = goals[shown];
  const archivedCount = goals.archived?.length ?? 0;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Goals" />
        <Appbar.Action icon="plus" accessibilityLabel="Add goal" onPress={add} />
      </Appbar.Header>

      {goals.active === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading goals" />
        </View>
      ) : goals.active === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {FAILED}
          </Text>
          <Button mode="contained" onPress={() => void refresh()} loading={refreshing} disabled={refreshing}>
            Try again
          </Button>
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {failed ? <Banner messages={[`${FAILED} Pull down to try again.`]} /> : null}
          {archivedCount > 0 || shown === "archived" ? (
            <SegmentedButtons
              value={shown}
              onValueChange={(value) => setShown(value as Shown)}
              buttons={[
                { value: "active", label: "Active" },
                { value: "archived", label: `Archived (${archivedCount})` },
              ]}
            />
          ) : null}

          {list === null || list.length === 0 ? (
            shown === "archived" ? (
              <View style={styles.empty}>
                <Text variant="titleMedium">No archived goals</Text>
              </View>
            ) : (
              <View style={styles.empty}>
                <Text variant="titleMedium">No goals yet</Text>
                <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
                  Name what you&apos;re saving for, then set money aside in your bank or cash, or count a fund, stock, coin,
                  PPF or RD toward it. Nothing moves: your balances stay as they are.
                </Text>
                <Button mode="contained" onPress={add}>
                  Add goal
                </Button>
              </View>
            )
          ) : (
            list.map((goal) => <GoalSummary key={goal.id} goal={goal} onPress={() => go(() => openGoal(goal.id))} />)
          )}
          {shown === "archived" && list !== null && list.length > 0 ? (
            <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
              Archived goals keep their history, but their set-aside money and holdings count for nothing until restored.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  empty: { alignItems: "center", gap: 12, paddingVertical: 32 },
  card: { gap: 6 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 12 },
  cardName: { flexShrink: 1 },
  bar: { height: 6, borderRadius: 3 },
});
