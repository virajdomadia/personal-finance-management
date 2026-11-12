import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, EmptyState, HeaderAction, ScreenHeader, Tag } from "@/components/chunky";
import { CategoryIcon } from "@/components/category-icon";
import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type BudgetLine,
  type BudgetMonth,
  type Totals,
  type Unbudgeted,
  barFill,
  budgetGroups,
  budgetMonthLabel,
  budgetSpoken,
  budgetsPath,
  isMonth,
  leftText,
  nextMonth,
  percentText,
  previousMonth,
  spentOfText,
  unbudgetedSpentText,
} from "@/lib/budgets";
import { shortDay } from "@/lib/cash-flow";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

// A thick bar from the server's capped `bar`; red once the budget is passed.
function BudgetBar({ totals, height = 22, muted = false, label }: { totals: Totals; height?: number; muted?: boolean; label: string }) {
  const width = barFill(totals);
  const fill = muted ? BRAND.zinc500 : totals.over ? BRAND.loss : width >= 90 ? BRAND.orange : BRAND.green;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: width, text: percentText(totals) }}
      style={[styles.track, { height }]}
    >
      <View style={[styles.fill, { width: `${width}%`, backgroundColor: fill }, width > 0 && width < 100 ? styles.edge : null]} />
    </View>
  );
}

function TotalCard({ data }: { data: BudgetMonth }) {
  const t = data.total;
  return (
    <ChunkyBox style={[styles.totalCard, { backgroundColor: t.over ? BRAND.pink : BRAND.yellow }]}>
      <Text variant="labelMedium" style={styles.ink}>
        {data.is_current ? `💰 ${budgetMonthLabel(data.month)} so far` : `💰 ${budgetMonthLabel(data.month)}`}
      </Text>
      <Text variant="titleLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={styles.totalValue}>
        {leftText(t)}
      </Text>
      <Text variant="bodyMedium" style={styles.ink}>
        {spentOfText(t)} spent · {percentText(t)}
      </Text>
      <BudgetBar totals={t} height={26} label="All budgets" />
    </ChunkyBox>
  );
}

function BudgetCard({ line, sub = false, onPress }: { line: BudgetLine; sub?: boolean; onPress?: () => void }) {
  const muted = !line.active;
  const body = (pressed: boolean) => (
    <ChunkyBox
      pressed={pressed}
      radius={sub ? INPUT_RADIUS : undefined}
      offset={sub ? SHADOW_OFFSET_SM : undefined}
      style={[styles.card, muted ? styles.mutedCard : line.over ? styles.overCard : null]}
    >
      <View style={styles.cardHead}>
        <CategoryIcon icon={line.icon} colour={muted ? BRAND.zinc200 : line.colour} size={sub ? 30 : 38} />
        <View style={styles.cardMain}>
          <Text variant={sub ? "titleSmall" : "titleMedium"} style={[styles.name, muted ? styles.muted : null]}>
            {line.name}
          </Text>
          {line.parent_name && !sub ? (
            <Text variant="bodySmall" style={styles.muted}>
              in {line.parent_name}
            </Text>
          ) : null}
          {muted ? <Tag label="Inactive" /> : null}
        </View>
        <View style={styles.cardRight}>
          <Text variant="titleMedium" style={[styles.left, line.over && !muted ? styles.loss : muted ? styles.muted : null]}>
            {leftText(line)}
          </Text>
          <Text variant="bodySmall" style={styles.muted}>
            {spentOfText(line)}
          </Text>
        </View>
      </View>
      <View style={styles.barLine}>
        <View style={styles.barWrap}>
          <BudgetBar totals={line} height={sub ? 16 : 22} muted={muted} label={line.name} />
        </View>
        <Text variant="labelMedium" style={[styles.percent, line.over && !muted ? styles.loss : styles.muted]}>
          {percentText(line)}
        </Text>
      </View>
      {muted && line.note ? (
        <Text variant="bodySmall" style={styles.muted}>
          {line.note}
        </Text>
      ) : null}
    </ChunkyBox>
  );
  if (!onPress) {
    return (
      <View accessible accessibilityLabel={budgetSpoken(line)} style={sub ? styles.sub : null}>
        {body(false)}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={budgetSpoken(line)}
      accessibilityHint="Change or remove this budget"
      style={sub ? styles.sub : null}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

function UnbudgetedRow({ item, isCurrent, onPress }: { item: Unbudgeted; isCurrent: boolean; onPress?: () => void }) {
  const spent = unbudgetedSpentText(item, isCurrent);
  const label = [item.name, item.parent_name ? `in ${item.parent_name}` : null, spent].filter(Boolean).join(", ");
  const body = (pressed: boolean) => (
    <ChunkyBox pressed={pressed} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.addRow}>
      <CategoryIcon icon={item.icon} colour={item.colour} size={32} />
      <View style={styles.cardMain}>
        <Text variant="titleSmall" style={styles.name}>
          {item.name}
        </Text>
        <Text variant="bodySmall" style={styles.muted}>
          {item.parent_name ? `in ${item.parent_name} · ` : ""}
          {spent}
        </Text>
      </View>
      {onPress ? <Icon source="plus" size={22} color={BRAND.ink} /> : null}
    </ChunkyBox>
  );
  if (!onPress) return <View accessible accessibilityLabel={label}>{body(false)}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Sets a budget for it">
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

export default function BudgetsScreen() {
  const params = useLocalSearchParams<{ month?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // Null asks for the current month.
  const [month, setMonth] = useState<string | null>(isMonth(params.month) ? params.month : null);
  const [data, setData] = useState<BudgetMonth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const latest = useRef(0);
  const monthRef = useRef(month);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      let result: BudgetMonth;
      try {
        result = await apiFetch<BudgetMonth>(budgetsPath(monthRef.current), { token: token ?? undefined });
      } catch (err) {
        // A month that hasn't started (a stale link): show this month instead.
        if (!(err instanceof ApiError && err.status === 422 && monthRef.current !== null)) throw err;
        monthRef.current = null;
        result = await apiFetch<BudgetMonth>(budgetsPath(null), { token: token ?? undefined });
      }
      if (mine !== latest.current) return;
      setMonth(monthRef.current);
      setData(result);
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

  const go = (next: string | null) => {
    monthRef.current = next;
    setMonth(next);
    setData(null);
    setError(null);
    setAdding(false);
    void load();
  };

  const edit = (p: { id: number; name: string; amount?: string; spent: string; parent?: string | null }) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push({
      pathname: "/budget-form",
      params: {
        id: String(p.id),
        name: p.name,
        spent: p.spent,
        ...(p.amount ? { amount: p.amount } : {}),
        ...(p.parent ? { parent: p.parent } : {}),
      },
    });
  };

  const editable = data?.is_current ?? false;
  const shown = data?.month ?? month;
  const title = shown ? budgetMonthLabel(shown) : "This month";
  const groups = data ? budgetGroups(data.budgets) : [];
  const openLine = (line: BudgetLine) =>
    editable
      ? () => edit({ id: line.category_id, name: line.name, amount: line.amount, spent: line.spent, parent: line.parent_name })
      : undefined;

  const addList = data && editable && (adding || data.budgets.length === 0) ? (
    <View style={styles.list}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.section}>
        ADD A BUDGET
      </Text>
      {data.unbudgeted.length === 0 ? (
        <Text variant="bodyMedium" style={styles.muted}>
          Every spending category has a budget.
        </Text>
      ) : (
        <>
          <Text variant="bodySmall" style={styles.muted}>
            Pick a spending category. A budget on a category counts its subcategories too.
          </Text>
          {data.unbudgeted.map((u) => (
            <UnbudgetedRow
              key={u.category_id}
              item={u}
              isCurrent
              onPress={() => edit({ id: u.category_id, name: u.name, spent: u.spent, parent: u.parent_name })}
            />
          ))}
        </>
      )}
    </View>
  ) : null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Budgets" back />
      <View style={styles.monthRow}>
        <HeaderAction icon="chevron-left" label="Previous month" disabled={!shown} onPress={() => shown && go(previousMonth(shown))} />
        <Text variant="titleMedium" accessibilityLiveRegion="polite" style={styles.month}>
          {title}
        </Text>
        <HeaderAction
          icon="chevron-right"
          label="Next month"
          disabled={!data || data.is_current}
          onPress={() => data && !data.is_current && go(nextMonth(data.month))}
        />
      </View>

      {data === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading budgets" />
        </View>
      ) : data === null ? (
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

          {data.budgets.length === 0 ? (
            <EmptyState
              compact={editable}
              emoji="🐷"
              title={editable ? "No budgets yet" : `No budgets in ${budgetMonthLabel(data.month)}`}
              body={
                editable
                  ? "Set a monthly amount for a spending category and see how much is left as you go. It stays the same every month until you change it."
                  : "Budgets apply from the month they're set, so this month has none to show."
              }
            />
          ) : (
            <>
              <Text variant="bodySmall" style={styles.muted}>
                {data.is_current ? `Spending from 1 to ${shortDay(data.through)}` : "The whole month. Past months can't be changed."}
              </Text>
              <TotalCard data={data} />
              <View style={styles.list}>
                {groups.map((g) => (
                  <View key={g.line.category_id} style={styles.group}>
                    <BudgetCard line={g.line} onPress={openLine(g.line)} />
                    {g.children.map((c) => (
                      <BudgetCard key={c.category_id} line={c} sub onPress={openLine(c)} />
                    ))}
                  </View>
                ))}
              </View>
              {editable ? (
                <Text variant="bodySmall" style={styles.muted}>
                  Tap a budget to change or remove it. Changes apply from this month on.
                </Text>
              ) : null}
            </>
          )}

          {editable && data.budgets.length > 0 && !adding ? (
            <ChunkyButton label="Add budget" icon="plus" variant="alt" onPress={() => setAdding(true)} />
          ) : null}
          {addList}

          {!editable && data.unbudgeted.length > 0 && data.budgets.length > 0 ? (
            <View style={styles.list}>
              <Text variant="titleSmall" accessibilityRole="header" style={styles.section}>
                WITHOUT A BUDGET
              </Text>
              {data.unbudgeted.map((u) => (
                <UnbudgetedRow key={u.category_id} item={u} isCurrent={false} />
              ))}
            </View>
          ) : null}

          {!editable ? <ChunkyButton label="Back to this month" variant="alt" onPress={() => go(null)} /> : null}
          {data.budgets.some((b) => b.active && !b.counted) ? (
            <Text variant="bodySmall" style={styles.muted}>
              A subcategory&apos;s budget isn&apos;t added to the total when its parent has one too, since the parent&apos;s already
              counts that spending.
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
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 4 },
  month: { flex: 1, textAlign: "center", color: BRAND.ink },
  content: { padding: 16, gap: 12 },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
  loss: { color: BRAND.loss },
  totalCard: { padding: 16, gap: 6 },
  totalValue: { color: BRAND.ink, fontSize: 30, lineHeight: 36, fontVariant: ["tabular-nums"] },
  track: {
    width: "100%",
    overflow: "hidden",
    borderRadius: 999,
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    backgroundColor: BRAND.zinc100,
  },
  fill: { height: "100%" },
  edge: { borderRightWidth: 2.5, borderRightColor: BRAND.ink },
  list: { gap: 10 },
  group: { gap: 8 },
  sub: { marginLeft: 24 },
  card: { padding: 14, gap: 10 },
  mutedCard: { backgroundColor: BRAND.zinc100 },
  overCard: { backgroundColor: "#FFE3E6" },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  cardMain: { flex: 1, minWidth: 0 },
  name: { color: BRAND.ink },
  cardRight: { flexShrink: 0, maxWidth: "55%", alignItems: "flex-end" },
  left: { color: BRAND.ink, fontVariant: ["tabular-nums"], textAlign: "right" },
  barLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  barWrap: { flex: 1 },
  percent: { width: 44, textAlign: "right", fontVariant: ["tabular-nums"] },
  addRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  section: { color: BRAND.ink, letterSpacing: 0.6, marginTop: 8 },
});
