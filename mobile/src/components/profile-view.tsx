import { StyleSheet, View } from "react-native";
import { Switch, Text } from "react-native-paper";

import { ChunkyBox, Row, ScreenHeader, Tile } from "@/components/chunky";
import { streakLabel } from "@/lib/fun";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

// One switch in the Notifications card.
export type NotificationSwitch = {
  key: string;
  title: string; // "🗞️ Weekly summary"
  label: string; // the title without the emoji, for screen readers
  text: string;
  on: boolean;
  busy: boolean;
  note: string | null; // why it was turned back off
  onChange: (on: boolean) => void;
};

type Props = {
  viewing: string; // "Viewing: Me"
  viewingMember: boolean;
  onViewing: () => void;
  onManageFamily: () => void;
  streak: number | null;
  notifications: NotificationSwitch[];
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
  onLogOutEverywhere: () => void;
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
export function ProfileView({ viewing, viewingMember, onViewing, onManageFamily, streak, notifications, onGoals, onRecurring, onInsurance, onArchived, onSms, onPayeeRules, onCategories, onBudgets, onExport, onLogOut, onLogOutEverywhere }: Props) {
  return (
    <View>
      <ScreenHeader title="You" right={<StreakPill days={streak} />} />
      <View style={styles.body}>
        <View style={styles.menu}>
          <Row
            emoji={viewingMember ? "👀" : "🙂"}
            tone={viewingMember ? "blue" : "card"}
            title={`${viewing} ▾`}
            meta="Switch to a family member to record their money"
            amount="›"
            onPress={onViewing}
            accessibilityLabel={viewing}
            accessibilityHint="Chooses whose profile to view"
          />
          <Row emoji="👨‍👩‍👧" tone="purple" title="Manage family" meta="Add, rename or remove family members" amount="›" onPress={onManageFamily} accessibilityLabel="Manage family" accessibilityHint="Opens Manage family" />
        </View>
        <Tile tone="yellow" emoji="🔥" label="Streak">
          <Text variant="titleMedium" style={styles.streak}>
            {streak !== null && streak > 0
              ? `Logging for ${streak} ${streak === 1 ? "day" : "days"} in a row`
              : "Log a transaction to start a streak"}
          </Text>
        </Tile>
        <ChunkyBox radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.summary}>
          <Text variant="labelLarge" style={styles.muted} accessibilityRole="header">
            🔔 Notifications · logging out turns them off
          </Text>
          {notifications.map((s, i) => (
            <View key={s.key} style={[styles.switchBlock, i > 0 && styles.divided]}>
              <View style={styles.summaryRow}>
                <View style={styles.summaryText}>
                  <Text variant="titleSmall" style={styles.ink}>
                    {s.title}
                  </Text>
                  <Text variant="bodySmall" style={styles.muted}>
                    {s.text}
                  </Text>
                </View>
                <Switch
                  value={s.on}
                  disabled={s.busy}
                  onValueChange={s.onChange}
                  color={BRAND.greenStrong}
                  accessibilityLabel={s.label}
                />
              </View>
              {s.note ? (
                <Text variant="bodySmall" accessibilityRole="alert" style={styles.note}>
                  {s.note}
                </Text>
              ) : null}
            </View>
          ))}
        </ChunkyBox>
        <View style={styles.menu}>
          <Row emoji="🎯" tone="purple" title="Goals" meta="Money set aside for what you're saving for" amount="›" onPress={onGoals} accessibilityLabel="Goals" accessibilityHint="Opens Goals" />
          <Row emoji="💰" tone="yellow" title="Budgets" meta="A monthly amount for each spending category" amount="›" onPress={onBudgets} accessibilityLabel="Budgets" accessibilityHint="Opens Budgets" />
          <Row emoji="🔁" tone="blue" title="Reminders" meta="Salary, rent, premiums and what's due" amount="›" onPress={onRecurring} accessibilityLabel="Reminders" accessibilityHint="Opens Reminders" />
          <Row emoji="🛡️" tone="green" title="Insurance" meta="Health policies and renewals" amount="›" onPress={onInsurance} accessibilityLabel="Insurance" accessibilityHint="Opens Insurance" />
          <Row emoji="📩" tone="orange" title="Bank SMS" meta="Fill in transactions from your bank's messages" amount="›" onPress={onSms} accessibilityLabel="Bank SMS" accessibilityHint="Opens Bank SMS settings" />
          <Row emoji="🗂️" tone="green" title="Categories" meta="Rename, nest, merge and colour your categories" amount="›" onPress={onCategories} accessibilityLabel="Categories" accessibilityHint="Opens Categories" />
          <Row emoji="🏷️" tone="yellow" title="Payee rules" meta="Categories and numbers learned from your answers" amount="›" onPress={onPayeeRules} accessibilityLabel="Payee rules" accessibilityHint="Opens Payee rules" />
          <Row emoji="🗄️" tone="card" title="Archived accounts" amount="›" onPress={onArchived} accessibilityLabel="Archived accounts" accessibilityHint="Opens Archived accounts" />
          <Row emoji="💾" tone="blue" title="Export my data" meta="Spreadsheets or a full backup, to save or send" amount="›" onPress={onExport} accessibilityLabel="Export my data" accessibilityHint="Chooses a file to export and share" />
          <Row emoji="🚪" tone="pink" title="Log out" onPress={onLogOut} accessibilityLabel="Log out" />
          <Row emoji="🔒" tone="card" title="Sign out everywhere" meta="Every browser and phone, this one too" onPress={onLogOutEverywhere} accessibilityLabel="Sign out everywhere" accessibilityHint="Asks before signing out every device" />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, gap: 12 },
  streak: { color: BRAND.ink, marginTop: 2 },
  menu: { gap: 10 },
  summary: { padding: 14, gap: 10 },
  switchBlock: { gap: 6 },
  divided: { borderTopWidth: 1, borderTopColor: BRAND.zinc200, paddingTop: 10 },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  summaryText: { flex: 1, gap: 2 },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
  note: { color: BRAND.loss },
  pill: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: BRAND.yellow, borderRadius: INPUT_RADIUS },
  pillText: { color: BRAND.ink },
});
