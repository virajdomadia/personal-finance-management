import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { STACK_COLORS } from "@/lib/fun";
import { BRAND } from "@/lib/theme";

type Props = { items: { label: string; value: number }[]; label: string };

// One bar split by share, with a legend. A screen reader gets the label and the percentages once,
// from the bar; the legend is hidden from it. Nothing shows when there is nothing to split.
export function StackedBar({ items, label }: Props) {
  const shown = items.filter((item) => item.value > 0);
  const total = shown.reduce((sum, item) => sum + item.value, 0);
  if (!(total > 0)) return null;
  const parts = shown.map((item, i) => ({
    ...item,
    percent: (item.value / total) * 100,
    color: STACK_COLORS[i % STACK_COLORS.length],
  }));
  const spoken = parts.map((p) => `${p.label} ${Math.round(p.percent)}%`).join(", ");
  return (
    <View style={styles.wrap}>
      <View accessible accessibilityRole="image" accessibilityLabel={`${label}: ${spoken}`} style={styles.bar}>
        {parts.map((p, i) => (
          <View
            key={p.label}
            style={[styles.segment, i > 0 ? styles.divider : null, { width: `${p.percent}%`, backgroundColor: p.color }]}
          />
        ))}
      </View>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.legend}>
        {parts.map((p) => (
          <View key={p.label} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: p.color }]} />
            <Text variant="labelMedium" style={styles.legendText}>
              {p.label} {Math.round(p.percent)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  bar: {
    flexDirection: "row",
    height: 18,
    overflow: "hidden",
    borderRadius: 999,
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    backgroundColor: BRAND.card,
  },
  segment: { height: "100%" },
  divider: { borderLeftWidth: 2, borderLeftColor: BRAND.ink },
  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6, marginTop: 8 },
  legendItem: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
  swatch: { width: 12, height: 12, borderRadius: 3, borderWidth: 2, borderColor: BRAND.ink, marginRight: 6 },
  legendText: { color: BRAND.ink, fontSize: 12, lineHeight: 16, flexShrink: 1 },
});
