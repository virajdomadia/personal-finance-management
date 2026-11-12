import { ScrollView, StyleSheet } from "react-native";
import { Text } from "react-native-paper";

import { ChunkyBox, Chip } from "@/components/chunky";
import { BRAND } from "@/lib/theme";

export type LinkItem = { id: number; text: string };

// A card on the investments tab while some holdings of the shown kind have no live-price link.
// Each chip opens that holding, where "Link to live prices" is.
export function LinkPrompt({ items, onOpen }: { items: LinkItem[]; onOpen: (item: LinkItem) => void }) {
  if (items.length === 0) return null;
  return (
    <ChunkyBox radius={18} offset={4} style={styles.card}>
      <Text variant="titleMedium" accessibilityRole="header" style={styles.title}>
        Let Gullak fetch your prices
      </Text>
      <Text variant="bodySmall" style={styles.body}>
        Link each holding once and its price updates every night.
      </Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {items.map((item) => (
          <Chip
            key={item.id}
            label={item.text}
            icon="link-variant"
            accessibilityLabel={`Link ${item.text} to live prices`}
            onPress={() => onOpen(item)}
          />
        ))}
      </ScrollView>
    </ChunkyBox>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: BRAND.due, padding: 14, gap: 6 },
  title: { color: BRAND.ink },
  body: { color: BRAND.ink },
  chips: { gap: 8, paddingVertical: 8, paddingRight: 4 },
});
