import { StyleSheet, View } from "react-native";
import { Icon } from "react-native-paper";

import { colourOf, iconName, inkOn } from "@/lib/categories";
import { BRAND } from "@/lib/theme";

// A category's icon on its colour, in an ink-bordered square. Decorative: the name is always beside it.
export function CategoryIcon({ icon, colour, size = 38 }: { icon: string | null; colour: string | null; size?: number }) {
  const fill = colourOf(colour);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.square, { width: size, height: size, borderRadius: size * 0.26, backgroundColor: fill }]}
    >
      <Icon source={iconName(icon)} size={Math.round(size * 0.52)} color={inkOn(fill) ? BRAND.ink : "#FFFFFF"} />
    </View>
  );
}

// A share bar filled in the category's colour, from the server's percent.
export function ShareBar({ width, colour }: { width: number; colour: string | null }) {
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${width}%`, backgroundColor: colourOf(colour) }, width > 0 && width < 100 ? styles.edge : null]} />
    </View>
  );
}

const styles = StyleSheet.create({
  square: { borderWidth: 2.5, borderColor: BRAND.ink, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  track: {
    height: 12,
    overflow: "hidden",
    borderRadius: 999,
    borderWidth: 2,
    borderColor: BRAND.ink,
    backgroundColor: BRAND.zinc100,
  },
  fill: { height: "100%" },
  edge: { borderRightWidth: 2, borderRightColor: BRAND.ink },
});
