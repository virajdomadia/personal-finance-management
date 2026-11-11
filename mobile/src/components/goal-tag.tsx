import { router } from "expo-router";
import { StyleSheet } from "react-native";
import { Chip, Text, useTheme } from "react-native-paper";

import type { GoalTag } from "@/lib/accounts";

// Opens a goal's screen.
export const openGoal = (id: number) => router.push({ pathname: "/goal", params: { id: String(id) } });

// "For: Bike" on a holding's own screen: a chip that opens the goal it counts toward.
export function GoalTagChip({ tag }: { tag: GoalTag | null | undefined }) {
  if (!tag) return null;
  return (
    <Chip
      icon="flag-outline"
      compact
      onPress={() => openGoal(tag.id)}
      accessibilityRole="button"
      accessibilityLabel={`For ${tag.name}. Opens the goal`}
      style={styles.chip}
    >
      For: {tag.name}
    </Chip>
  );
}

// The same tag as a quiet line inside a row, where the whole row already has its own tap.
export function GoalTagLine({ tag }: { tag: GoalTag | null | undefined }) {
  const { colors } = useTheme();
  if (!tag) return null;
  return (
    <Text variant="bodySmall" style={{ color: colors.primary }}>
      For: {tag.name}
    </Text>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: "flex-start" },
});
