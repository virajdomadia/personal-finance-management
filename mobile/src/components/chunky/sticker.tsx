import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { BRAND } from "@/lib/theme";

// A round tilted badge, like "+12%". Place it inside a relative box; it sits on the top right edge.
export function Sticker({ text }: { text: string }) {
  return (
    <View style={styles.sticker}>
      <Text variant="labelMedium" style={styles.text}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sticker: {
    position: "absolute",
    top: -14,
    right: 8,
    zIndex: 1,
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    backgroundColor: BRAND.yellow,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "12deg" }],
  },
  text: { color: BRAND.ink, textAlign: "center", fontSize: 13, lineHeight: 15 },
});
