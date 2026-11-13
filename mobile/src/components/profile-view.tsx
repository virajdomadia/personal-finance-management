import { StyleSheet, View } from "react-native";
import { Switch, Text } from "react-native-paper";

import { ChunkyBox, Row, ScreenHeader, Tile } from "@/components/chunky";
import { streakLabel } from "@/lib/fun";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

type Props = {
  streak: number | null;
  summaryOn: boolean;
  summaryBusy: boolean;
  summaryNote: string | null; // why it was turned back off
  onSummary: (on: boolean) => void;
  onGoals: () => void;
  onRecurring: () => void;
  onInsurance: () => void;
  onArchived: () => void;
  onSms: () => void;
  onPayeeRules: () => void;
  onCategories: () => void;
  onBudgets: () => void;
  onExport: () => void;
  onLogOut: () => void;
};

// The streak chip, hidden when there is no streak.
function StreakPill({ days }: { days: number | null }) {
  const label = days === null ? null : streakLabel(days);
  if (!label) return null;
  return (
    <View accessible accessibilityLabel={`${days}-day streak`}>
      <ChunkyBox radius={999} offset={SHADOW_OFFSET_SM} style={styles.pill}>
        <Text variant="labelLarge" style={styles.pillText}>
          {label}
        </Text>
      </ChunkyBox>
    </View>
  );
}

// The profile tab's content, without the session or fetching.
export function ProfileView({ streak, summaryOn, summaryBusy, summaryNote, onSummary, onGoals, onRecurring, onInsurance, onArchived, onSms, onPayeeRules, onCategories, onBudgets, onExport, onLogOut }: Props) {
  return (
    <View>
      <ScreenHeader title="You" right={<StreakPill days={streak} />} />
      <View style={styles.body}>
        <Tile tone="yellow" emoji="🔥" label="Streak">
          <Text variant="titleMedium" style={styles.streak}>
            {streak !== null && streak > 0
              ? `Logging for ${streak} ${streak === 1 ? "day" : "days"} in a row`
              : "Log a transaction to start a streak"}
          </Text>
        </Tile>
        <ChunkyBox radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.summary}>
          <View style={styles.summaryRow}>
            <View style={styles.summaryText}>
              <Text variant="titleSmall" style={styles.ink}>
                🗞️ Weekly summary
              </Text>
              <Text variant="bodySmall" style={styles.muted}>
                A reminder on Sunday at 7 pm (phone time) to see what you spent, budgets at risk and what&apos;s due next. Logging out turns it off.
              </Text>
            </View>
            <Switch
              value={summaryOn}
              disabled={summaryBusy}
              onValueChange={onSummary}
              color={BRAND.greenStrong}
              accessibilityLabel="Weekly summary"
            />
          </View>
          {summaryNote ? (
            <Text variant="bodySmall" accessibilityRole="alert" style={styles.note}>
              {summaryNote}
            </Text>
          ) : null}
        </ChunkyBox>
        <View style={styles.menu}>
          <Row emoji="🎯" tone="purple" title="Goals" meta="Money set aside for what you're saving for" amount="›" onPress={onGoals} accessibilityLabel="Goals" accessibilityHint="Opens Goals" />
          <Row emoji="💰" tone="yellow" title="Budgets" meta="A monthly amount for each spending category" amount="›" onPress={onBudgets} accessibilityLabel="Budgets" accessibilityHint="Opens Budgets" />
          <Row emoji="🔁" tone="blue" title="Recurring" meta="Rent, salary and other regular payments" amount="›" onPress={onRecurring} accessibilityLabel="Recurring" accessibilityHint="Opens Recurring" />
          <Row emoji="🛡️" tone="green" title="Insurance" meta="Health policies and renewals" amount="›" onPress={onInsurance} accessibilityLabel="Insurance" accessibilityHint="Opens Insurance" />
          <Row emoji="📩" tone="orange" title="Bank SMS" meta="Fill in transactions from your bank's messages" amount="›" onPress={onSms} accessibilityLabel="Bank SMS" accessibilityHint="Opens Bank SMS settings" />
          <Row emoji="🗂️" tone="green" title="Categories" meta="Rename, nest, merge and colour your categories" amount="›" onPress={onCategories} accessibilityLabel="Categories" accessibilityHint="Opens Categories" />
          <Row emoji="🏷️" tone="yellow" title="Payee rules" meta="Categories and numbers learned from your answers" amount="›" onPress={onPayeeRules} accessibilityLabel="Payee rules" accessibilityHint="Opens Payee rules" />
          <Row emoji="🗄️" tone="card" title="Archived accounts" amount="›" onPress={onArchived} accessibilityLabel="Archived accounts" accessibilityHint="Opens Archived accounts" />
          <Row emoji="💾" tone="blue" title="Export my data" meta="Spreadsheets or a full backup, to save or send" amount="›" onPress={onExport} accessibilityLabel="Export my data" accessibilityHint="Chooses a file to export and share" />
          <Row emoji="🚪" tone="pink" title="Log out" onPress={onLogOut} accessibilityLabel="Log out" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, gap: 12 },
  streak: { color: BRAND.ink, marginTop: 2 },
  menu: { gap: 10 },
  summary: { padding: 14, gap: 6 },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  summaryText: { flex: 1, gap: 2 },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
  note: { color: BRAND.loss },
  pill: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: BRAND.yellow, borderRadius: INPUT_RADIUS },
  pillText: { color: BRAND.ink },
});
