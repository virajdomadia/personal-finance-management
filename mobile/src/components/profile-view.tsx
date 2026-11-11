import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { Row, ScreenHeader, Tile } from "@/components/chunky";
import { StreakPill } from "@/components/dashboard-view";
import { BRAND } from "@/lib/theme";

type Props = {
  streak: number | null;
  onGoals: () => void;
  onRecurring: () => void;
  onInsurance: () => void;
  onArchived: () => void;
  onLogOut: () => void;
};

// The profile tab's content, without the session or fetching.
export function ProfileView({ streak, onGoals, onRecurring, onInsurance, onArchived, onLogOut }: Props) {
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
        <View style={styles.menu}>
          <Row emoji="🎯" tone="purple" title="Goals" meta="Money set aside for what you're saving for" amount="›" onPress={onGoals} accessibilityLabel="Goals" accessibilityHint="Opens Goals" />
          <Row emoji="🔁" tone="blue" title="Recurring" meta="Rent, salary and other regular payments" amount="›" onPress={onRecurring} accessibilityLabel="Recurring" accessibilityHint="Opens Recurring" />
          <Row emoji="🛡️" tone="green" title="Insurance" meta="Health policies and renewals" amount="›" onPress={onInsurance} accessibilityLabel="Insurance" accessibilityHint="Opens Insurance" />
          <Row emoji="🗄️" tone="card" title="Archived accounts" amount="›" onPress={onArchived} accessibilityLabel="Archived accounts" accessibilityHint="Opens Archived accounts" />
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
});
