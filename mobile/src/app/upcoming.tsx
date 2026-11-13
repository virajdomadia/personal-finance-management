import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, EmptyState, Row, ScreenHeader, Tag, type Tone } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage, formatDueDate } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { signedWhole } from "@/lib/cash-flow";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import {
  KIND_EMOJI,
  UPCOMING_PATH,
  type Upcoming,
  type UpcomingItem,
  balanceText,
  dayHeading,
  groupByDay,
  isNegative,
  itemAmountText,
  itemDetail,
  itemSpoken,
} from "@/lib/upcoming";

const TONE: Record<UpcomingItem["direction"], Tone> = { out: "pink", in: "green", none: "purple" };

function Balance({ label, amount }: { label: string; amount: string }) {
  return (
    <View accessible accessibilityLabel={`${label}, ${signedWhole(amount)}`}>
      <ChunkyBox style={styles.balance}>
        <Text variant="labelMedium" style={styles.muted}>
          {label}
        </Text>
        <Text
          variant="titleLarge"
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
          style={[styles.balanceValue, isNegative(amount) ? styles.loss : null]}
        >
          {signedWhole(amount)}
        </Text>
      </ChunkyBox>
    </View>
  );
}

function ItemRow({ item }: { item: UpcomingItem }) {
  const after = balanceText(item.balance_after);
  return (
    <Row
      emoji={KIND_EMOJI[item.kind]}
      tone={TONE[item.direction]}
      title={item.name}
      highlight={item.overdue}
      meta={
        <>
          {itemDetail(item).map((line) => (
            <Text key={line} variant="bodySmall" style={styles.meta}>
              {line}
            </Text>
          ))}
          {item.overdue ? <Tag label="Overdue" tone="due" /> : null}
        </>
      }
      amount={itemAmountText(item)}
      amountTone={item.varies ? undefined : item.direction === "in" ? "gain" : undefined}
      sub={
        <Text variant="bodySmall" style={[styles.meta, styles.right, isNegative(item.balance_after) ? styles.loss : null]}>
          {after}
        </Text>
      }
      accessibilityLabel={itemSpoken(item)}
    />
  );
}

export default function UpcomingScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<Upcoming | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<Upcoming>(UPCOMING_PATH, { token: token ?? undefined });
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

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Next 30 days" back />
      {data === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading the next 30 days" />
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
            Up to {formatDueDate(data.through)}, with anything overdue. The balance is your bank, cash and wallet accounts
            together; card charges and goal set-asides don&apos;t move it.
          </Text>
          <Balance label="Balance now" amount={data.starting_balance} />

          {data.items.length === 0 ? (
            <EmptyState
              compact
              emoji="🌤️"
              title="Nothing due in the next 30 days"
              body="Reminders, premiums, EMIs, SIPs, RD instalments, card bills and goal set-asides show here when they're coming up."
            />
          ) : (
            groupByDay(data.items).map((g) => (
              <View key={g.date} style={styles.day}>
                <Text variant="titleSmall" accessibilityRole="header" style={[styles.dayTitle, g.date < data.start ? styles.loss : null]}>
                  {dayHeading(g.date, data.start)}
                </Text>
                {g.items.map((item, i) => (
                  <ItemRow key={`${item.kind}-${item.ref_id}-${i}`} item={item} />
                ))}
              </View>
            ))
          )}

          {data.items.length > 0 ? <Balance label={`Balance on ${formatDueDate(data.through)}`} amount={data.ending_balance} /> : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  muted: { color: BRAND.zinc600 },
  meta: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  right: { textAlign: "right" },
  loss: { color: BRAND.loss },
  balance: { padding: 14, gap: 2, backgroundColor: BRAND.yellow },
  balanceValue: { color: BRAND.ink, fontSize: 26, lineHeight: 32, fontVariant: ["tabular-nums"] },
  day: { gap: 8 },
  dayTitle: { color: BRAND.ink, letterSpacing: 0.4, marginTop: 4 },
});
