import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Appbar, Button, Dialog, Divider, IconButton, Portal, ProgressBar, Surface, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type EarmarkAction,
  type GoalDetail,
  type HistoryLine,
  type HoldingLine,
  efText,
  holdingName,
  paceText,
  progressText,
} from "@/lib/goals";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/transactions";

const FAILED = "We couldn't load this goal.";
const MISSING = "This goal isn't there any more. It may have been deleted.";

const HOLDING_KIND: Record<HoldingLine["kind"], string> = {
  stock: "Stock",
  mutual_fund: "Fund",
  crypto: "Coin",
  ppf: "PPF",
  rd: "RD",
};

// A history line's amount is negative for a release.
const released = (entry: HistoryLine) => entry.amount.startsWith("-");
const entryTitle = (entry: HistoryLine) =>
  released(entry) ? `Released ${whole(entry.amount.slice(1))}` : `Set aside ${whole(entry.amount)}`;

type Asking =
  | { kind: "remove-holding"; holding: HoldingLine }
  | { kind: "delete-entry"; entry: HistoryLine }
  | { kind: "archive" }
  | { kind: "delete" };

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; goal: GoalDetail };

function Fact({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.fact}>
      <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
        {label}
      </Text>
      <Text variant="bodyLarge" style={styles.factValue}>
        {value}
      </Text>
    </View>
  );
}

function SectionTitle({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <Text variant="titleSmall" accessibilityRole="header" style={[styles.sectionTitle, { color: colors.primary }]}>
      {label}
    </Text>
  );
}

function confirmText(asking: Asking, goal: GoalDetail): { title: string; body: string; action: string } {
  switch (asking.kind) {
    case "remove-holding":
      return {
        title: `Take ${asking.holding.name} out?`,
        body: `It stops counting toward ${goal.name} and is free to join another goal. The holding itself isn't touched.`,
        action: "Remove",
      };
    case "delete-entry":
      return {
        title: `Delete "${entryTitle(asking.entry)}"?`,
        body: `The entry from ${formatDate(asking.entry.date)} is removed, and ${goal.name}'s money in ${asking.entry.account_name} changes back. No transaction is touched.`,
        action: "Delete",
      };
    case "archive":
      return {
        title: `Archive ${goal.name}?`,
        body: "Its history stays, but the money set aside stops counting against your accounts and its holdings are free to join another goal. You can restore it later.",
        action: "Archive",
      };
    case "delete":
      return {
        title: `Delete ${goal.name}?`,
        body: "The goal and its basket are removed for good. Your accounts and holdings aren't touched.",
        action: "Delete",
      };
  }
}

export default function GoalScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const navigating = useRef(false);
  const latest = useRef(0);
  const shown = useRef(false);

  const fetchGoal = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const goal = await apiFetch<GoalDetail>(`/goals/${id}`, { token: token ?? undefined });
      if (mine !== latest.current) return;
      shown.current = true;
      setLoad({ status: "ready", goal });
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      const missing = err instanceof ApiError && err.status === 404;
      // A failed refresh keeps the goal on screen, with a note.
      if (!missing && shown.current) setNotice(`${FAILED} Pull down to try again.`);
      else setLoad({ status: "error", message: missing ? MISSING : FAILED });
    }
  }, [id, token, logOut]);

  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
      void fetchGoal();
    }, [fetchGoal]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      await fetchGoal();
    } finally {
      setRefreshing(false);
    }
  }, [fetchGoal]);

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busy.current) setAsking(null);
    });
    return () => subscription.remove();
  }, []);

  const go = (target: Parameters<typeof router.push>[0]) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  };
  const earmark = (action: EarmarkAction) =>
    go({ pathname: "/earmark-form", params: { goalId: String(id), action } });

  // Runs one change, then reloads. A refusal (409, 404) is shown as a note.
  async function run(work: () => Promise<unknown>, after?: () => void) {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setNotice(null);
    let ok = false;
    try {
      await work();
      ok = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setNotice(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
    } finally {
      busy.current = false;
      setWorking(false);
      setAsking(null);
    }
    if (ok && after) after();
    else void fetchGoal();
  }

  function confirm(goal: GoalDetail) {
    if (asking === null) return;
    const auth = { token: token ?? undefined };
    switch (asking.kind) {
      case "remove-holding":
        void run(() => apiFetch(`/goals/${goal.id}/holdings/${asking.holding.id}`, { method: "DELETE", ...auth }));
        break;
      case "delete-entry":
        void run(() => apiFetch(`/goals/${goal.id}/earmarks/${asking.entry.id}`, { method: "DELETE", ...auth }));
        break;
      case "archive":
        void run(() => apiFetch(`/goals/${goal.id}/archive`, { method: "POST", ...auth }));
        break;
      case "delete":
        void run(
          () => apiFetch(`/goals/${goal.id}`, { method: "DELETE", ...auth }),
          () => router.back(),
        );
        break;
    }
  }

  const goal = load.status === "ready" ? load.goal : null;
  const title = goal?.name ?? "Goal";

  if (goal === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title={title} />
        </Appbar.Header>
        <View style={styles.center}>
          {load.status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading the goal" />
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {load.status === "error" ? load.message : FAILED}
              </Text>
              {load.status === "error" && load.message === MISSING ? (
                <Button mode="contained" onPress={() => router.back()}>
                  Go back
                </Button>
              ) : (
                <Button
                  mode="contained"
                  onPress={() => {
                    setLoad({ status: "loading" });
                    void fetchGoal();
                  }}
                >
                  Try again
                </Button>
              )}
            </>
          )}
        </View>
      </View>
    );
  }

  const pace = paceText(goal);
  const canDelete = goal.history.length === 0;
  const empty = goal.earmarks.length === 0 && goal.holdings.length === 0;
  const dialog = asking ? confirmText(asking, goal) : null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={goal.name} />
        {!goal.archived ? (
          <Appbar.Action
            icon="pencil-outline"
            accessibilityLabel="Edit goal"
            disabled={working}
            onPress={() => go({ pathname: "/goal-form", params: { id: String(goal.id) } })}
          />
        ) : null}
        {!goal.archived ? (
          <Appbar.Action
            icon="archive-outline"
            accessibilityLabel="Archive goal"
            disabled={working}
            onPress={() => setAsking({ kind: "archive" })}
          />
        ) : null}
        {canDelete ? (
          <Appbar.Action
            icon="delete-outline"
            accessibilityLabel="Delete goal"
            disabled={working}
            onPress={() => setAsking({ kind: "delete" })}
          />
        ) : null}
      </Appbar.Header>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      >
        {notice !== null ? <Banner messages={[notice]} /> : null}

        {goal.archived ? (
          <View style={[styles.archived, { backgroundColor: colors.secondaryContainer }]}>
            <Text variant="bodyMedium" style={{ color: colors.onSecondaryContainer }}>
              This goal is archived. Its set-aside money and holdings count for nothing until you restore it.
            </Text>
            <Button
              mode="contained"
              loading={working}
              disabled={working}
              onPress={() =>
                void run(() => apiFetch(`/goals/${goal.id}/restore`, { method: "POST", token: token ?? undefined }))
              }
            >
              Restore
            </Button>
          </View>
        ) : null}

        <Surface elevation={1} style={styles.summary}>
          {goal.kind === "emergency" ? (
            <Text variant="labelMedium" style={{ color: colors.primary }}>
              Emergency fund
            </Text>
          ) : null}
          <Text variant="titleLarge" style={styles.progress}>
            {progressText(goal)}
          </Text>
          {goal.target !== null ? (
            <ProgressBar
              progress={goal.reached ? 1 : (goal.percent ?? 0) / 100}
              color={goal.reached ? colors.tertiary : colors.primary}
              style={styles.bar}
              accessibilityLabel={`${goal.percent ?? 0}% of the target`}
            />
          ) : null}
          <View style={styles.facts}>
            <Fact label="Set aside" value={whole(goal.earmarked)} />
            <Fact label="Holdings" value={whole(goal.holdings_value)} />
            {goal.target !== null ? <Fact label="Target" value={whole(goal.target)} /> : null}
          </View>
          {goal.kind === "emergency" ? <Text variant="bodyMedium">{efText(goal)}</Text> : null}
          {goal.target_date && !goal.reached ? (
            <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
              Reach it by {formatDate(goal.target_date)}
              {goal.months_left !== null && goal.months_left > 0
                ? ` · ${goal.months_left} ${goal.months_left === 1 ? "month" : "months"} left`
                : ""}
            </Text>
          ) : null}
          {pace ? (
            <Text variant="bodyMedium" style={{ color: goal.overdue ? colors.error : colors.onSurface }}>
              {pace}
            </Text>
          ) : null}
          {goal.monthly_amount && goal.reminder_day !== null ? (
            <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
              Reminder to set aside {whole(goal.monthly_amount)} on day {goal.reminder_day} of each month
            </Text>
          ) : null}
          {goal.note ? <Text variant="bodyMedium">{goal.note}</Text> : null}
        </Surface>

        {goal.warnings.length > 0 ? <Banner messages={goal.warnings} /> : null}

        {!goal.archived ? (
          <View style={styles.actions}>
            <Button mode="contained" icon="plus" disabled={working} onPress={() => earmark("set_aside")}>
              Set aside
            </Button>
            {goal.earmarks.length > 0 ? (
              <Button mode="outlined" icon="minus" disabled={working} onPress={() => earmark("release")}>
                Release
              </Button>
            ) : null}
            <Button
              mode="outlined"
              icon="chart-line"
              disabled={working}
              onPress={() => go({ pathname: "/goal-holding-form", params: { goalId: String(goal.id) } })}
            >
              Add holding
            </Button>
          </View>
        ) : null}

        {empty ? (
          <View style={styles.empty}>
            <Text variant="titleMedium">The basket is empty</Text>
            <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
              Set money aside in a bank, cash or wallet account, or add a fund, stock, coin, PPF or RD you hold.
            </Text>
          </View>
        ) : null}

        {goal.earmarks.length > 0 ? (
          <View>
            <SectionTitle label="Set aside by account" />
            {goal.earmarks.map((e, index) => (
              <View key={e.account_id}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.row}>
                  <Text variant="bodyLarge" style={styles.rowMain}>
                    {e.account_name}
                  </Text>
                  <Text variant="bodyLarge" style={styles.rowAmount}>
                    {whole(e.amount)}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {goal.holdings.length > 0 ? (
          <View>
            <SectionTitle label="Holdings" />
            {goal.holdings.map((h, index) => (
              <View key={h.id}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.row}>
                  <View style={styles.rowMain}>
                    <Text
                      variant="bodyLarge"
                      style={{ color: h.status === "held" ? colors.onSurface : colors.onSurfaceVariant }}
                    >
                      {holdingName(h)}
                    </Text>
                    <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                      {[HOLDING_KIND[h.kind], h.note].filter(Boolean).join(" · ")}
                    </Text>
                  </View>
                  <Text variant="bodyLarge" style={styles.rowAmount}>
                    {whole(h.value)}
                  </Text>
                  {!goal.archived ? (
                    <IconButton
                      icon="close"
                      size={20}
                      disabled={working}
                      accessibilityLabel={`Take ${h.name} out of ${goal.name}`}
                      onPress={() => setAsking({ kind: "remove-holding", holding: h })}
                    />
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {goal.history.length > 0 ? (
          <View>
            <SectionTitle label="History" />
            {goal.history.map((entry, index) => {
              const titleText = entryTitle(entry);
              return (
                <View key={entry.id}>
                  {index > 0 ? <Divider /> : null}
                  <View style={styles.row}>
                    <View style={styles.rowMain}>
                      <Text variant="bodyLarge">{titleText}</Text>
                      <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                        {[formatDate(entry.date), entry.account_name, entry.note].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    {!goal.archived ? (
                      <IconButton
                        icon="delete-outline"
                        size={20}
                        disabled={working}
                        accessibilityLabel={`Delete ${titleText} on ${formatDate(entry.date)}`}
                        onPress={() => setAsking({ kind: "delete-entry", entry })}
                      />
                    ) : null}
                  </View>
                </View>
              );
            })}
            {!goal.archived ? (
              <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                Entries aren&apos;t edited. To correct one, delete it and set aside or release again.
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      <Portal>
        <Dialog visible={dialog !== null} onDismiss={() => (working ? undefined : setAsking(null))}>
          <Dialog.Title>{dialog?.title ?? ""}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{dialog?.body ?? ""}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsking(null)} disabled={working}>
              Cancel
            </Button>
            <Button onPress={() => confirm(goal)} loading={working} disabled={working}>
              {dialog?.action ?? "OK"}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 16 },
  archived: { borderRadius: 12, padding: 12, gap: 8 },
  summary: { borderRadius: 12, padding: 16, gap: 10 },
  progress: { fontWeight: "600" },
  bar: { height: 8, borderRadius: 4 },
  facts: { flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 8 },
  fact: { minWidth: "28%", flexGrow: 1 },
  factValue: { fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 24 },
  sectionTitle: { paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 6 },
  rowMain: { flex: 1, gap: 2 },
  rowAmount: { flexShrink: 1, maxWidth: "45%", textAlign: "right", fontWeight: "600" },
});
