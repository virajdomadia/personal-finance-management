import { router } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, EmptyState, Row, ScreenHeader, Segmented, Tag, Tile } from "@/components/chunky";
import { NetWorthLine, useNetWorth } from "@/components/net-worth-chart";
import { formatDate } from "@/lib/dates";
import {
  type NetWorthHistory,
  type NetWorthRange,
  RANGES,
  changeSpoken,
  changeText,
  estimatedNote,
  monthRows,
  wholeRupees,
} from "@/lib/net-worth";
import { BRAND } from "@/lib/theme";

const FAILED = "We couldn't load your net worth history.";

export default function NetWorthScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<NetWorthRange>("1y");
  const { data, failed, load } = useNetWorth(range);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Net worth" back />
      {data === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading net worth history" />
        </View>
      ) : data === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {FAILED}
          </Text>
          <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {failed ? (
            <Text variant="bodyMedium" accessibilityRole="alert" style={styles.error}>
              {FAILED} Pull down to try again.
            </Text>
          ) : null}
          <Segmented label="How far back" value={range} onChange={setRange} options={RANGES} />

          {data.points.length === 0 ? (
            <EmptyState
              emoji="📈"
              title="Your trend starts with your first account"
              body="Add what you have and owe. A point is saved every night, so the line grows on its own."
              action={{ label: "Add an account", onPress: () => router.navigate("/accounts") }}
            />
          ) : (
            <History data={data} />
          )}
        </ScrollView>
      )}
    </View>
  );
}

function History({ data }: { data: NetWorthHistory }) {
  const points = data.points;
  const today = points[points.length - 1];
  const negative = today.net_worth.startsWith("-");
  const monthChange = data.since_last_month;
  const startSince = data.since_start ? `since ${formatDate(data.since_start.from_date)}` : "";
  const note = estimatedNote(data);
  const first = points[0];

  return (
    <>
      <Tile
        tone={negative ? "pink" : "green"}
        label="Net worth today"
        value={wholeRupees(today.net_worth)}
        size="huge"
        accessibilityExtra={changeSpoken(monthChange) ?? undefined}
      >
        <View style={styles.pill}>
          <Text variant="labelMedium" style={styles.pillText}>
            {changeText(monthChange) ?? "Not enough history yet for last month"}
          </Text>
        </View>
        {data.since_start ? (
          <Text variant="bodySmall" style={styles.onTile}>
            {changeText(data.since_start, startSince)}
          </Text>
        ) : null}
      </Tile>

      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Net worth line from ${formatDate(first.date)}, ${wholeRupees(first.net_worth)}, to today, ${wholeRupees(today.net_worth)}`}
      >
        <ChunkyBox style={styles.chartCard}>
          <NetWorthLine points={points} height={170} color={BRAND.greenStrong} estimatedColor={BRAND.zinc500} showDots />
          <View style={styles.ends}>
            <Text variant="bodySmall" style={styles.muted}>
              {formatDate(first.date)}
            </Text>
            <Text variant="bodySmall" style={styles.muted}>
              Today
            </Text>
          </View>
          {points.length < 2 ? (
            <Text variant="bodySmall" style={styles.muted}>
              Your trend starts today. A new point is saved every night.
            </Text>
          ) : null}
        </ChunkyBox>
      </View>

      {note ? (
        <View style={styles.note}>
          <Text variant="bodySmall" style={styles.noteText}>
            ✏️ {note} Dashed points are estimates.
          </Text>
        </View>
      ) : null}

      <Text variant="titleSmall" accessibilityRole="header" style={styles.groupTitle}>
        Month by month
      </Text>
      {monthRows(points).map((row) => (
        <Row
          key={row.key}
          emoji={row.today ? "📍" : "🗓️"}
          tone={row.today ? "yellow" : "card"}
          title={row.label}
          meta={
            row.point.estimated ? (
              <Tag label="estimated" tone="due" />
            ) : (
              <Text variant="bodySmall" style={styles.muted}>
                {formatDate(row.point.date)}
              </Text>
            )
          }
          amount={wholeRupees(row.point.net_worth)}
          amountTone={row.point.net_worth.startsWith("-") ? "loss" : undefined}
          accessibilityLabel={`${row.label}, ${wholeRupees(row.point.net_worth)}${row.point.estimated ? ", estimated" : ""}`}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  error: { color: BRAND.loss },
  pill: {
    alignSelf: "flex-start",
    marginTop: 8,
    backgroundColor: BRAND.card,
    borderColor: BRAND.ink,
    borderWidth: 2,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  pillText: { color: BRAND.ink, fontVariant: ["tabular-nums"] },
  onTile: { color: "#FFFFFF", marginTop: 6 },
  chartCard: { padding: 12, gap: 6 },
  ends: { flexDirection: "row", justifyContent: "space-between" },
  muted: { color: BRAND.zinc600 },
  note: {
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: BRAND.ink,
    borderRadius: 14,
    backgroundColor: BRAND.due,
    padding: 10,
  },
  noteText: { color: BRAND.ink },
  groupTitle: { color: BRAND.ink, marginTop: 4 },
});
