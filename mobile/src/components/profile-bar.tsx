import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyButton } from "@/components/chunky";
import { viewingText } from "@/lib/family";
import { useProfile } from "@/lib/profile";
import { BRAND } from "@/lib/theme";

// While a family member is chosen: a coloured bar across the top of every screen saying whose
// profile this is, with "Back to me", so nothing is recorded into the wrong profile by mistake.
// The bar takes the status bar's space, so the screens below are told there is no top inset.
export function ProfileBar({ children }: { children: ReactNode }) {
  const { profile, switchProfile } = useProfile();
  const insets = useSafeAreaInsets();
  // The same tree either way, so choosing a profile never remounts the navigator below.
  return (
    <View style={styles.wrap}>
      {profile === null ? null : (
      <View style={[styles.bar, { paddingTop: insets.top + 6, paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right }]}>
        <Text variant="titleSmall" accessibilityRole="header" accessibilityLiveRegion="polite" numberOfLines={2} style={styles.text}>
          👀 {viewingText(profile.name)}
        </Text>
        <ChunkyButton compact variant="alt" icon="account-arrow-left" label="Back to me" onPress={() => switchProfile(null)} />
      </View>
      )}
      <SafeAreaInsetsContext.Provider value={profile === null ? insets : { ...insets, top: 0 }}>{children}</SafeAreaInsetsContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingBottom: 8,
    backgroundColor: BRAND.blue,
    borderBottomWidth: 2.5,
    borderBottomColor: BRAND.ink,
  },
  text: { flex: 1, minWidth: 0, color: BRAND.ink },
});
