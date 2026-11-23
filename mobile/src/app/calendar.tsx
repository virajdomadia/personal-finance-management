import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, HeaderAction, ScreenHeader } from "@/components/chunky";
import { DueList } from "@/components/due-list";
import { Banner } from "@/components/form-parts";
import { ReminderList } from "@/components/reminder-list";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CalendarDay,
  type Mark,
  type SpendCalendar,
  calendarPath,
  calendarWeeks,
  dayTone,
  leadMark,
  markText,
  marksByDate,
  monthLabel,
  paceText,
  shortDay,
  shortRupees,
  splitTemplates,
} from "@/lib/cash-flow";
import type { GoalDue } from "@/lib/goals";
import { type DueItem, type Template, whole } from "@/lib/recurring";
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
  const [templates, setTemplates] = useState<Template[]>([]);
  const [due, setDue] = useState<DueItem[]>([]);
  const [goalsDue, setGoalsDue] = useState<GoalDue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  const monthRef = useRef(month);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const auth = { token: token ?? undefined };
      const [result, list, items] = await Promise.all([
        apiFetch<SpendCalendar>(calendarPath(monthRef.current), auth),
        apiFetch<{ templates: Template[] }>("/recurring", auth),
        apiFetch<{ items: DueItem[]; goals_due?: GoalDue[] }>("/recurring/due", auth),
      ]);
      if (mine !== latest.current) return;
      setData(result);
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
  const add = (type: "income" | "expense", frequency: "monthly" | "yearly" = "monthly") =>
    push({ pathname: "/template-form", params: { type, frequency } });
  const edit = (t: Template) => push({ pathname: "/template-form", params: { id: String(t.id) } });
  const openSips = () => push("/(tabs)/investments");

  const title = data ? monthLabel(data.month) : month ? monthLabel(month) : "This month";
  const { fixed: fixedTemplates, other } = splitTemplates(templates);
  const lists = { onEdit: edit, onChanged: () => void load(), onNotice: setNotice };
  const fixed = data ? (
    <FixedMoney data={data} templates={fixedTemplates} onAdd={add} onOpenSips={openSips} {...lists} />
  ) : null;

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
          {notice !== null ? <Banner messages={[notice]} /> : null}
          {/* Until there's a daily amount, asking for the fixed money comes first. */}
          {data.per_day === null ? fixed : null}
          {data.is_current ? <DueList items={due} goals={goalsDue} onChanged={() => void load()} /> : null}
          <Figures data={data} />
          <MonthGrid data={data} onDay={openDay} />
          {data.per_day !== null ? fixed : null}
          <OtherReminders templates={other} onAdd={() => add("expense", "yearly")} {...lists} />
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
  const marks = marksByDate(data.marks);
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
              {day === null ? null : <DayCell day={day} marks={marks.get(day.date) ?? []} onPress={() => onDay(day.date)} />}
            </View>
          ))}
        </View>
      ))}
      <Text variant="bodySmall" style={styles.muted}>
        Rent, SIPs and other fixed payments aren&apos;t counted here: they&apos;re already taken out of the free amount. Reminders: ✓ paid · ! due · • coming · – skipped. Tap a day to see its transactions.
      </Text>
    </ChunkyBox>
  );
}

// A reminder's mark on its day: paid, owed, still to come, or skipped.
const MARK = {
  paid: { symbol: "✓", bg: BRAND.gain, fg: "#FFFFFF" },
  due: { symbol: "!", bg: BRAND.loss, fg: "#FFFFFF" },
  coming: { symbol: "•", bg: BRAND.ink, fg: "#FFFFFF" },
  skipped: { symbol: "–", bg: BRAND.zinc200, fg: BRAND.ink },
} as const;

// A cell is ~30dp wide on a small phone: one badge (the most urgent) and a count of the rest.
// The names are all in the cell's spoken label.
function MarkBadges({ marks }: { marks: Mark[] }) {
  const lead = leadMark(marks);
  if (lead === null) return null;
  const look = MARK[lead.mark.state];
  return (
    <View style={styles.badges} importantForAccessibility="no-hide-descendants">
      <View style={[styles.badge, { backgroundColor: look.bg }]}>
        <Text allowFontScaling={false} style={[styles.badgeText, { color: look.fg }]}>
          {look.symbol}
        </Text>
      </View>
      {lead.more > 0 ? (
        <Text allowFontScaling={false} style={styles.more}>
          +{lead.more}
        </Text>
      ) : null}
    </View>
  );
}

function DayCell({ day, marks, onPress }: { day: CalendarDay; marks: Mark[]; onPress: () => void }) {
  const tone = TONE[dayTone(day)];
  const number = Number(day.date.slice(8));
  const box = [styles.day, { backgroundColor: tone.bg, borderColor: tone.border }];
  const reminders = marks.length > 0 ? `. ${marks.map(markText).join("; ")}` : "";
  const top = (
    <View style={styles.dayTop}>
      <Text maxFontSizeMultiplier={1.2} style={[styles.dayNumber, { color: tone.fg }]}>
        {number}
      </Text>
      <MarkBadges marks={marks} />
    </View>
  );
  if (day.spent === null) {
    return (
      <View style={box} accessible accessibilityLabel={`${shortDay(day.date)}, still to come${reminders}`}>
        {top}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${shortDay(day.date)}, spent ${whole(day.spent)}${tone.word}${reminders}`}
      accessibilityHint="Shows that day's transactions"
      style={({ pressed }) => [...box, pressed && styles.pressed]}
    >
      {top}
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={[styles.dayAmount, { color: tone.fg }]}>
        {shortRupees(day.spent).replace("₹", "")}
      </Text>
    </Pressable>
  );
}

type ListActions = {
  onEdit: (t: Template) => void;
  onChanged: () => void;
  onNotice: (message: string | null) => void;
};

function FixedMoney({
  data,
  templates,
  onAdd,
  onOpenSips,
  ...actions
}: {
  data: SpendCalendar;
  templates: Template[];
  onAdd: (type: "income" | "expense") => void;
  onOpenSips: () => void;
} & ListActions) {
  const sips = data.fixed.filter((f) => f.source === "sip");
  const empty = templates.length === 0 && sips.length === 0;
  return (
    <ChunkyBox style={styles.card}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
        📌 Your fixed money
      </Text>
      <Text variant="bodySmall" style={styles.muted}>
        {empty
          ? "Tell us what comes in and goes out every month (salary, rent, SIP, PPF) and we'll work out how much you can spend each day. You'll be reminded when each one is due."
          : `Every month: ${whole(data.income)} in − ${whole(data.fixed_out)} fixed = ${whole(data.free)} free. Changing these changes the daily amount.`}
      </Text>
      {data.per_day === null && !empty ? (
        <Text variant="bodySmall" style={{ color: BRAND.loss }}>
          Add your monthly income to get a daily amount.
        </Text>
      ) : null}
      {templates.length > 0 ? <ReminderList templates={templates} {...actions} /> : null}
      {sips.map((line) => (
        <Pressable
          key={`sip-${line.id}`}
          onPress={onOpenSips}
          accessibilityRole="button"
          accessibilityLabel={`${line.name} SIP, ${whole(line.amount)} on the ${ordinal(line.day)}`}
          accessibilityHint="Opens Investments to change this SIP"
          style={({ pressed }) => [styles.fixedRow, pressed && styles.pressed]}
        >
          <View style={styles.fixedText}>
            <Text variant="bodyLarge" numberOfLines={1} style={styles.heading}>
              {line.name}
            </Text>
            <Text variant="bodySmall" style={styles.muted}>
              SIP · on the {ordinal(line.day)}
            </Text>
          </View>
          <Text variant="titleMedium" style={styles.fixedAmount}>
            {whole(line.amount)}
          </Text>
        </Pressable>
      ))}
      <View style={styles.row}>
        <ChunkyButton label="Add income" icon="plus" variant="green" onPress={() => onAdd("income")} style={styles.cell} />
        <ChunkyButton label="Add expense" icon="plus" variant="pink" onPress={() => onAdd("expense")} style={styles.cell} />
      </View>
    </ChunkyBox>
  );
}

function OtherReminders({ templates, onAdd, ...actions }: { templates: Template[]; onAdd: () => void } & ListActions) {
  return (
    <ChunkyBox style={styles.card}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
        🗂️ Other reminders
      </Text>
      <Text variant="bodySmall" style={styles.muted}>
        Yearly payments like insurance premiums, and reminders you&apos;ve stopped. They don&apos;t change the daily amount.
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
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 4 },
  month: { flex: 1, textAlign: "center", color: BRAND.ink },
  content: { padding: 16, gap: 12 },
  muted: { color: BRAND.zinc600 },
  heading: { color: BRAND.ink },
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
  day: { height: 58, borderWidth: 2, borderRadius: 10, paddingHorizontal: 3, paddingVertical: 4, justifyContent: "space-between" },
  dayNumber: { fontSize: 12, fontWeight: "800" },
  dayTop: { gap: 2 },
  badges: { flexDirection: "row", alignItems: "center", gap: 1 },
  more: { fontSize: 8, lineHeight: 10, fontWeight: "900", color: BRAND.ink },
  badge: { width: 12, height: 12, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 8, lineHeight: 10, fontWeight: "900" },
  dayAmount: { fontSize: 11, fontWeight: "800", textAlign: "right", fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.6 },
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
