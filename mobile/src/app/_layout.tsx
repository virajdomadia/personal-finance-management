import { Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black, useFonts } from "@expo-google-fonts/nunito";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { PaperProvider, useTheme } from "react-native-paper";

import { LockScreen } from "@/components/lock-screen";

import { SessionProvider, useSession } from "@/lib/session";
import { useAppLock } from "@/lib/use-app-lock";
import { lightTheme } from "@/lib/theme";

// Keep the splash up until Nunito is ready, so no screen flashes in the system font.
void SplashScreen.preventAutoHideAsync();

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
            <Stack.Screen name="close-rd-form" />
            <Stack.Screen name="account-transactions" />
            <Stack.Screen name="stock" />
            <Stack.Screen name="add-investment" />
            <Stack.Screen name="trade-form" />
            <Stack.Screen name="price-form" />
            <Stack.Screen name="holding-form" />
            <Stack.Screen name="fund" />
            <Stack.Screen name="sip-form" />
            <Stack.Screen name="coin" />
            <Stack.Screen name="recurring" />
            <Stack.Screen name="template-form" />
            <Stack.Screen name="insurance" />
            <Stack.Screen name="policy-form" />
            <Stack.Screen name="renew-form" />
            <Stack.Screen name="goals" />
            <Stack.Screen name="goal" />
            <Stack.Screen name="goal-form" />
            <Stack.Screen name="earmark-form" />
            <Stack.Screen name="goal-holding-form" />
            <Stack.Screen name="sms-settings" />
            <Stack.Screen name="sms-unreadable" />
            <Stack.Screen name="review" />
            <Stack.Screen name="review-item" />
            <Stack.Screen name="payee-rules" />
            <Stack.Screen name="cash-flow" />
            <Stack.Screen name="categories" />
            <Stack.Screen name="category-form" />
            <Stack.Screen name="transaction-filters" />
            <Stack.Screen name="budgets" />
            <Stack.Screen name="budget-form" />
            <Stack.Screen name="safe-to-spend" />
            <Stack.Screen name="upcoming" />
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
  const [fontsLoaded, fontError] = useFonts({ Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black });
  const ready = fontsLoaded || fontError !== null;

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  // A failed font load still opens the app, in the system font.
  if (!ready) return null;

  return (
    <PaperProvider theme={lightTheme}>
      <SessionProvider>
        <StatusBar style="dark" />
        <Screens />
      </SessionProvider>
    </PaperProvider>
  );
}
