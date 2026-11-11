import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

import { ChunkyBox } from "./chunky-box";

type Props = {
  title: string;
  back?: boolean;
  backDisabled?: boolean; // e.g. while a save is in flight
  right?: ReactNode;
};

// The top of a screen: an optional back button, the title (it wraps, never clips), and actions on the right.
export function ScreenHeader({ title, back = false, backDisabled = false, right }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
      {back ? (
        <Pressable
          onPress={() => router.back()}
          disabled={backDisabled}
          accessibilityRole="button"
          accessibilityLabel="Back"
          accessibilityState={{ disabled: backDisabled }}
          hitSlop={4}
        >
          {({ pressed }) => (
            <ChunkyBox pressed={pressed} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.back}>
              <Icon source="arrow-left" size={22} color={BRAND.ink} />
            </ChunkyBox>
          )}
        </Pressable>
      ) : null}
      <Text variant="headlineSmall" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

type ActionProps = { icon: string; label: string; onPress: () => void; disabled?: boolean };

// A square icon button for a header's right side.
export function HeaderAction({ icon, label, onPress, disabled = false }: ActionProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={4}
      style={{ opacity: disabled ? 0.6 : 1 }}
    >
      {({ pressed }) => (
        <ChunkyBox pressed={pressed && !disabled} flat={disabled} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.back}>
          <Icon source={icon} size={22} color={BRAND.ink} />
        </ChunkyBox>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, minWidth: 0, color: BRAND.ink, fontSize: 24, lineHeight: 30 },
  right: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
});
