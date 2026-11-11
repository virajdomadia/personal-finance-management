import { Pressable, StyleSheet, View, type AccessibilityRole } from "react-native";
import { Icon, Text } from "react-native-paper";

import { BRAND, SHADOW_OFFSET_SM } from "@/lib/theme";

import { ChunkyBox } from "./chunky-box";

type Props = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  icon?: string; // a Material Community Icons name
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

// A pill for a filter or a choice: ink when selected, white when not.
export function Chip({
  label,
  selected = false,
  onPress,
  disabled = false,
  icon,
  accessibilityRole = "button",
  accessibilityLabel,
  accessibilityHint,
}: Props) {
  const fg = selected ? "#FFFFFF" : BRAND.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 6, bottom: 6 }}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={
        accessibilityRole === "radio" ? { selected, checked: selected, disabled } : { selected, disabled }
      }
      style={{ opacity: disabled ? 0.6 : 1 }}
    >
      {({ pressed }) => (
        <ChunkyBox
          pressed={pressed && !disabled}
          flat={disabled}
          radius={999}
          offset={SHADOW_OFFSET_SM}
          style={[styles.box, { backgroundColor: selected ? BRAND.ink : BRAND.card }]}
        >
          <View style={styles.content}>
            {icon ? <Icon source={icon} size={16} color={fg} /> : null}
            <Text variant="labelLarge" style={[styles.label, { color: fg }]}>
              {label}
            </Text>
          </View>
        </ChunkyBox>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 14, paddingVertical: 7, minHeight: 36, justifyContent: "center" },
  content: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
});
