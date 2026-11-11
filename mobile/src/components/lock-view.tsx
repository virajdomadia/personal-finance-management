import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { ChunkyButton } from "@/components/chunky";
import { BRAND } from "@/lib/theme";

type Props = { onUnlock: () => void; onLogOut: () => void };

// The lock screen's content. It shows nothing about the user.
export function LockView({ onUnlock, onLogOut }: Props) {
  return (
    <>
      <View style={styles.message}>
        <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.emoji}>
          🔒
        </Text>
        <Text variant="headlineMedium" accessibilityRole="header" style={styles.title}>
          Welcome back!
        </Text>
        <Text variant="bodyMedium" style={styles.sub}>
          Use your fingerprint or device PIN to continue.
        </Text>
      </View>
      <View style={styles.actions}>
        <ChunkyButton label="Unlock" icon="fingerprint" onPress={onUnlock} />
        <ChunkyButton label="Log out" variant="alt" onPress={onLogOut} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  message: { marginTop: 96, alignItems: "center", gap: 10 },
  emoji: { fontSize: 56, lineHeight: 68 },
  title: { color: BRAND.ink, textAlign: "center" },
  sub: { color: BRAND.zinc600, textAlign: "center" },
  actions: { gap: 12 },
});
