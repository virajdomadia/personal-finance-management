import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { DueList } from "@/components/due-list";
import { Banner } from "@/components/form-parts";
import { ReminderList } from "@/components/reminder-list";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { GoalDue } from "@/lib/goals";
import { type DueItem, type Template, splitTemplates } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

type ListActions = {
  onEdit: (t: Template) => void;
  onChanged: () => void;
  onNotice: (message: string | null) => void;
};

// Reminders: what's due now to record or skip, and every reminder to add or change.
export default function RemindersScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [due, setDue] = useState<DueItem[]>([]);
  const [goalsDue, setGoalsDue] = useState<GoalDue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const auth = { token: token ?? undefined };
      const [list, items] = await Promise.all([
        apiFetch<{ templates: Template[] }>("/recurring", auth),
        apiFetch<{ items: DueItem[]; goals_due?: GoalDue[] }>("/recurring/due", auth),
      ]);
      if (mine !== latest.current) return;
      setTemplates(list.templates);
      setDue(items.items);
      setGoalsDue(items.goals_due ?? []);
      setError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setError(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
    }
  }, [token, logOut]);

  // Reloads on coming back, so a reminder just added or changed shows at once.
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

  const push = (target: Parameters<typeof router.push>[0]) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  };
  const add = (type: "income" | "expense", frequency: "monthly" | "yearly" = "monthly") =>
    push({ pathname: "/template-form", params: { type, frequency } });
  const lists: ListActions = {
    onEdit: (t) => push({ pathname: "/template-form", params: { id: String(t.id) } }),
    onChanged: () => void load(),
    onNotice: setNotice,
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Reminders" back />
      {templates === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading your reminders" />
        </View>
      ) : templates === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {error}
          </Text>
          <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {error ? <Banner messages={[`${error} Pull down to try again.`]} /> : null}
          {notice !== null ? <Banner messages={[notice]} /> : null}
          <DueList items={due} goals={goalsDue} onChanged={() => void load()} />
          <Monthly templates={splitTemplates(templates).monthly} onAdd={add} {...lists} />
          <Other templates={splitTemplates(templates).other} onAdd={() => add("expense", "yearly")} {...lists} />
        </ScrollView>
      )}
    </View>
  );
}

function Monthly({ templates, onAdd, ...actions }: { templates: Template[]; onAdd: (type: "income" | "expense") => void } & ListActions) {
  return (
    <ChunkyBox style={styles.card}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
        🔁 Every month
      </Text>
      <Text variant="bodySmall" style={styles.muted}>
        {templates.length === 0
          ? "Salary, rent, PPF: add what comes in or goes out every month and you'll be reminded when each one is due."
          : "You'll be reminded when each one is due."}
      </Text>
      {templates.length > 0 ? <ReminderList templates={templates} {...actions} /> : null}
      <View style={styles.row}>
        <ChunkyButton label="Add income" icon="plus" variant="green" onPress={() => onAdd("income")} style={styles.cell} />
        <ChunkyButton label="Add expense" icon="plus" variant="pink" onPress={() => onAdd("expense")} style={styles.cell} />
      </View>
    </ChunkyBox>
  );
}

function Other({ templates, onAdd, ...actions }: { templates: Template[]; onAdd: () => void } & ListActions) {
  return (
    <ChunkyBox style={styles.card}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
        🗂️ Yearly and stopped
      </Text>
      <Text variant="bodySmall" style={styles.muted}>
        Yearly payments like insurance premiums, and reminders you&apos;ve stopped.
      </Text>
      {templates.length > 0 ? (
        <ReminderList templates={templates} {...actions} />
      ) : (
        <Text variant="bodyMedium" style={styles.muted}>
          None yet.
        </Text>
      )}
      <ChunkyButton label="Add yearly reminder" icon="plus" variant="alt" onPress={onAdd} />
    </ChunkyBox>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  muted: { color: BRAND.zinc600 },
  heading: { color: BRAND.ink },
  card: { padding: 14, gap: 10 },
  row: { flexDirection: "row", gap: 12 },
  cell: { flex: 1, minWidth: 0 },
});
