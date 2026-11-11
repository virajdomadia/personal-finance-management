import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon, Text } from "react-native-paper";

import { BRAND, INPUT_RADIUS, SHADOW_OFFSET } from "@/lib/theme";

import { ChunkyBox } from "./chunky-box";

type Variant = "primary" | "alt" | "green" | "pink";

const FILL: Record<Variant, { bg: string; fg: string }> = {
  primary: { bg: BRAND.ink, fg: "#FFFFFF" },
  alt: { bg: BRAND.card, fg: BRAND.ink },
  green: { bg: BRAND.greenStrong, fg: "#FFFFFF" },
  pink: { bg: BRAND.pinkStrong, fg: "#FFFFFF" },
};

type Props = {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: string; // a Material Community Icons name
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>; // layout: flex, alignSelf, margins
};

// The label is natural case with an uppercase style, so a screen reader still hears "Save".
export function ChunkyButton({
  label,
  onPress,
  variant = "primary",
  icon,
  disabled = false,
  loading = false,
  style,
}: Props) {
  const { bg, fg } = FILL[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={[{ opacity: disabled ? 0.6 : 1 }, style]}
    >
      {({ pressed }) => (
        <ChunkyBox
          pressed={pressed && !inactive}
          flat={disabled}
          radius={INPUT_RADIUS}
          offset={SHADOW_OFFSET}
          style={[styles.box, { backgroundColor: bg }]}
        >
          <View style={styles.content}>
            {loading ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon source={icon} size={18} color={fg} /> : null}
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
  box: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, justifyContent: "center" },
  content: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  label: {
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    textAlign: "center",
    flexShrink: 1,
  },
});
