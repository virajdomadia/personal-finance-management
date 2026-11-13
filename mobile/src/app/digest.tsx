import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CategoryIcon, ShareBar } from "@/components/category-icon";
import { ChunkyBox, ChunkyButton, ProgressBar, Row, ScreenHeader, Segmented, Tag } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage, formatDueDate } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Digest,
  changeBadge,
  digestPath,
  dueSummary,
  riskText,
  usualText,
  weekRange,
  weekTabLabel,
} from "@/lib/digest";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { KIND_EMOJI, itemAmountText, itemSpoken } from "@/lib/upcoming";

type Which = "week" | "so_far";
const BADGE = { more: BRAND.pinkStrong, less: BRAND.greenStrong, same: BRAND.zinc600 } as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

// The weekly digest, fetched live: what the weekly summary notification opens. Every figure and the
// headline come from the server.
export default function DigestScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [which, setWhich] = useState<Which>("week");
  const [data, setData] = useState<Digest | null>(null);
  // The server's default week, once seen: it names the first tab, and from Sunday 6 pm it is this
  // week, when "This week so far" would show the same days and is left out.
  const [defaultWeek, setDefaultWeek] = useState<{ label: string; isCurrent: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<Digest>(digestPath(which === "so_far"), { token: token ?? undefined });
      if (mine !== latest.current) return;
      setData(result);
      setError(null);
      if (which === "week") setDefaultWeek({ label: result.label, isCurrent: result.is_current });
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setError(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
    }
  }, [token, logOut, which]);

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

  const choose = (next: Which) => {
    if (next === which) return;
    setData(null);
    setError(null);
    setWhich(next);
  };

  const badge = data ? changeBadge(data) : null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Your week" back />
      {defaultWeek !== null && !defaultWeek.isCurrent ? (
        <View style={styles.switch}>
          <Segmented<Which>
            label="Which week"
            value={which}
            onChange={choose}
            options={[
              { value: "week", label: weekTabLabel(defaultWeek.label) },
              { value: "so_far", label: "This week so far" },
            ]}
          />
        </View>
      ) : null}
      {data === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading your week" />
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

          <ChunkyBox style={styles.hero}>
            <Text variant="labelMedium" style={styles.heroLabel}>
              🗞️ {weekRange(data.week_start, data.through)}
            </Text>
            <Text variant="titleLarge" style={styles.headline}>
              {data.headline}
            </Text>
            <View style={styles.heroRow}>
              <Text
                variant="titleLarge"
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.5}
                style={styles.spent}
                accessibilityLabel={`Spent ${whole(data.spending)}`}
              >
                {whole(data.spending)}
              </Text>
              {badge ? (
                <View style={[styles.badge, { backgroundColor: BADGE[data.tone ?? "same"] }]}>
                  <Text variant="labelMedium" style={styles.badgeText}>
                    {badge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text variant="bodySmall" style={styles.heroLabel}>
              {usualText(data)}
            </Text>
          </ChunkyBox>

          <Section title="Where it went">
            {data.top_spending.length === 0 ? (
              <Text variant="bodyMedium" style={styles.muted}>
                No spending recorded.
              </Text>
            ) : (
              data.top_spending.map((c) => (
                <View
                  key={c.id ?? c.name}
                  style={styles.category}
                  accessible
                  accessibilityLabel={`${c.name}, ${whole(c.amount)}, ${c.percent}%`}
                >
                  <CategoryIcon icon={c.icon} colour={c.colour} size={32} />
                  <View style={styles.grow}>
                    <View style={styles.between}>
                      <Text variant="titleSmall" style={styles.ink} numberOfLines={1}>
                        {c.name}
                      </Text>
                      <Text variant="titleSmall" style={styles.amount}>
                        {whole(c.amount)}
                      </Text>
                    </View>
                    <ShareBar width={c.percent} colour={c.colour} />
                  </View>
                </View>
              ))
            )}
            <ChunkyButton
              label="Month report"
              variant="alt"
              onPress={() => router.push({ pathname: "/cash-flow", params: { month: data.budgets.month } })}
            />
          </Section>

          <Section title={`Budgets at risk · ${data.budgets.elapsed_percent}% of the month gone`}>
            {data.budgets.at_risk.length === 0 ? (
              <Text variant="bodyMedium" style={styles.muted}>
                Every budget is on track.
              </Text>
            ) : (
              data.budgets.at_risk.map((r) => (
                <Row
                  key={r.category_id}
                  emoji={r.status === "over" ? "🚨" : "⏳"}
                  tone={r.status === "over" ? "pink" : "orange"}
                  title={r.name}
                  meta={
                    <View style={styles.riskMeta}>
                      <ProgressBar percent={r.bar} reached={false} warn={r.status === "over"} label={`${r.name} budget used`} />
                      <Text variant="bodySmall" style={r.status === "over" ? styles.loss : styles.muted}>
                        {riskText(r)}
                      </Text>
                    </View>
                  }
                  amount={`${r.percent ?? 0}%`}
                  amountTone={r.status === "over" ? "loss" : undefined}
                  onPress={() => router.push("/budgets")}
                  accessibilityLabel={`${r.name}, ${r.percent ?? 0}% used, ${riskText(r)}`}
                  accessibilityHint="Opens Budgets"
                />
              ))
            )}
          </Section>

          <Section title="Coming up">
            <Text variant="bodyMedium" style={styles.muted}>
              {dueSummary(data)}
            </Text>
            {data.due.items.map((item, i) => (
              <Row
                key={`${item.kind}-${item.ref_id}-${i}`}
                emoji={KIND_EMOJI[item.kind]}
                tone={item.direction === "in" ? "green" : item.direction === "none" ? "purple" : "pink"}
                title={item.name}
                highlight={item.overdue}
                meta={
                  <View style={styles.dueMeta}>
                    <Text variant="bodySmall" style={styles.muted}>
                      {formatDueDate(item.date)}
                    </Text>
                    {item.overdue ? <Tag label="Overdue" tone="due" /> : null}
                  </View>
                }
                amount={itemAmountText(item)}
                amountTone={item.direction === "in" ? "gain" : undefined}
                accessibilityLabel={`${formatDueDate(item.date)}, ${itemSpoken(item)}`}
              />
            ))}
            <ChunkyButton label="Next 30 days" variant="alt" onPress={() => router.push("/upcoming")} />
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  switch: { paddingHorizontal: 16, paddingBottom: 4 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 18 },
  hero: { padding: 16, gap: 6, backgroundColor: BRAND.purpleStrong },
  heroLabel: { color: "#FFFFFF" },
  headline: { color: "#FFFFFF", fontSize: 22, lineHeight: 28 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  spent: { color: "#FFFFFF", fontSize: 32, lineHeight: 38, fontVariant: ["tabular-nums"], flexShrink: 1 },
  badge: { borderRadius: 999, borderWidth: 2, borderColor: BRAND.ink, paddingHorizontal: 10, paddingVertical: 2 },
  badgeText: { color: "#FFFFFF" },
  section: { gap: 10 },
  sectionTitle: { color: BRAND.ink, letterSpacing: 0.4 },
  category: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1, gap: 4 },
  between: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  ink: { color: BRAND.ink, flexShrink: 1 },
  amount: { color: BRAND.ink, fontVariant: ["tabular-nums"] },
  muted: { color: BRAND.zinc600 },
  loss: { color: BRAND.loss },
  riskMeta: { gap: 4, marginTop: 4 },
  dueMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
});
