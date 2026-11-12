import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyButton, HeaderAction, Row, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { ApiError, apiFetch } from "@/lib/api";
import { REVIEW_EMOJI, type ReviewItem, reviewCountText, reviewDetails, reviewFigure, reviewTitle } from "@/lib/review";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const FAILED = "We couldn't load To review.";

export default function ReviewScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<{ items: ReviewItem[] }>("/sms/review", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setItems(result.items);
      setFailed(false);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setFailed(true); // keeps the last list, if any
    }
  }, [token, logOut]);

  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const go = (target: Parameters<typeof router.push>[0]) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="To review"
        back
        right={<HeaderAction icon="tag-multiple-outline" label="Payee rules" onPress={() => go("/payee-rules")} />}
      />
      {items === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading To review" />
        </View>
      ) : items === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {FAILED}
          </Text>
          <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {failed ? <Banner messages={[`${FAILED} Pull down to try again.`]} /> : null}
          {items.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.big} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                🎉
              </Text>
              <Text variant="titleMedium">All caught up</Text>
              <Text variant="bodyMedium" style={[styles.centerText, styles.muted]}>
                Bank messages Gullak isn&apos;t sure about wait here for your answer.
              </Text>
            </View>
          ) : (
            <>
              <Text variant="titleSmall" accessibilityRole="header" style={styles.count}>
                {reviewCountText(items.length)}
              </Text>
              <View style={styles.list}>
                {items.map((item) => {
                  const look = REVIEW_EMOJI[item.reason ?? ""] ?? { emoji: "📩", tone: "card" as const };
                  const title = reviewTitle(item);
                  const details = reviewDetails(item);
                  const figure = reviewFigure(item);
                  return (
                    <Row
                      key={item.id}
                      emoji={look.emoji}
                      tone={look.tone}
                      title={title}
                      meta={details}
                      amount={figure}
                      onPress={() => go({ pathname: "/review-item", params: { id: String(item.id) } })}
                      accessibilityLabel={[title, figure, details].filter(Boolean).join(", ")}
                      accessibilityHint="Opens it to answer"
                    />
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 48 },
  big: { fontSize: 44, lineHeight: 52 },
  muted: { color: BRAND.zinc600 },
  count: { color: BRAND.ink, letterSpacing: 0.6 },
  list: { gap: 4 },
});
