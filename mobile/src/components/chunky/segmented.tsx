import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

import { ChunkyBox } from "./chunky-box";

type Props<T extends string> = {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
};

// One choice out of a few, as joined segments. Each segment is a radio in a radio group.
export function Segmented<T extends string>({ options, value, onChange, label }: Props<T>) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      <ChunkyBox radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.box}>
        {options.map((option, index) => {
          const on = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, checked: on }}
              style={[styles.item, index > 0 ? styles.divider : null, { backgroundColor: on ? BRAND.yellow : BRAND.card }]}
            >
              <Text variant="labelLarge" style={styles.text}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ChunkyBox>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", overflow: "hidden" },
  item: { flex: 1, minHeight: 44, paddingHorizontal: 8, paddingVertical: 8, alignItems: "center", justifyContent: "center" },
  divider: { borderLeftWidth: 2, borderLeftColor: BRAND.ink },
  text: { color: BRAND.ink, fontSize: 13, lineHeight: 18, textAlign: "center" },
});
