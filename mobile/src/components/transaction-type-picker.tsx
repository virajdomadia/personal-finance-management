import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { ChunkyBox, TONE_BG, TONE_FG, type Tone } from "@/components/chunky";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";
import type { TransactionType } from "@/lib/transactions";

const LOOK: Record<TransactionType, { emoji: string; tone: Tone }> = {
  expense: { emoji: "\u{1F4B8}", tone: "pink" },
  income: { emoji: "\u{1F4B0}", tone: "green" },
  transfer: { emoji: "\u{1F501}", tone: "blue" },
  emi: { emoji: "\u{1F3E7}", tone: "purple" },
};

type Props = {
  options: { value: TransactionType; label: string }[];
  value: TransactionType;
  onChange: (value: TransactionType) => void;
  disabled?: boolean;
};

// The transaction type as big buttons, two to a row. The chosen one takes its type's colour.
export function TransactionTypePicker({ options, value, onChange, disabled = false }: Props) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Type" style={styles.grid}>
      {options.map((option) => {
        const on = option.value === value;
        const { emoji, tone } = LOOK[option.value];
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: on, checked: on, disabled }}
            style={[styles.cell, { opacity: disabled ? 0.6 : 1 }]}
          >
            {({ pressed }) => (
              <ChunkyBox
                pressed={pressed && !disabled}
                flat={disabled}
                radius={INPUT_RADIUS}
                offset={SHADOW_OFFSET_SM}
                style={[styles.box, { backgroundColor: on ? TONE_BG[tone] : BRAND.card }]}
              >
                <Text style={styles.emoji} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  {emoji}
                </Text>
                <Text variant="labelLarge" style={[styles.label, { color: on ? TONE_FG[tone] : BRAND.ink }]}>
                  {option.label}
                </Text>
              </ChunkyBox>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8 },
  cell: { flexBasis: "47%", flexGrow: 1 },
  box: { minHeight: 64, paddingHorizontal: 8, paddingVertical: 10, alignItems: "center", justifyContent: "center", gap: 2 },
  emoji: { fontSize: 22, lineHeight: 28 },
  label: { fontSize: 14, lineHeight: 18, textAlign: "center" },
});
