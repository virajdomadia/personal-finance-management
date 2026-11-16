import { StyleSheet, View } from "react-native";
import { useTheme } from "react-native-paper";

import { EmptyState, ScreenHeader } from "@/components/chunky";
import { SMS_OWN_PROFILE } from "@/lib/family";
import { useProfile } from "@/lib/profile";

// Stands in for a screen that is always the owner's (the bank SMS ones) while a family member is
// chosen, so nothing from the owner's messages is recorded into the member's accounts.
export function OwnProfileOnly({ title }: { title: string }) {
  const { colors } = useTheme();
  const { switchProfile } = useProfile();
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={title} back />
      <EmptyState
        emoji="📩"
        title={SMS_OWN_PROFILE}
        body="Your bank's messages are yours, so they are reviewed into your own accounts. Go back to your profile to review them."
        action={{ label: "Back to me", onPress: () => switchProfile(null) }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
