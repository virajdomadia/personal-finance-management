import { useState } from "react";
import { KeyboardAvoidingView, StyleSheet, View } from "react-native";
import { Button, HelperText, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 401
      ? "Incorrect password."
      : "The server couldn't log you in. Try again in a few minutes.";
  }
  return "Can't reach the server. Check your connection and try again.";
}

export default function LoginScreen() {
  const { logIn } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!password || pending) return;
    setPending(true);
    setError(null);
    try {
      await logIn(password);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[
        styles.screen,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
        },
      ]}
    >
      <Text variant="displaySmall" style={[styles.title, { color: colors.primary }]}>
        Personal Finance
      </Text>
      <View>
        <TextInput
          mode="outlined"
          label="Password"
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          returnKeyType="go"
          error={error !== null}
          right={
            <TextInput.Icon
              icon={visible ? "eye-off" : "eye"}
              accessibilityLabel={visible ? "Hide password" : "Show password"}
              onPress={() => setVisible((current) => !current)}
            />
          }
        />
        <HelperText type="error" visible={error !== null}>
          {error}
        </HelperText>
        <Button
          mode="contained"
          onPress={submit}
          loading={pending}
          disabled={!password || pending}
          contentStyle={styles.buttonContent}
        >
          Log in
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: "space-between",
    paddingHorizontal: 24,
  },
  title: {
    marginTop: 48,
  },
  buttonContent: {
    height: 52,
  },
});
