import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, HeaderAction, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CalendarDay,
  type SpendCalendar,
  calendarPath,
  calendarWeeks,
  dayTone,
  monthLabel,
  netText,
  netWords,
  shortDay,
} from "@/lib/cash-flow";
import { blankFilters, filterHandoff } from "@/lib/search";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const TONE = {
  spent: { bg: BRAND.card, border: BRAND.ink, fg: BRAND.ink },
  gained: { bg: "#EAF4E3", border: BRAND.gain, fg: BRAND.gain },
  none: { bg: BRAND.card, border: BRAND.zinc200, fg: BRAND.zinc500 },
  future: { bg: BRAND.zinc100, border: BRAND.zinc200, fg: BRAND.zinc500 },
} as const;

// The spending calendar: one figure a day, what was spent less what came in.
export default function CalendarScreen() {
  const params = useLocalSearchParams<{ month?: string }>();
  const month = typeof params.month === "string" && /^\d{4}-\d{2}$/.test(params.month) ? params.month : null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<SpendCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  const monthRef = useRef(month);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<SpendCalendar>(calendarPath(monthRef.current), { token: token ?? undefined });
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

  // Reloads on coming back, so a transaction just added shows at once.
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
    setData(null);
    setError(null);
    void load();
  };

  const openDay = (date: string) => {
    if (navigating.current) return;
    navigating.current = true;
    filterHandoff.next = { ...blankFilters(date.slice(0, 7)), dateFrom: date, dateTo: date };
    router.navigate("/transactions");
  };

  const title = data ? monthLabel(data.month) : month ? monthLabel(month) : "This month";

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Spending calendar" back />
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
          <MonthGrid data={data} onDay={openDay} />
        </ScrollView>
      )}
    </View>
  );
}

function MonthGrid({ data, onDay }: { data: SpendCalendar; onDay: (date: string) => void }) {
  return (
    <ChunkyBox style={styles.card}>
      <View style={styles.gridHead}>
        <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
          Spent each day (₹)
        </Text>
        <Text variant="bodySmall" style={{ color: BRAND.gain }}>
          + green: more came in
        </Text>
      </View>
      <View style={styles.week}>
        {WEEKDAYS.map((d, i) => (
          <Text key={i} variant="labelSmall" style={[styles.weekday, styles.muted]} importantForAccessibility="no">
            {d}
          </Text>
        ))}
      </View>
      {calendarWeeks(data.days).map((week, i) => (
        <View key={i} style={styles.week}>
          {week.map((day, j) => (
            <View key={j} style={styles.slot}>
              {day === null ? null : <DayCell day={day} onPress={() => onDay(day.date)} />}
            </View>
          ))}
        </View>
      ))}
      <Text variant="bodySmall" style={styles.muted}>
        Each day is what you spent less what came in (income and refunds). Moving money between your own accounts doesn&apos;t count. Tap a day to see its transactions.
      </Text>
    </ChunkyBox>
  );
}

function DayCell({ day, onPress }: { day: CalendarDay; onPress: () => void }) {
  const tone = TONE[dayTone(day)];
  const box = [styles.day, { backgroundColor: tone.bg, borderColor: tone.border }];
  const number = (
    <Text maxFontSizeMultiplier={1.2} style={[styles.dayNumber, { color: tone.fg }]}>
      {Number(day.date.slice(8))}
    </Text>
  );
  if (day.net === null) {
    return (
      <View style={box} accessible accessibilityLabel={`${shortDay(day.date)}, still to come`}>
        {number}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${shortDay(day.date)}, ${netWords(day.net)}`}
      accessibilityHint="Shows that day's transactions"
      style={({ pressed }) => [...box, pressed && styles.pressed]}
    >
      {number}
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.dayAmount, { color: tone.fg }]}>
        {netText(day.net).replace("₹", "")}
      </Text>
    </Pressable>
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
  heading: { color: BRAND.ink },
  card: { padding: 14, gap: 10 },
  gridHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  week: { flexDirection: "row", gap: 4 },
  weekday: { flex: 1, textAlign: "center" },
  slot: { flex: 1, minWidth: 0 },
  day: { height: 58, borderWidth: 2, borderRadius: 10, paddingHorizontal: 3, paddingVertical: 4, justifyContent: "space-between" },
  dayNumber: { fontSize: 12, fontWeight: "800" },
  dayAmount: { fontSize: 11, fontWeight: "800", textAlign: "right", fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.6 },
});
