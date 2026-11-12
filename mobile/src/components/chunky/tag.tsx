import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { BRAND } from "@/lib/theme";

type Props = { label: string; tone?: "card" | "due" };

// A small read-only label inside a row, like "SMS" or "estimated". Not a button.
export function Tag({ label, tone = "card" }: Props) {
  return (
    <View style={[styles.tag, { backgroundColor: tone === "due" ? BRAND.due : BRAND.card }]}>
      <Text variant="labelSmall" style={styles.text}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignSelf: "flex-start",
    borderWidth: 1.5,
    borderColor: BRAND.ink,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
    marginTop: 3,
  },
  text: { color: BRAND.ink, fontSize: 10, lineHeight: 14, letterSpacing: 0.4, textTransform: "uppercase" },
});
