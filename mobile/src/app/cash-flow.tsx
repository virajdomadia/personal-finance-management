import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, HeaderAction, ScreenHeader } from "@/components/chunky";
import { CategoryIcon, ShareBar } from "@/components/category-icon";
import { Banner } from "@/components/form-parts";
import { ChangeLine } from "@/components/month-card";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CashFlowMonth,
  type CategorySlice,
  type Change,
  type ChangeKind,
  type DaySpend,
  barWidth,
  cashFlowPath,
  dailySummary,
  isZero,
  monthLabel,
  shortDay,
  signedWhole,
  sliceType,
} from "@/lib/cash-flow";
import { whole } from "@/lib/recurring";
import { blankFilters, filterHandoff } from "@/lib/search";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

const STRIP_HEIGHT = 96;

function Total({ label, amount, change, kind, color }: { label: string; amount: string; change: Change; kind: ChangeKind; color: string }) {
  return (
    <ChunkyBox style={styles.total}>
      <Text variant="labelMedium" style={styles.muted}>
        {label}
      </Text>
      <Text variant="titleLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={[styles.totalValue, { color }]}>
        {kind === "net" ? signedWhole(amount) : whole(amount)}
      </Text>
      <ChangeLine change={change} kind={kind} />
    </ChunkyBox>
  );
}

// Each day's spending as a bar, from the server's heights. Days still to come are left faint.
function DailyStrip({ daily }: { daily: DaySpend[] }) {
  if (daily.length === 0) return null;
  const middle = daily[Math.floor((daily.length - 1) / 2)];
  return (
    <View>
      <View accessible accessibilityRole="image" accessibilityLabel={dailySummary(daily)} style={styles.strip}>
        {daily.map((d) => {
          const future = d.spent === null;
          const spent = !future && d.spent !== null && !isZero(d.spent);
          return (
            <View key={d.date} style={styles.dayColumn}>
              {future ? (
                <View style={styles.future} />
              ) : spent ? (
                // A small day still shows as a sliver.
                <View style={[styles.bar, { height: `${Math.max(barWidth(d.height), 4)}%`, backgroundColor: d.height === 100 ? BRAND.pinkStrong : BRAND.pink }]} />
              ) : (
                <View style={styles.zero} />
              )}
            </View>
          );
        })}
      </View>
      <View style={styles.axis} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text variant="labelSmall" style={styles.muted}>
          {shortDay(daily[0].date)}
        </Text>
        <Text variant="labelSmall" style={styles.muted}>
          {shortDay(middle.date)}
        </Text>
        <Text variant="labelSmall" style={styles.muted}>
          {shortDay(daily[daily.length - 1].date)}
        </Text>
      </View>
    </View>
  );
}

function SliceLine({
  slice,
  sub = false,
  onOpen,
  expanded,
  onToggle,
}: {
  slice: CategorySlice;
  sub?: boolean;
  onOpen: () => void;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const label = `${slice.name}, ${whole(slice.amount)}, ${slice.percent}%`;
  return (
    <View style={[styles.sliceRow, sub ? styles.subRow : null]}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Shows these transactions"
        style={({ pressed }) => [styles.sliceMain, pressed ? styles.pressed : null]}
      >
        <CategoryIcon icon={slice.icon} colour={slice.colour} size={sub ? 28 : 34} />
        <View style={styles.sliceText}>
          <View style={styles.sliceLine}>
            <Text variant={sub ? "labelLarge" : "titleSmall"} numberOfLines={2} style={styles.sliceName}>
              {slice.name}
            </Text>
            <Text variant={sub ? "labelLarge" : "titleSmall"} style={styles.sliceAmount}>
              {whole(slice.amount)}
            </Text>
          </View>
          <View style={styles.barLine}>
            <View style={styles.barWrap}>
              <ShareBar width={barWidth(slice.percent)} colour={slice.colour} />
            </View>
            <Text variant="labelSmall" style={[styles.muted, styles.percent]}>
              {slice.percent}%
            </Text>
          </View>
        </View>
      </Pressable>
      {onToggle ? (
        <Pressable
          onPress={onToggle}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Hide" : "Show"} ${slice.name}'s subcategories`}
          accessibilityState={{ expanded }}
          style={styles.toggle}
        >
          {({ pressed }) => (
            <ChunkyBox pressed={pressed} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.toggleBox}>
              <Icon source={expanded ? "chevron-up" : "chevron-down"} size={20} color={BRAND.ink} />
            </ChunkyBox>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

function SliceGroups({
  slices,
  open,
}: {
  slices: CategorySlice[];
  open: (slice: CategorySlice) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <View style={styles.groups}>
      {slices.map((s) => {
        const key = `${s.id ?? "none"}-${s.name}`;
        const isOpen = expanded[key] ?? false;
        const hasChildren = s.children.length > 0;
        return (
          <View key={key} style={styles.group}>
            <SliceLine
              slice={s}
              onOpen={() => open(s)}
              expanded={isOpen}
              onToggle={hasChildren ? () => setExpanded((e) => ({ ...e, [key]: !isOpen })) : undefined}
            />
            {hasChildren && isOpen ? (
              <View style={styles.children}>
                {s.children.map((c) => (
                  <SliceLine key={`${c.id ?? "none"}-${c.name}`} slice={c} sub onOpen={() => open(c)} />
                ))}
                {!isZero(s.direct) ? (
                  <Text variant="bodySmall" style={[styles.muted, styles.direct]}>
                    {whole(s.direct)} in {s.name} itself
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export default function CashFlowScreen() {
  const params = useLocalSearchParams<{ month?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // Null asks for the current month.
  const [month, setMonth] = useState<string | null>(params.month ?? null);
  const [data, setData] = useState<CashFlowMonth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  const monthRef = useRef(month);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<CashFlowMonth>(cashFlowPath(monthRef.current), { token: token ?? undefined });
      if (mine !== latest.current) return;
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
    if (next === null) return;
    monthRef.current = next;
    setMonth(next);
    setData(null);
    setError(null);
    void load();
  };

  // The transactions tab, filtered to the category and the month.
  const openSlice = (kind: "spending" | "income", slice: CategorySlice) => {
    if (data === null || navigating.current) return;
    navigating.current = true;
    filterHandoff.next = { ...blankFilters(data.month), category: slice.name, type: sliceType(kind, slice.name, data) };
    router.navigate("/transactions");
  };

  const title = data ? monthLabel(data.month) : month ? monthLabel(month) : "This month";

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Cash flow" back />
      <View style={styles.monthRow}>
        <HeaderAction icon="chevron-left" label="Previous month" disabled={!data?.previous_month} onPress={() => go(data?.previous_month ?? null)} />
        <Text variant="titleMedium" accessibilityLiveRegion="polite" style={styles.month}>
          {title}
        </Text>
        <HeaderAction icon="chevron-right" label="Next month" disabled={!data?.next_month} onPress={() => go(data?.next_month ?? null)} />
      </View>

      {data === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading the month" />
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
          <Text variant="bodySmall" style={styles.muted}>
            {data.is_current
              ? `1 to ${shortDay(data.through)}, against ${shortDay(data.previous.start)} to ${shortDay(data.previous.through)}`
              : `The whole month, against ${shortDay(data.previous.start)} to ${shortDay(data.previous.through)}`}
          </Text>

          <View style={styles.totals}>
            <View style={styles.cell}>
              <Total label="Spent" amount={data.spending} change={data.spending_change} kind="spending" color={BRAND.ink} />
            </View>
            <View style={styles.cell}>
              <Total label="Earned" amount={data.income} change={data.income_change} kind="income" color={BRAND.gain} />
            </View>
          </View>
          <Total
            label="Left over"
            amount={data.net}
            change={data.net_change}
            kind="net"
            color={data.net.startsWith("-") && !isZero(data.net) ? BRAND.loss : BRAND.ink}
          />

          <ChunkyButton
            label={`Budgets for ${monthLabel(data.month)}`}
            icon="piggy-bank-outline"
            variant="alt"
            onPress={() => router.push({ pathname: "/budgets", params: data.is_current ? {} : { month: data.month } })}
          />

          <ChunkyBox style={styles.card}>
            <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
              Day by day
            </Text>
            <DailyStrip daily={data.daily} />
          </ChunkyBox>

          <Text variant="titleSmall" accessibilityRole="header" style={styles.section}>
            SPENDING BY CATEGORY
          </Text>
          {data.spending_by_category.length === 0 ? (
            <Text variant="bodyMedium" style={styles.muted}>
              Nothing spent in {monthLabel(data.month)}{data.is_current ? " yet" : ""}.
            </Text>
          ) : (
            <SliceGroups key={`s-${data.month}`} slices={data.spending_by_category} open={(s) => openSlice("spending", s)} />
          )}

          <Text variant="titleSmall" accessibilityRole="header" style={styles.section}>
            INCOME BY CATEGORY
          </Text>
          {data.income_by_category.length === 0 ? (
            <Text variant="bodyMedium" style={styles.muted}>
              No income in {monthLabel(data.month)}{data.is_current ? " yet" : ""}.
            </Text>
          ) : (
            <SliceGroups key={`i-${data.month}`} slices={data.income_by_category} open={(s) => openSlice("income", s)} />
          )}
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
  muted: { color: BRAND.zinc600 },
  totals: { flexDirection: "row", gap: 12 },
  cell: { flex: 1, minWidth: 0 },
  total: { padding: 14, gap: 4 },
  totalValue: { fontSize: 24, lineHeight: 30, fontVariant: ["tabular-nums"] },
  card: { padding: 14, gap: 10 },
  heading: { color: BRAND.ink },
  section: { color: BRAND.ink, letterSpacing: 0.6, marginTop: 8 },
  strip: { height: STRIP_HEIGHT, flexDirection: "row", alignItems: "flex-end", borderBottomWidth: 2.5, borderBottomColor: BRAND.ink },
  dayColumn: { flex: 1, height: "100%", justifyContent: "flex-end", paddingHorizontal: 1 },
  bar: { width: "100%", borderWidth: 1.5, borderColor: BRAND.ink, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  zero: { height: 2, backgroundColor: BRAND.zinc200 },
  future: { width: "100%", height: "100%", backgroundColor: BRAND.zinc100, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  axis: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  groups: { gap: 10 },
  group: { gap: 6 },
  sliceRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  subRow: { paddingLeft: 20 },
  sliceMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  pressed: { opacity: 0.6 },
  sliceText: { flex: 1, minWidth: 0, gap: 4 },
  sliceLine: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  sliceName: { flexShrink: 1, color: BRAND.ink },
  sliceAmount: { color: BRAND.ink, fontVariant: ["tabular-nums"], flexShrink: 0 },
  barLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  barWrap: { flex: 1 },
  percent: { width: 36, textAlign: "right", fontVariant: ["tabular-nums"] },
  toggle: { flexShrink: 0 },
  toggleBox: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  children: { gap: 4 },
  direct: { paddingLeft: 20 },
});
