import { router } from "expo-router";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { Appbar, Button, Chip, HelperText, Text, useTheme } from "react-native-paper";

// Small pieces the recurring and insurance screens share.

export function Heading({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
      {label}
    </Text>
  );
}

export function Choice({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Chip
      selected={selected}
      showSelectedCheck
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
    >
      {label}
    </Chip>
  );
}

export function Banner({ messages, tone = "error" }: { messages: string[]; tone?: "error" | "info" }) {
  const { colors } = useTheme();
  if (messages.length === 0) return null;
  const background = tone === "error" ? colors.errorContainer : colors.secondaryContainer;
  const color = tone === "error" ? colors.onErrorContainer : colors.onSecondaryContainer;
  return (
    <View style={[styles.banner, { backgroundColor: background }]}>
      {messages.map((message) => (
        <Text key={message} variant="bodyMedium" accessibilityRole={tone === "error" ? "alert" : undefined} style={{ color }}>
          {message}
        </Text>
      ))}
    </View>
  );
}

// A form screen's header and body while its data loads, or when loading failed.
export function LoadingScreen({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: string | null;
  onRetry: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={title} />
      </Appbar.Header>
      <View style={styles.center}>
        {error === null ? (
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
        ) : (
          <>
            <Text variant="bodyLarge" style={styles.centerText}>
              {error}
            </Text>
            <Button mode="contained" onPress={onRetry}>
              Try again
            </Button>
          </>
        )}
      </View>
    </View>
  );
}

// Leaving mid-save would let the later router.back() pop an unrelated screen.
export function useBlockBack(isBusy: () => boolean) {
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", isBusy);
    return () => subscription.remove();
  }, [isBusy]);
}

// Fields that report their position, so a screen can scroll to the first one with an error.
export function useFieldScroll() {
  const scrollRef = useRef<ScrollViewInstance>(null);
  const positions = useRef<Record<string, number>>({});

  // No key scrolls to the top, where the general messages are.
  const scrollTo = useCallback((key?: string) => {
    const y = key === undefined ? 0 : positions.current[key];
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
  }, []);

  const field = (key: string, content: ReactNode, error?: string) => (
    <View
      key={key}
      onLayout={(event) => {
        positions.current[key] = event.nativeEvent.layout.y;
      }}
    >
      {content}
      {error ? (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      ) : null}
    </View>
  );

  return { scrollRef, scrollTo, field };
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  banner: { borderRadius: 12, padding: 12, gap: 8 },
});
