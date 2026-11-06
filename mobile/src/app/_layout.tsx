import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { PaperProvider } from "react-native-paper";

import { SessionProvider, useSession } from "@/lib/session";
import { darkTheme, lightTheme } from "@/lib/theme";

function Screens() {
  const { token } = useSession();
  const loggedIn = token !== null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={loggedIn}>
        <Stack.Screen name="index" />
      </Stack.Protected>
      <Stack.Protected guard={!loggedIn}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
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
