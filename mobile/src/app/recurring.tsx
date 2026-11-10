import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Appbar, Button, Card, Dialog, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DueList } from "@/components/due-list";
import { Banner } from "@/components/form-parts";
import { errorMessage, formatDueDate } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type DueItem, type Template, scheduleText, whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/transactions";

const TYPE_LABEL = { expense: "Expense", income: "Income", transfer: "Transfer" } as const;
const FAILED = "We couldn't load your reminders.";

// "Due since 1 Mar", "Coming up on 6 Apr", or why there is nothing to show.
function nextText(t: Template): string {
  if (!t.active) return "Stopped";
  if (t.due.length > 0) return `Due since ${formatDueDate(t.due[0])}`;
  if (t.coming_up) return `Coming up on ${formatDueDate(t.coming_up)}`;
  if (t.end_date) return `Ends ${formatDate(t.end_date)}`;
  return "Nothing due yet";
}

export default function RecurringScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [due, setDue] = useState<DueItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const [removing, setRemoving] = useState(false);
  const busy = useRef(false);
  const navigating = useRef(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    const auth = { token: token ?? undefined };
    try {
      const [list, items] = await Promise.all([
        apiFetch<{ templates: Template[] }>("/recurring", auth),
        apiFetch<{ items: DueItem[] }>("/recurring/due", auth),
      ]);
      if (mine !== latest.current) return;
      setTemplates(list.templates);
      setDue(items.items);
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

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busy.current) setDeleting(null);
    });
    return () => subscription.remove();
  }, []);

  const open = (id?: number) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(id === undefined ? "/template-form" : { pathname: "/template-form", params: { id: String(id) } });
  };

  async function toggle(t: Template) {
    if (busy.current) return;
    busy.current = true;
    setToggling(t.id);
    setNotice(null);
    try {
      await apiFetch(`/recurring/${t.id}`, { method: "PATCH", token: token ?? undefined, body: { active: !t.active } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else setNotice(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
    } finally {
      busy.current = false;
      setToggling(null);
    }
    void load();
  }

  async function remove(t: Template) {
    if (busy.current) return;
    busy.current = true;
    setRemoving(true);
    setNotice(null);
    try {
      await apiFetch(`/recurring/${t.id}`, { method: "DELETE", token: token ?? undefined });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else setNotice(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
    } finally {
      busy.current = false;
      setRemoving(false);
      setDeleting(null);
    }
    void load();
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Recurring" />
        <Appbar.Action icon="plus" accessibilityLabel="Add reminder" onPress={() => open()} />
      </Appbar.Header>

      {templates === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading reminders" />
        </View>
      ) : templates === null ? (
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
          {notice !== null ? <Banner messages={[notice]} /> : null}
          <DueList items={due} onChanged={() => void load()} />

          {templates.length === 0 ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">No reminders yet</Text>
              <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
                Add rent, a salary or any regular payment, and it will show up here when it&apos;s due. Nothing is recorded
                until you do it.
              </Text>
            </View>
          ) : (
            templates.map((t) => {
              const accounts = t.type === "transfer" ? `${t.account_name} to ${t.to_account_name}` : t.account_name;
              const details = [TYPE_LABEL[t.type], scheduleText(t), accounts, t.category].filter(Boolean).join(" · ");
              const working = toggling === t.id;
              return (
                <Card
                  key={t.id}
                  mode="outlined"
                  onPress={() => open(t.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.name}, ${whole(t.amount)}. ${details}. ${nextText(t)}. Edit`}
                >
                  <Card.Content style={styles.card}>
                    <View style={styles.cardTop}>
                      <Text variant="titleMedium" style={styles.cardName}>
                        {t.name}
                      </Text>
                      <Text variant="titleMedium">{whole(t.amount)}</Text>
                    </View>
                    <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                      {details}
                    </Text>
                    <Text variant="bodySmall" style={{ color: t.active ? colors.onSurface : colors.onSurfaceVariant }}>
                      {t.policy_id !== null ? `Insurance policy · ${nextText(t)}` : nextText(t)}
                    </Text>
                  </Card.Content>
                  <Card.Actions>
                    <Button disabled={working || removing} loading={working} onPress={() => void toggle(t)}>
                      {t.active ? "Stop" : "Restart"}
                    </Button>
                    {t.policy_id === null ? (
                      <Button disabled={working || removing} onPress={() => setDeleting(t)}>
                        Delete
                      </Button>
                    ) : null}
                  </Card.Actions>
                </Card>
              );
            })
          )}
        </ScrollView>
      )}

      <Portal>
        <Dialog visible={deleting !== null} onDismiss={() => (removing ? undefined : setDeleting(null))}>
          <Dialog.Title>{deleting ? `Delete ${deleting.name}?` : "Delete?"}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              The reminder is removed for good. Transactions you recorded from it stay. If it has any, stop it instead.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleting(null)} disabled={removing}>
              Cancel
            </Button>
            <Button onPress={() => deleting && void remove(deleting)} loading={removing} disabled={removing}>
              Delete
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
  content: { padding: 16, gap: 12 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 32 },
  card: { gap: 4 },
  cardTop: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  cardName: { flexShrink: 1 },
});
