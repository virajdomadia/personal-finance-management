import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Chip, ChunkyBox, ChunkyButton, EmptyState, HeaderAction, Row, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type ApproveResult,
  type ConfidentSummary,
  type Learnable,
  REVIEW_EMOJI,
  type ReviewItem,
  type ReviewList,
  approveBody,
  approveButtonText,
  approveResultText,
  categoryTotalText,
  confidentTotalsText,
  reviewCountText,
  reviewDetails,
  reviewFigure,
  reviewTitle,
  whyLine,
} from "@/lib/review";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const FAILED = "We couldn't load To review.";

// What the last "Approve all" did, with the payee of each skipped item from the list it was sent from.
type Outcome = { result: ApproveResult; labels: Record<number, string> };
type LearnState = "saving" | "saved" | "failed";

export default function ReviewScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [summary, setSummary] = useState<ConfidentSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [learned, setLearned] = useState<Record<number, LearnState>>({});
  const latest = useRef(0);
  const navigating = useRef(false);
  const approvingRef = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<ReviewList>("/sms/review", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setItems(result.items);
      setSummary(result.confident);
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

  // Sends exactly the confident items the owner was shown; the server checks each again.
  const approve = async () => {
    if (approvingRef.current || items === null) return;
    approvingRef.current = true;
    setApproving(true);
    setApproveError(null);
    try {
      const result = await apiFetch<ApproveResult>("/sms/review/approve", {
        method: "POST",
        body: JSON.stringify(approveBody(items)),
        token: token ?? undefined,
      });
      setOutcome({ result, labels: Object.fromEntries(items.map((i) => [i.id, i.payee ?? reviewTitle(i)])) });
      setLearned({});
      setConfirming(false);
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setApproveError(errorMessage(err));
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  };

  // "Always use <category> for <payee>": a payee rule, so the next message never waits.
  const learn = async (offer: Learnable) => {
    const state = learned[offer.entry_id];
    if (state === "saving" || state === "saved") return;
    setLearned((l) => ({ ...l, [offer.entry_id]: "saving" }));
    try {
      await apiFetch("/payee-rules", {
        method: "POST",
        body: JSON.stringify({ entry_id: offer.entry_id, category: offer.category }),
        token: token ?? undefined,
      });
      setLearned((l) => ({ ...l, [offer.entry_id]: "saved" }));
      void load(); // waiting items from that payee are now ready to approve
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setLearned((l) => ({ ...l, [offer.entry_id]: "failed" }));
    }
  };

  const go = (target: Parameters<typeof router.push>[0]) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  };

  const outcomePanel = outcome ? (
    <ChunkyBox style={styles.panel}>
      <Text variant="titleMedium" accessibilityLiveRegion="polite" style={styles.ink}>
        {approveResultText(outcome.result)}
      </Text>
      {outcome.result.skipped.map((s) => (
        <Text key={s.id} variant="bodyMedium" style={styles.muted}>
          {outcome.labels[s.id] ?? "A message"}: {s.reason}
        </Text>
      ))}
      {outcome.result.learn.length > 0 ? (
        <>
          <Text variant="labelLarge" style={styles.ink}>
            Make these automatic next time?
          </Text>
          <View style={styles.chips}>
            {outcome.result.learn.map((offer) => {
              const state = learned[offer.entry_id];
              const text = `Always use ${offer.category} for ${offer.payee}`;
              return (
                <Chip
                  key={offer.entry_id}
                  label={state === "saving" ? "Saving..." : state === "failed" ? `Try again: ${text}` : text}
                  icon={state === "saved" ? "check" : "tag-plus-outline"}
                  selected={state === "saved"}
                  disabled={state === "saving" || state === "saved"}
                  accessibilityLabel={state === "saved" ? `Saved: ${text}` : text}
                  onPress={() => void learn(offer)}
                />
              );
            })}
          </View>
        </>
      ) : null}
      <ChunkyButton label="Done" variant="alt" onPress={() => setOutcome(null)} />
    </ChunkyBox>
  ) : null;

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
          {outcomePanel}
          {items.length === 0 ? (
            <EmptyState
              emoji="🎉"
              title="All caught up"
              body="When Gullak reads a bank text it can't sort by itself, it waits here for you to check."
              action={{ label: "Bank SMS settings", variant: "alt", onPress: () => go("/sms-settings") }}
            />
          ) : (
            <>
              <Text variant="titleSmall" accessibilityRole="header" style={styles.count}>
                {reviewCountText(items.length)}
              </Text>
              {summary !== null && summary.count > 0 ? (
                <ChunkyBox style={[styles.panel, styles.ready]}>
                  <Text variant="titleMedium" style={styles.ink}>
                    {summary.count === 1 ? "1 is ready to approve" : `${summary.count} are ready to approve`}
                  </Text>
                  <Text variant="bodyMedium" style={styles.ink}>
                    {confidentTotalsText(summary)}. Their payee rule or past payments say the category.
                  </Text>
                  <ChunkyButton
                    label={approveButtonText(summary.count)}
                    variant="green"
                    onPress={() => {
                      setApproveError(null);
                      setConfirming(true);
                    }}
                  />
                </ChunkyBox>
              ) : null}
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
                      meta={
                        <>
                          <Text variant="bodySmall" style={styles.muted}>
                            {details}
                          </Text>
                          {item.why ? (
                            <Text variant="bodySmall" style={item.confident ? styles.sure : styles.muted}>
                              {whyLine(item)}
                            </Text>
                          ) : null}
                        </>
                      }
                      amount={figure}
                      onPress={() => go({ pathname: "/review-item", params: { id: String(item.id) } })}
                      accessibilityLabel={[title, figure, details, item.why].filter(Boolean).join(", ")}
                      accessibilityHint="Opens it to answer"
                    />
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>
      )}
      <Portal>
        <Dialog visible={confirming && summary !== null} onDismiss={() => (approving ? undefined : setConfirming(false))}>
          <Dialog.Title>{summary ? `${approveButtonText(summary.count)}?` : ""}</Dialog.Title>
          <Dialog.Content style={styles.dialog}>
            <Text variant="titleMedium">{summary ? confidentTotalsText(summary) : ""}</Text>
            {(summary?.categories ?? []).map((c) => (
              <Text key={`${c.type}-${c.category}`} variant="bodyMedium">
                {categoryTotalText(c)}
              </Text>
            ))}
            <Text variant="bodySmall" style={styles.muted}>
              Each gets the category shown. Anything that changed since is left for you.
            </Text>
            {approveError ? (
              <Text variant="bodyMedium" style={styles.error}>
                {approveError}
              </Text>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirming(false)} disabled={approving}>
              Cancel
            </Button>
            <Button onPress={() => void approve()} loading={approving} disabled={approving}>
              Approve
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  count: { color: BRAND.ink, letterSpacing: 0.6 },
  list: { gap: 4 },
  panel: { padding: 14, gap: 8 },
  ready: { backgroundColor: BRAND.due },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  dialog: { gap: 6 },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
  sure: { color: BRAND.greenStrong, fontWeight: "800" },
  error: { color: BRAND.loss },
});
