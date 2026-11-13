import { Text as NativeText, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { BRAND } from "@/lib/theme";

import { ChunkyButton } from "./chunky-button";

type Props = {
  emoji: string;
  title: string;
  body?: string; // what this screen is for, in a line or two
  action?: { label: string; onPress: () => void; variant?: "primary" | "alt" };
  compact?: boolean; // less padding, for an empty section on a longer screen
};

// What an empty list shows: what the screen is for, and one clear action.
export function EmptyState({ emoji, title, body, action, compact = false }: Props) {
  return (
    <View style={[styles.wrap, compact ? styles.compact : null]}>
      <NativeText style={styles.emoji} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {emoji}
      </NativeText>
      <Text variant="titleMedium" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {body ? (
        <Text variant="bodyMedium" style={styles.body}>
          {body}
        </Text>
      ) : null}
      {action ? (
        <ChunkyButton label={action.label} variant={action.variant ?? "primary"} onPress={action.onPress} style={styles.action} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 40 },
  compact: { paddingVertical: 16 },
  emoji: { fontSize: 40, lineHeight: 48 },
  title: { color: BRAND.ink, textAlign: "center" },
  body: { color: BRAND.zinc600, textAlign: "center", maxWidth: 420 },
  action: { marginTop: 8, alignSelf: "center" },
});
