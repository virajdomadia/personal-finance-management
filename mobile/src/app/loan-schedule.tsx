import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { type LoanSchedule, type ScheduleRow, errorMessage, formatDueDate, formatRupees, scheduleSummary } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const whole = (amount: string) => formatRupees(amount.replace(/\.00$/, ""));
// "5 Dec 2026", or "Dec 2026" when the loan has no due day.
const when = (r: ScheduleRow) =>
  r.due ? `${formatDueDate(r.due)} ${r.due.slice(0, 4)}` : `${MONTHS[Number(r.month.slice(5)) - 1]} ${r.month.slice(0, 4)}`;

// A loan's EMIs from here to the end, split into interest and principal.
export default function LoanScheduleScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [schedule, setSchedule] = useState<LoanSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    apiFetch<LoanSchedule>(`/accounts/${id}/schedule`, { token: token ?? undefined })
      .then((s) => {
        if (current) setSchedule(s);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logOut();
        else if (current) setError(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
      });
    return () => {
      current = false;
    };
  }, [id, token, logOut]);

  const summary = schedule ? scheduleSummary(schedule) : null;
  const header = (
    <View style={styles.head}>
      {error ? <Banner messages={[error]} /> : null}
      {schedule?.paid_off ? <Text variant="bodyLarge">Paid off. Nothing left to repay.</Text> : null}
      {schedule?.problem ? (
        <Text variant="bodyLarge" style={styles.problem}>
          {schedule.problem}
        </Text>
      ) : null}
      {summary && schedule ? (
        <ChunkyBox style={styles.card}>
          <Text variant="titleSmall" style={styles.ink}>
            {summary}
          </Text>
          <Text variant="bodySmall" style={styles.muted}>
            {schedule.rate}% a year · EMI {whole(schedule.emi ?? "0")} · from {whole(schedule.owed)} owed today
          </Text>
        </ChunkyBox>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={name ? `${name}: schedule` : "Repayment schedule"} back />
      {schedule === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Working out the schedule" />
        </View>
      ) : (
        <FlatList
          data={summary ? schedule?.rows ?? [] : []}
          keyExtractor={(r) => r.month}
          ListHeaderComponent={header}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
          renderItem={({ item }) => (
            <View
              style={styles.row}
              accessible
              accessibilityLabel={`${when(item)}: EMI ${whole(item.amount)}, interest ${whole(item.interest)}, principal ${whole(item.principal)}, ${whole(item.left)} left`}
            >
              <View style={styles.rowTop}>
                <Text variant="bodyLarge" style={styles.ink}>
                  {when(item)}
                </Text>
                <Text variant="bodyLarge" style={[styles.ink, styles.num]}>
                  {whole(item.amount)}
                </Text>
              </View>
              <Text variant="bodySmall" style={styles.muted}>
                Interest {whole(item.interest)} · principal {whole(item.principal)} · left {whole(item.left)}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { paddingHorizontal: 16 },
  head: { gap: 12, paddingVertical: 12 },
  card: { padding: 14, gap: 4 },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
  problem: { color: BRAND.loss },
  num: { fontVariant: ["tabular-nums"] },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: BRAND.zinc200, gap: 2 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
});
