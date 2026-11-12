import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "react-native-paper";

import { ChunkyBox } from "@/components/chunky";
import { CategoryIcon, ShareBar } from "@/components/category-icon";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CashFlowMonth,
  type Change,
  type ChangeKind,
  barWidth,
  cashFlowPath,
  changeText,
  changeTone,
  isEmptyMonth,
  percentText,
} from "@/lib/cash-flow";
import { MONTHS } from "@/lib/dates";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND, TONE_COLORS } from "@/lib/theme";

// The change since last month at the same day, coloured by whether it is good news.
export function ChangeLine({ change, kind }: { change: Change; kind: ChangeKind }) {
  const tone = changeTone(change, kind);
  const percent = percentText(change);
  const color = tone === null ? BRAND.zinc600 : TONE_COLORS[tone];
  return (
    <View style={styles.change}>
      {percent ? (
        <View style={[styles.pill, { borderColor: color }]}>
          <Text variant="labelSmall" style={[styles.pillText, { color }]}>
            {percent}
          </Text>
        </View>
      ) : null}
      <Text variant="bodySmall" style={[styles.changeText, { color: tone === null ? BRAND.zinc600 : color }]}>
        {changeText(change, kind)}
      </Text>
    </View>
  );
}

// The dashboard's month so far: spent and earned, the change since last month, and the top three
// categories. It loads itself, and hides when it can't, so the dashboard never waits on it.
export function MonthCard() {
  const { token, logOut } = useSession();
  const [data, setData] = useState<CashFlowMonth | null>(null);
  const latest = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const mine = ++latest.current;
      apiFetch<CashFlowMonth>(cashFlowPath(null), { token: token ?? undefined }).then(
        (result) => {
          if (mine === latest.current) setData(result);
        },
        (err: unknown) => {
          if (mine !== latest.current) return;
          if (err instanceof ApiError && err.status === 401) void logOut();
          // Anything else keeps what is shown, or nothing.
        },
      );
    }, [token, logOut]),
  );

  if (data === null) return null;

  const monthName = MONTHS[Number(data.month.slice(5)) - 1];
  const empty = isEmptyMonth(data);
  const spoken = [
    `${monthName} so far`,
    `spent ${whole(data.spending)}`,
    `earned ${whole(data.income)}`,
    empty ? null : changeText(data.spending_change, "spending"),
    ...data.top_spending.map((s) => `${s.name} ${whole(s.amount)}, ${s.percent}%`),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Pressable
      onPress={() => router.push("/cash-flow")}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the month's cash flow"
    >
      {({ pressed }) => (
        <ChunkyBox pressed={pressed} style={styles.box}>
          <View style={styles.head}>
            <Text variant="labelMedium" style={styles.label}>
              🗓️ {monthName} so far
            </Text>
            <Icon source="chevron-right" size={20} color={BRAND.ink} />
          </View>

          <View style={styles.figures}>
            <View style={styles.figure}>
              <Text variant="labelMedium" style={styles.muted}>
                Spent
              </Text>
              <Text variant="titleLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={styles.spent}>
                {whole(data.spending)}
              </Text>
            </View>
            <View style={styles.figure}>
              <Text variant="labelMedium" style={styles.muted}>
                Earned
              </Text>
              <Text variant="titleLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={styles.earned}>
                {whole(data.income)}
              </Text>
            </View>
          </View>

          {empty ? (
            <Text variant="bodySmall" style={styles.muted}>
              Nothing recorded yet this month.
            </Text>
          ) : (
            <ChangeLine change={data.spending_change} kind="spending" />
          )}

          {data.top_spending.length > 0 ? (
            <View style={styles.top}>
              {data.top_spending.map((s) => (
                <View key={`${s.id ?? "none"}-${s.name}`} style={styles.slice}>
                  <CategoryIcon icon={s.icon} colour={s.colour} size={30} />
                  <View style={styles.sliceMain}>
                    <View style={styles.sliceLine}>
                      <Text variant="labelLarge" numberOfLines={1} style={styles.sliceName}>
                        {s.name}
                      </Text>
                      <Text variant="labelLarge" style={styles.sliceAmount}>
                        {whole(s.amount)} · {s.percent}%
                      </Text>
                    </View>
                    <ShareBar width={barWidth(s.percent)} colour={s.colour} />
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </ChunkyBox>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { padding: 14, gap: 10 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { color: BRAND.ink, fontSize: 12, lineHeight: 16 },
  figures: { flexDirection: "row", gap: 12 },
  figure: { flex: 1, minWidth: 0 },
  muted: { color: BRAND.zinc600 },
  spent: { color: BRAND.ink, fontSize: 26, lineHeight: 32, fontVariant: ["tabular-nums"] },
  earned: { color: BRAND.gain, fontSize: 26, lineHeight: 32, fontVariant: ["tabular-nums"] },
  change: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  changeText: { flexShrink: 1, fontSize: 12, lineHeight: 16 },
  pill: { borderWidth: 2, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1, backgroundColor: BRAND.card },
  pillText: { fontSize: 11, lineHeight: 15, fontVariant: ["tabular-nums"] },
  top: { gap: 8, marginTop: 2 },
  slice: { flexDirection: "row", alignItems: "center", gap: 10 },
  sliceMain: { flex: 1, minWidth: 0, gap: 4 },
  sliceLine: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  sliceName: { flexShrink: 1, color: BRAND.ink },
  sliceAmount: { color: BRAND.ink, fontVariant: ["tabular-nums"], flexShrink: 0 },
});
