import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LoginView } from "@/components/login-view";
import { ApiError } from "@/lib/api";
import { GoogleSignInFailedError } from "@/lib/google";
import { useSession } from "@/lib/session";

const UNAVAILABLE = "Sign-in isn't available right now. Try again in a few minutes.";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 403 ? "This Google account doesn't have access." : UNAVAILABLE;
  }
  if (error instanceof GoogleSignInFailedError) return UNAVAILABLE;
  return "Can't reach the server. Check your connection and try again.";
}

export default function LoginScreen() {
  const { logIn } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await logIn();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    // A successful login replaces this screen, and a cancelled picker leaves it as it was.
    setPending(false);
  }

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
      <LoginView error={error} pending={pending} onSubmit={() => void submit()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: "space-between",
    paddingHorizontal: 24,
  },
});
