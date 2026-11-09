import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, useColorScheme, View } from "react-native";
import { PaperProvider, useTheme } from "react-native-paper";

import { LockScreen } from "@/components/lock-screen";

import { SessionProvider, useSession } from "@/lib/session";
import { useAppLock } from "@/lib/use-app-lock";
import { darkTheme, lightTheme } from "@/lib/theme";

function Screens() {
  const { token } = useSession();
  const loggedIn = token !== null;
  const { colors } = useTheme();
  const { locked, covered, unlock } = useAppLock(loggedIn);
  const hidden = locked || covered;

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{ flex: 1 }}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={hidden}
      >
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={loggedIn}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="account-form" />
            <Stack.Screen name="archived-accounts" />
            <Stack.Screen name="transaction-form" />
            <Stack.Screen name="account-transactions" />
            <Stack.Screen name="stock" />
            <Stack.Screen name="trade-form" />
            <Stack.Screen name="price-form" />
            <Stack.Screen name="stock-form" />
          </Stack.Protected>
          <Stack.Protected guard={!loggedIn}>
            <Stack.Screen name="login" />
          </Stack.Protected>
        </Stack>
      </View>
      {locked ? (
        <LockScreen onUnlock={unlock} />
      ) : covered ? (
        // Hides the content while the app is away, so a return after the lock delay never flashes it.
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} />
      ) : null}
    </View>
  );
}

export default function RootLayout() {
  const theme = useColorScheme() === "dark" ? darkTheme : lightTheme;

  return (
    <PaperProvider theme={theme}>
      <SessionProvider>
        <StatusBar style="auto" />
        <Screens />
      </SessionProvider>
    </PaperProvider>
  );
}
