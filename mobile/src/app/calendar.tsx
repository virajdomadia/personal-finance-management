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
  type FixedLine,
  type SpendCalendar,
  calendarPath,
  calendarWeeks,
  dayTone,
  monthLabel,
  paceText,
  shortDay,
  shortRupees,
} from "@/lib/cash-flow";
import { whole } from "@/lib/recurring";
import { blankFilters, filterHandoff } from "@/lib/search";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const TONE = {
  over: { bg: "#FBE7EA", border: BRAND.loss, fg: BRAND.loss, word: ", over the daily amount" },
  under: { bg: "#EAF4E3", border: BRAND.gain, fg: BRAND.gain, word: ", within the daily amount" },
  plain: { bg: BRAND.card, border: BRAND.ink, fg: BRAND.ink, word: "" },
  future: { bg: BRAND.zinc100, border: BRAND.zinc200, fg: BRAND.zinc500, word: "" },
} as const;

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}

// The spending calendar: the month's fixed money, the daily amount it leaves, and each day's
// spending against it. Fixed money is kept as monthly reminders, added and changed from here.
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

  const go = (next: string | null) => {
    if (next === null) return;
    monthRef.current = next;
    setData(null);
    setError(null);
    void load();
  };

  const push = (target: Parameters<typeof router.push>[0]) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  };
  const openDay = (date: string) => {
    if (navigating.current) return;
    navigating.current = true;
    filterHandoff.next = { ...blankFilters(date.slice(0, 7)), dateFrom: date, dateTo: date };
    router.navigate("/transactions");
  };
  const addFixed = (type: "income" | "expense") => push({ pathname: "/template-form", params: { type } });
  const editFixed = (line: FixedLine) =>
    line.source === "sip" ? push("/(tabs)/investments") : push({ pathname: "/template-form", params: { id: String(line.id) } });

  const title = data ? monthLabel(data.month) : month ? monthLabel(month) : "This month";
  const fixed = data ? <FixedMoney data={data} onAdd={addFixed} onEdit={editFixed} /> : null;

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
          {/* Until there's a daily amount, asking for the fixed money comes first. */}
          {data.per_day === null ? fixed : null}
          <Figures data={data} />
          <MonthGrid data={data} onDay={openDay} />
          {data.per_day !== null ? fixed : null}
        </ScrollView>
      )}
    </View>
  );
}

function Figure({ label, amount, note, noteColor }: { label: string; amount: string | null; note: string; noteColor?: string }) {
  return (
    <ChunkyBox style={styles.figure}>
      <Text variant="labelMedium" style={styles.muted}>
        {label}
      </Text>
      <Text variant="titleLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={styles.figureValue}>
        {amount === null ? "—" : whole(amount)}
      </Text>
      <Text variant="bodySmall" style={{ color: noteColor ?? BRAND.zinc600 }}>
        {note}
      </Text>
    </ChunkyBox>
  );
}

function Figures({ data }: { data: SpendCalendar }) {
  const pace = paceText(data.pace);
  return (
    <View style={styles.figures}>
      <View style={styles.row}>
        <View style={styles.cell}>
          <Figure label="Free this month" amount={data.free} note={`${whole(data.income)} in − ${whole(data.fixed_out)} fixed`} />
        </View>
        <View style={styles.cell}>
          <Figure
            label="Per day"
            amount={data.per_day}
            note={data.per_day === null ? "Needs your monthly income" : `Free ÷ ${data.days.length} days`}
          />
        </View>
      </View>
      <View style={styles.row}>
        <View style={styles.cell}>
          <Figure label="Spent" amount={data.spent} note={data.is_current ? `1 to ${shortDay(data.through)}` : "The whole month"} />
        </View>
        <View style={styles.cell}>
          <Figure
            label="Left"
            amount={data.left}
            note={pace ?? "Free − spent"}
            noteColor={pace === null ? undefined : data.pace?.startsWith("-") ? BRAND.loss : BRAND.gain}
          />
        </View>
      </View>
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
        {data.per_day !== null ? (
          <Text variant="bodySmall" style={styles.muted}>
            Daily {whole(data.per_day)}
          </Text>
        ) : null}
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
        Rent, SIPs and other fixed payments aren&apos;t counted here: they&apos;re already taken out of the free amount. Tap a day to see its transactions.
      </Text>
    </ChunkyBox>
  );
}

function DayCell({ day, onPress }: { day: CalendarDay; onPress: () => void }) {
  const tone = TONE[dayTone(day)];
  const number = Number(day.date.slice(8));
  const box = [styles.day, { backgroundColor: tone.bg, borderColor: tone.border }];
  if (day.spent === null) {
    return (
      <View style={box} accessible accessibilityLabel={`${shortDay(day.date)}, still to come`}>
        <Text style={[styles.dayNumber, { color: tone.fg }]}>{number}</Text>
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${shortDay(day.date)}, spent ${whole(day.spent)}${tone.word}`}
      accessibilityHint="Shows that day's transactions"
      style={({ pressed }) => [...box, pressed && styles.pressed]}
    >
      <Text style={[styles.dayNumber, { color: tone.fg }]}>{number}</Text>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.dayAmount, { color: tone.fg }]}>
        {shortRupees(day.spent).replace("₹", "")}
      </Text>
    </Pressable>
  );
}

function FixedMoney({
  data,
  onAdd,
  onEdit,
}: {
  data: SpendCalendar;
  onAdd: (type: "income" | "expense") => void;
  onEdit: (line: FixedLine) => void;
}) {
  const income = data.fixed.filter((f) => f.kind === "income");
  const out = data.fixed.filter((f) => f.kind === "out");
  const empty = data.fixed.length === 0;
  return (
    <ChunkyBox style={styles.card}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
        📌 Your fixed money
      </Text>
      <Text variant="bodySmall" style={styles.muted}>
        {empty
          ? "Tell us what comes in and goes out every month (salary, rent, SIP, PPF) and we'll work out how much you can spend each day."
          : "What comes in and goes out every month. Changing these changes the daily amount."}
      </Text>
      {data.per_day === null && !empty ? (
        <Text variant="bodySmall" style={{ color: BRAND.loss }}>
          Add your monthly income to get a daily amount.
        </Text>
      ) : null}
      <FixedList title="COMES IN" lines={income} empty="No monthly income yet." onEdit={onEdit} />
      <FixedList title="GOES OUT" lines={out} empty="No fixed expenses yet." onEdit={onEdit} />
      <View style={styles.row}>
        <ChunkyButton label="Add income" icon="plus" variant="green" onPress={() => onAdd("income")} style={styles.cell} />
        <ChunkyButton label="Add expense" icon="plus" variant="pink" onPress={() => onAdd("expense")} style={styles.cell} />
      </View>
    </ChunkyBox>
  );
}

function FixedList({ title, lines, empty, onEdit }: { title: string; lines: FixedLine[]; empty: string; onEdit: (line: FixedLine) => void }) {
  return (
    <View style={styles.fixedList}>
      <Text variant="labelMedium" accessibilityRole="header" style={styles.section}>
        {title}
      </Text>
      {lines.length === 0 ? (
        <Text variant="bodyMedium" style={styles.muted}>
          {empty}
        </Text>
      ) : (
        lines.map((line) => (
          <Pressable
            key={`${line.source}-${line.id}`}
            onPress={() => onEdit(line)}
            accessibilityRole="button"
            accessibilityLabel={`${line.name}, ${whole(line.amount)} on the ${ordinal(line.day)}`}
            accessibilityHint={line.source === "sip" ? "Opens Investments to change this SIP" : "Edits this reminder"}
            style={({ pressed }) => [styles.fixedRow, pressed && styles.pressed]}
          >
            <View style={styles.fixedText}>
              <Text variant="bodyLarge" numberOfLines={1} style={styles.heading}>
                {line.name}
              </Text>
              <Text variant="bodySmall" style={styles.muted}>
                {line.source === "sip" ? "SIP · " : ""}on the {ordinal(line.day)}
              </Text>
            </View>
            <Text variant="titleMedium" style={styles.fixedAmount}>
              {whole(line.amount)}
            </Text>
          </Pressable>
        ))
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
  heading: { color: BRAND.ink },
  section: { color: BRAND.ink, letterSpacing: 0.6 },
  figures: { gap: 12 },
  row: { flexDirection: "row", gap: 12 },
  cell: { flex: 1, minWidth: 0 },
  figure: { padding: 14, gap: 4 },
  figureValue: { fontSize: 22, lineHeight: 28, color: BRAND.ink, fontVariant: ["tabular-nums"] },
  card: { padding: 14, gap: 10 },
  gridHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  week: { flexDirection: "row", gap: 4 },
  weekday: { flex: 1, textAlign: "center" },
  slot: { flex: 1, minWidth: 0 },
  day: { height: 52, borderWidth: 2, borderRadius: 10, paddingHorizontal: 3, paddingVertical: 4, justifyContent: "space-between" },
  dayNumber: { fontSize: 12, fontWeight: "800" },
  dayAmount: { fontSize: 11, fontWeight: "800", textAlign: "right", fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.6 },
  fixedList: { gap: 6 },
  fixedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 2,
    borderColor: BRAND.ink,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 48,
  },
  fixedText: { flex: 1, minWidth: 0 },
  fixedAmount: { color: BRAND.ink, fontVariant: ["tabular-nums"] },
});
