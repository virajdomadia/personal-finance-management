import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Icon, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/lib/session";

export function LockScreen({ onUnlock }: { onUnlock: () => Promise<void> }) {
  const { logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    void onUnlock();
  }, [onUnlock]);

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
        },
      ]}
    >
      <View style={styles.message}>
        <Icon source="lock-outline" size={48} color={colors.primary} />
        <Text variant="headlineSmall" style={{ color: colors.primary }}>
          Personal Finance is locked
        </Text>
        <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
          Use your fingerprint or device PIN to continue.
        </Text>
      </View>
      <View style={styles.actions}>
        <Button
          mode="contained"
          icon="fingerprint"
          onPress={() => void onUnlock()}
          contentStyle={styles.buttonContent}
        >
          Unlock
        </Button>
        <Button mode="text" onPress={() => void logOut()}>
          Log out
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
    paddingHorizontal: 24,
  },
  message: {
    marginTop: 48,
    gap: 12,
  },
  actions: {
    gap: 8,
  },
  buttonContent: {
    height: 52,
  },
});
