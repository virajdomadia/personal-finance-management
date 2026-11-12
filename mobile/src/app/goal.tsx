import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, Icon, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ChunkyBox,
  ChunkyButton,
  EmptyState,
  HeaderAction,
  Ring,
  Row,
  ScreenHeader,
  Sticker,
  TONE_SQUARE,
  Tile,
  type Tone,
} from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type EarmarkAction,
  type GoalDetail,
  type HistoryLine,
  type HoldingLine,
  efText,
  goalEmoji,
  holdingName,
  paceText,
  progressText,
} from "@/lib/goals";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";
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
const HOLDING_EMOJI: Record<HoldingLine["kind"], string> = {
  stock: "📈",
  mutual_fund: "🥧",
  crypto: "🪙",
  ppf: "🐷",
  rd: "🪙",
};
const HOLDING_TONE: Record<HoldingLine["kind"], Tone> = {
  stock: "blue",
  mutual_fund: "orange",
  crypto: "yellow",
  ppf: "pink",
  rd: "green",
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

function SectionTitle({ label }: { label: string }) {
  return (
    <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionTitle}>
      {label.toUpperCase()}
    </Text>
  );
}

// A basket line with a small button at its end: a holding with its remove, or a history entry with its delete.
function BasketRow({
  emoji,
  tone,
  title,
  meta,
  amount,
  muted,
  actionIcon,
  actionLabel,
  disabled,
  onAction,
}: {
  emoji: string;
  tone: Tone;
  title: string;
  meta?: string;
  amount?: string;
  muted?: boolean;
  actionIcon: string;
  actionLabel: string;
  disabled?: boolean;
  onAction?: () => void;
}) {
  return (
    <ChunkyBox radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={[styles.basket, onAction ? null : styles.basketEnd]}>
      <View style={[styles.square, { backgroundColor: TONE_SQUARE[tone] }]}>
        <Text style={styles.emoji} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {emoji}
        </Text>
      </View>
      <View style={styles.basketMain}>
        <Text variant="titleMedium" style={[styles.basketTitle, muted ? { color: BRAND.zinc600 } : null]}>
          {title}
        </Text>
        {meta ? (
          <Text variant="bodySmall" style={styles.meta}>
            {meta}
          </Text>
        ) : null}
      </View>
      {amount !== undefined ? (
        <Text variant="titleMedium" style={styles.basketAmount}>
          {amount}
        </Text>
      ) : null}
      {onAction ? (
        <Pressable
          onPress={onAction}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          accessibilityState={{ disabled: !!disabled }}
          hitSlop={4}
          style={[styles.remove, { opacity: disabled ? 0.6 : 1 }]}
        >
          <Icon source={actionIcon} size={22} color={BRAND.ink} />
        </Pressable>
      ) : null}
    </ChunkyBox>
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
        <ScreenHeader title={title} back />
        <View style={styles.center}>
          {load.status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading the goal" />
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {load.status === "error" ? load.message : FAILED}
              </Text>
              {load.status === "error" && load.message === MISSING ? (
                <ChunkyButton label="Go back" onPress={() => router.back()} />
              ) : (
                <ChunkyButton
                  label="Try again"
                  onPress={() => {
                    setLoad({ status: "loading" });
                    void fetchGoal();
                  }}
                />
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
      <ScreenHeader
        title={goal.name}
        back
        right={
          <>
            {!goal.archived ? (
              <HeaderAction
                icon="pencil-outline"
                label="Edit goal"
                disabled={working}
                onPress={() => go({ pathname: "/goal-form", params: { id: String(goal.id) } })}
              />
            ) : null}
            {!goal.archived ? (
              <HeaderAction
                icon="archive-outline"
                label="Archive goal"
                disabled={working}
                onPress={() => setAsking({ kind: "archive" })}
              />
            ) : null}
            {canDelete ? (
              <HeaderAction
                icon="delete-outline"
                label="Delete goal"
                disabled={working}
                onPress={() => setAsking({ kind: "delete" })}
              />
            ) : null}
          </>
        }
      />

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      >
        {notice !== null ? <Banner messages={[notice]} /> : null}

        {goal.archived ? (
          <ChunkyBox radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.archived}>
            <Text variant="bodyMedium" style={{ color: BRAND.ink }}>
              This goal is archived. Its set-aside money and holdings count for nothing until you restore it.
            </Text>
            <ChunkyButton
              label="Restore"
              loading={working}
              onPress={() =>
                void run(() => apiFetch(`/goals/${goal.id}/restore`, { method: "POST", token: token ?? undefined }))
              }
            />
          </ChunkyBox>
        ) : null}

        <ChunkyBox style={styles.summary}>
          {goal.reached ? <Sticker text="DONE!" /> : null}
          <View style={styles.summaryTop}>
            <Ring
              percent={goal.target !== null ? goal.percent : null}
              reached={goal.reached}
              label={goal.target !== null ? `${goal.percent ?? 0}% of the target` : "No target set"}
            />
            <View style={[styles.summaryText, goal.reached ? styles.stickerGap : null]}>
              <Text variant="labelMedium" style={styles.kicker}>
                {goalEmoji(goal)} {goal.kind === "emergency" ? "Emergency fund" : "Goal"}
              </Text>
              <Text variant="titleMedium" style={styles.progress}>
                {progressText(goal)}
              </Text>
            </View>
          </View>
          {goal.kind === "emergency" ? <Text variant="bodyMedium">{efText(goal)}</Text> : null}
          {goal.target_date && !goal.reached ? (
            <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
              Reach it by {formatDate(goal.target_date)}
              {goal.months_left !== null && goal.months_left > 0
                ? ` · ${goal.months_left} ${goal.months_left === 1 ? "month" : "months"} left`
                : ""}
            </Text>
          ) : null}
          {pace ? (
            <Text variant="bodyMedium" style={{ color: goal.overdue ? BRAND.loss : BRAND.ink }}>
              {pace}
            </Text>
          ) : null}
          {goal.monthly_amount && goal.reminder_day !== null ? (
            <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
              Reminder to set aside {whole(goal.monthly_amount)} on day {goal.reminder_day} of each month
            </Text>
          ) : null}
          {goal.note ? <Text variant="bodyMedium">{goal.note}</Text> : null}
        </ChunkyBox>

        <View style={styles.facts}>
          <View style={styles.fact}>
            <Tile tone="green" label="Set aside" value={whole(goal.earmarked)} />
          </View>
          <View style={styles.fact}>
            <Tile tone="blue" label="Holdings" value={whole(goal.holdings_value)} />
          </View>
          {goal.target !== null ? (
            <View style={styles.fact}>
              <Tile tone="yellow" label="Target" value={whole(goal.target)} />
            </View>
          ) : null}
        </View>

        {goal.warnings.length > 0 ? <Banner messages={goal.warnings} /> : null}

        {!goal.archived ? (
          <View style={styles.actions}>
            <ChunkyButton
              variant="green"
              icon="plus"
              label="Set aside"
              disabled={working}
              onPress={() => earmark("set_aside")}
            />
            {goal.earmarks.length > 0 ? (
              <ChunkyButton
                variant="alt"
                icon="minus"
                label="Release"
                disabled={working}
                onPress={() => earmark("release")}
              />
            ) : null}
            <ChunkyButton
              variant="alt"
              icon="chart-line"
              label="Add holding"
              disabled={working}
              onPress={() => go({ pathname: "/goal-holding-form", params: { goalId: String(goal.id) } })}
            />
          </View>
        ) : null}

        {empty ? (
          <EmptyState
            emoji="🧺"
            title="The basket is empty"
            compact
            body={
              goal.archived
                ? "Restore this goal to put money toward it again."
                : "Use Set aside to label money in a bank, cash or wallet account for this goal, or Add holding for a fund, stock, coin, PPF or RD you own."
            }
          />
        ) : null}

        {goal.earmarks.length > 0 ? (
          <View style={styles.list}>
            <SectionTitle label="Set aside by account" />
            {goal.earmarks.map((e) => (
              <Row key={e.account_id} emoji="🏦" tone="blue" title={e.account_name} amount={whole(e.amount)} />
            ))}
          </View>
        ) : null}

        {goal.holdings.length > 0 ? (
          <View style={styles.list}>
            <SectionTitle label="Holdings" />
            {goal.holdings.map((h) => (
              <BasketRow
                key={h.id}
                emoji={HOLDING_EMOJI[h.kind]}
                tone={HOLDING_TONE[h.kind]}
                title={holdingName(h)}
                muted={h.status !== "held"}
                meta={[HOLDING_KIND[h.kind], h.note].filter(Boolean).join(" · ")}
                amount={whole(h.value)}
                actionIcon="close"
                actionLabel={`Take ${h.name} out of ${goal.name}`}
                disabled={working}
                onAction={goal.archived ? undefined : () => setAsking({ kind: "remove-holding", holding: h })}
              />
            ))}
          </View>
        ) : null}

        {goal.history.length > 0 ? (
          <View style={styles.list}>
            <SectionTitle label="History" />
            {goal.history.map((entry) => {
              const titleText = entryTitle(entry);
              return (
                <BasketRow
                  key={entry.id}
                  emoji={released(entry) ? "↩️" : "💰"}
                  tone={released(entry) ? "pink" : "green"}
                  title={titleText}
                  meta={[formatDate(entry.date), entry.account_name, entry.note].filter(Boolean).join(" · ")}
                  actionIcon="delete-outline"
                  actionLabel={`Delete ${titleText} on ${formatDate(entry.date)}`}
                  disabled={working}
                  onAction={goal.archived ? undefined : () => setAsking({ kind: "delete-entry", entry })}
                />
              );
            })}
            {!goal.archived ? (
              <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
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
  content: { padding: 16, paddingTop: 12, gap: 16 },
  archived: { backgroundColor: BRAND.due, padding: 12, gap: 10 },
  summary: { padding: 16, gap: 10 },
  summaryTop: { flexDirection: "row", alignItems: "center", gap: 16 },
  summaryText: { flex: 1, minWidth: 0, gap: 4 },
  stickerGap: { paddingTop: 20 },
  kicker: { color: BRAND.zinc600 },
  progress: { color: BRAND.ink, fontSize: 18, lineHeight: 24 },
  facts: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  fact: { flexGrow: 1, flexBasis: "45%", minWidth: 130 },
  actions: { gap: 8 },
  list: { gap: 8 },
  sectionTitle: { color: BRAND.ink, letterSpacing: 0.6, paddingTop: 4 },
  basket: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 12, paddingRight: 4, paddingVertical: 6 },
  basketEnd: { paddingRight: 12, paddingVertical: 10 },
  square: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: { fontSize: 18, lineHeight: 24 },
  basketMain: { flex: 1, minWidth: 0 },
  basketTitle: { color: BRAND.ink, fontSize: 16, lineHeight: 22 },
  meta: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  basketAmount: { color: BRAND.ink, flexShrink: 0, maxWidth: "45%", textAlign: "right", fontVariant: ["tabular-nums"] },
  remove: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
