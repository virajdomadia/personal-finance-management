import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { Chip } from "@/components/chunky";
import type { GoalTag } from "@/lib/accounts";
import { BRAND } from "@/lib/theme";

// Opens a goal's screen.
export const openGoal = (id: number) => router.push({ pathname: "/goal", params: { id: String(id) } });

// "For: Bike" on a holding's own screen: a chip that opens the goal it counts toward.
export function GoalTagChip({ tag }: { tag: GoalTag | null | undefined }) {
  if (!tag) return null;
  return (
    <View style={styles.chip}>
      <Chip
        icon="flag-outline"
        label={`For: ${tag.name}`}
        onPress={() => openGoal(tag.id)}
        accessibilityRole="button"
        accessibilityLabel={`For ${tag.name}. Opens the goal`}
      />
    </View>
  );
}

// The same tag as a quiet line inside a row, where the whole row already has its own tap.
export function GoalTagLine({ tag }: { tag: GoalTag | null | undefined }) {
  if (!tag) return null;
  return (
    <Text variant="bodySmall" style={styles.line}>
      For: {tag.name}
    </Text>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: "flex-start" },
  line: { color: BRAND.pinkStrong, fontSize: 12, lineHeight: 16 },
});
