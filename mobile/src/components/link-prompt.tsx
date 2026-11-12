import * as SecureStore from "expo-secure-store";
import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { ChunkyBox, ChunkyButton, Chip } from "@/components/chunky";
import { dismissIds, parseDismissed, shouldShowLinkPrompt } from "@/lib/investments";
import { BRAND } from "@/lib/theme";

export type LinkItem = { id: number; text: string };

// On this device: the unlinked holding ids hidden by "Not now", across all three cards.
const DISMISSED_KEY = "gullak.linkPrompt.dismissed";

function readDismissed(): number[] {
  try {
    return parseDismissed(SecureStore.getItem(DISMISSED_KEY));
  } catch {
    return [];
  }
}

function saveDismissed(ids: number[]): void {
  try {
    SecureStore.setItem(DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Not remembered, then; the card still hides for now.
  }
}

// A card on the investments tab while some holdings of the shown kind have no live-price link.
// Each chip opens that holding, where "Link to live prices" is. "Not now" hides the card until a
// holding that wasn't there then is unlinked.
export function LinkPrompt({ items, onOpen }: { items: LinkItem[]; onOpen: (item: LinkItem) => void }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const ids = items.map((item) => item.id);
  if (!shouldShowLinkPrompt(ids, dismissed)) return null;

  const dismiss = () => {
    // Read again: another card may have added its ids since this one mounted.
    const next = dismissIds(readDismissed(), ids);
    saveDismissed(next);
    setDismissed(next);
  };

  return (
    <ChunkyBox radius={18} offset={4} style={styles.card}>
      <View style={styles.top}>
        <Text variant="titleMedium" accessibilityRole="header" style={styles.title}>
          Let Gullak fetch your prices
        </Text>
        <ChunkyButton compact variant="alt" label="Not now" onPress={dismiss} />
      </View>
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
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { color: BRAND.ink, flexShrink: 1 },
  body: { color: BRAND.ink },
  chips: { gap: 8, paddingVertical: 8, paddingRight: 4 },
});
