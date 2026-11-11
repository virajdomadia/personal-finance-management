import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LockView } from "@/components/lock-view";
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
      <LockView onUnlock={() => void onUnlock()} onLogOut={() => void logOut()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    ...StyleSheet.absoluteFill,
    justifyContent: "space-between",
    paddingHorizontal: 24,
  },
});
