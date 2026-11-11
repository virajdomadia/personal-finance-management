import { StyleSheet, View } from "react-native";
import { HelperText, Text } from "react-native-paper";

import { ChunkyButton, Logo } from "@/components/chunky";
import { BRAND } from "@/lib/theme";

type Props = { error: string | null; pending: boolean; onSubmit: () => void };

// The sign-in screen's content; the screen owns the session call.
export function LoginView({ error, pending, onSubmit }: Props) {
  return (
    <>
      <View style={styles.hero}>
        <Logo size={96} />
        <Text variant="displaySmall" accessibilityRole="header" style={styles.title}>
          Your money, but fun.
        </Text>
        <Text variant="bodyMedium" style={styles.sub}>
          Track every rupee. Watch it grow.
        </Text>
      </View>
      <View>
        <HelperText type="error" visible={error !== null}>
          {error}
        </HelperText>
        <ChunkyButton label="Continue with Google" icon="google" variant="alt" onPress={onSubmit} loading={pending} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: 12, marginTop: 48 },
  title: { color: BRAND.ink, textAlign: "center", fontSize: 30, lineHeight: 34 },
  sub: { color: BRAND.zinc600, textAlign: "center" },
});
