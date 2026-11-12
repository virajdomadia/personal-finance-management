import { router, useFocusEffect } from "expo-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, Row, ScreenHeader, Tag } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { signedWhole } from "@/lib/cash-flow";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import {
  KIND_EMOJI,
  SAFE_TO_SPEND_PATH,
  type SafeToSpend,
  budgetPartMeta,
  dueHeading,
  duePartMeta,
  isNegative,
  isShort,
  safeText,
  untilText,
} from "@/lib/upcoming";

// One part of the sum: a heading with its figure, then the lines that make it up.
function Part({
  sign,
  title,
  total,
  empty,
  children,
}: {
  sign: "" | "−";
  title: string;
  total: string;
  empty: string;
  children: ReactNode[];
}) {
  return (
    <View style={styles.part}>
      <View style={styles.partHead} accessible accessibilityRole="header" accessibilityLabel={`${sign ? "Minus " : ""}${title}, ${signedWhole(total)}`}>
        <Text variant="titleSmall" style={styles.partTitle}>
          {sign ? `${sign} ` : ""}
          {title.toUpperCase()}
        </Text>
        <Text variant="titleSmall" style={[styles.partTotal, isNegative(total) ? styles.loss : null]}>
          {signedWhole(total)}
        </Text>
      </View>
      {children.length === 0 ? (
        <Text variant="bodySmall" style={styles.muted}>
          {empty}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

export default function SafeToSpendScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<SafeToSpend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<SafeToSpend>(SAFE_TO_SPEND_PATH, { token: token ?? undefined });
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
      <ScreenHeader title="Safe to spend" back />
      {data === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading safe to spend" />
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

          <ChunkyBox style={[styles.hero, { backgroundColor: isShort(data.amount) ? BRAND.pinkStrong : BRAND.blueStrong }]}>
            <Text variant="labelMedium" style={styles.white}>
              🛟 Safe to spend
            </Text>
            <Text
              variant="titleLarge"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.5}
              accessibilityLiveRegion="polite"
              style={styles.heroValue}
            >
              {safeText(data.amount)}
            </Text>
            <Text variant="bodyMedium" style={styles.white}>
              {untilText(data)}
            </Text>
            {isShort(data.amount) ? (
              <Text variant="bodySmall" style={styles.white}>
                What&apos;s due, set aside and budgeted is more than you have right now.
              </Text>
            ) : null}
          </ChunkyBox>

          <Text variant="bodySmall" style={styles.muted}>
            Money now, less what&apos;s due {data.reason === "salary" ? "before payday" : "before the month ends"}, what&apos;s set
            aside for goals and what&apos;s left in this month&apos;s budgets. Expected income isn&apos;t counted until it arrives.
          </Text>

          <Part sign="" title="Money now" total={data.money} empty="No bank, cash or wallet accounts.">
            {data.money_items.map((p, i) => (
              <Row
                key={`m-${i}`}
                emoji="🏦"
                tone="yellow"
                title={p.name}
                amount={signedWhole(p.amount)}
                amountTone={isNegative(p.amount) ? "loss" : undefined}
                accessibilityLabel={`${p.name}, ${signedWhole(p.amount)}`}
              />
            ))}
          </Part>

          <Part sign="−" title={dueHeading(data)} total={data.due} empty="Nothing due.">
            {data.due_items.map((d, i) => (
              <Row
                key={`d-${i}`}
                emoji={KIND_EMOJI[d.kind]}
                tone="due"
                title={d.name}
                highlight={d.overdue}
                meta={
                  <>
                    <Text variant="bodySmall" style={styles.meta}>
                      {duePartMeta(d)}
                    </Text>
                    {d.overdue ? <Tag label="Overdue" tone="due" /> : null}
                  </>
                }
                amount={whole(d.amount)}
                accessibilityLabel={`${d.name}, ${duePartMeta(d)}, ${whole(d.amount)}`}
              />
            ))}
          </Part>

          <Part sign="−" title="Set aside for goals" total={data.goals} empty="Nothing set aside.">
            {data.goal_items.map((g, i) => (
              <Row
                key={`g-${i}`}
                emoji="🎯"
                tone="purple"
                title={g.name}
                amount={signedWhole(g.amount)}
                accessibilityLabel={`${g.name}, ${signedWhole(g.amount)}`}
              />
            ))}
          </Part>

          <Part sign="−" title="Budgets left" total={data.budgets} empty="No budgets this month.">
            {data.budget_items.map((b) => (
              <Row
                key={b.category_id}
                emoji="💰"
                tone="green"
                title={b.name}
                meta={budgetPartMeta(b)}
                amount={whole(b.amount)}
                accessibilityLabel={`${b.name}, ${budgetPartMeta(b)}, ${whole(b.amount)}`}
              />
            ))}
          </Part>

          <View accessible accessibilityLabel={`Safe to spend, ${safeText(data.amount)}`}>
          <ChunkyBox style={styles.result}>
            <Text variant="titleSmall" style={styles.partTitle}>
              = SAFE TO SPEND
            </Text>
            <Text variant="titleMedium" style={[styles.partTotal, isShort(data.amount) ? styles.loss : null]}>
              {safeText(data.amount)}
            </Text>
          </ChunkyBox>
          </View>

          <ChunkyButton label="Next 30 days" icon="calendar-month-outline" onPress={() => router.push("/upcoming")} />
          <ChunkyButton label="Budgets" icon="piggy-bank-outline" variant="alt" onPress={() => router.push("/budgets")} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 14 },
  muted: { color: BRAND.zinc600 },
  meta: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  loss: { color: BRAND.loss },
  white: { color: "#FFFFFF" },
  hero: { padding: 16, gap: 4 },
  heroValue: { color: "#FFFFFF", fontSize: 36, lineHeight: 44, fontVariant: ["tabular-nums"] },
  part: { gap: 8 },
  partHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 4 },
  partTitle: { color: BRAND.ink, letterSpacing: 0.6, flexShrink: 1 },
  partTotal: { color: BRAND.ink, fontVariant: ["tabular-nums"] },
  result: { padding: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: BRAND.due },
});
