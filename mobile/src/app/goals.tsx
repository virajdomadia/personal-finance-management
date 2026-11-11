import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ChunkyBox,
  ChunkyButton,
  HeaderAction,
  ProgressBar,
  ScreenHeader,
  Segmented,
  Sticker,
  TONE_BG,
  TONE_FG,
  type Tone,
} from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { openGoal } from "@/components/goal-tag";
import { ApiError, apiFetch } from "@/lib/api";
import { type Goal, type GoalList, goalEmoji, paceText, progressText } from "@/lib/goals";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

type Shown = "active" | "archived";
const FAILED = "We couldn't load your goals.";

const TONES: Tone[] = ["purple", "blue", "orange", "pink", "green"];

// One goal on the list: its progress, how it is pacing and anything that needs a look.
function GoalSummary({ goal, tone, onPress }: { goal: Goal; tone: Tone; onPress: () => void }) {
  const progress = progressText(goal);
  const pace = paceText(goal);
  const emergency = goal.kind === "emergency";
  const fg = TONE_FG[tone];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[goal.name, emergency ? "emergency fund" : null, progress, pace, ...goal.warnings]
        .filter(Boolean)
        .join(". ")}
      accessibilityHint="Opens the goal"
    >
      {({ pressed }) => (
        <ChunkyBox pressed={pressed} style={[styles.card, { backgroundColor: TONE_BG[tone] }]}>
          {goal.reached ? <Sticker text="DONE!" /> : null}
          <View style={[styles.head, goal.reached ? styles.stickerGap : null]}>
            <Text variant="titleMedium" style={[styles.cardName, { color: fg }]}>
              {goalEmoji(goal)} {goal.name}
            </Text>
            {emergency ? (
              <Text variant="labelMedium" style={{ color: fg }}>
                Emergency fund
              </Text>
            ) : null}
          </View>
          <Text variant="bodyMedium" style={{ color: fg }}>
            {progress}
          </Text>
          {goal.target !== null ? (
            <ProgressBar percent={goal.percent} reached={goal.reached} label={`${goal.name} progress`} />
          ) : null}
          {pace ? (
            goal.overdue ? (
              <Note text={pace} />
            ) : (
              <Text variant="bodySmall" style={{ color: fg }}>
                {pace}
              </Text>
            )
          ) : null}
          {goal.warnings.map((warning) => (
            <Note key={warning} text={warning} />
          ))}
        </ChunkyBox>
      )}
    </Pressable>
  );
}

// A warning on a coloured tile sits on a white label so it stays readable.
function Note({ text }: { text: string }) {
  return (
    <View style={styles.note}>
      <Text variant="bodySmall" style={styles.noteText}>
        {text}
      </Text>
    </View>
  );
}

export default function GoalsScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<Shown>("active");
  const [goals, setGoals] = useState<Record<Shown, Goal[] | null>>({ active: null, archived: null });
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const navigating = useRef(false);
  const latest = useRef(0);

  // Both lists at once, so switching between them is instant and the toggle knows if any are archived.
  const load = useCallback(async () => {
    const mine = ++latest.current;
    const auth = { token: token ?? undefined };
    try {
      const [active, archived] = await Promise.all([
        apiFetch<GoalList>("/goals?archived=false", auth),
        apiFetch<GoalList>("/goals?archived=true", auth),
      ]);
      if (mine !== latest.current) return;
      setGoals({ active: active.goals, archived: archived.goals });
      setFailed(false);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setFailed(true); // keeps the last data, if any
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

  const go = (open: () => void) => {
    if (navigating.current) return;
    navigating.current = true;
    open();
  };
  const add = () => go(() => router.push("/goal-form"));

  const list = goals[shown];
  const archivedCount = goals.archived?.length ?? 0;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Goals" back right={<HeaderAction icon="plus" label="Add goal" onPress={add} />} />

      {goals.active === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading goals" />
        </View>
      ) : goals.active === null ? (
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
          {archivedCount > 0 || shown === "archived" ? (
            <Segmented
              label="Show goals"
              value={shown}
              onChange={setShown}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: `Archived (${archivedCount})` },
              ]}
            />
          ) : null}

          {list === null || list.length === 0 ? (
            shown === "archived" ? (
              <View style={styles.empty}>
                <Text variant="titleMedium">No archived goals</Text>
              </View>
            ) : (
              <View style={styles.empty}>
                <Text variant="titleMedium">No goals yet</Text>
                <Text variant="bodyMedium" style={[styles.centerText, { color: BRAND.zinc600 }]}>
                  Name what you&apos;re saving for, then set money aside in your bank or cash, or count a fund, stock, coin,
                  PPF or RD toward it. Nothing moves: your balances stay as they are.
                </Text>
                <ChunkyButton label="Add goal" onPress={add} />
              </View>
            )
          ) : (
            list.map((goal, index) => (
              <GoalSummary key={goal.id} goal={goal} tone={TONES[index % TONES.length]} onPress={() => go(() => openGoal(goal.id))} />
            ))
          )}
          {shown === "archived" && list !== null && list.length > 0 ? (
            <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
              Archived goals keep their history, but their set-aside money and holdings count for nothing until restored.
            </Text>
          ) : null}
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
  empty: { alignItems: "center", gap: 12, paddingVertical: 32 },
  card: { padding: 14, gap: 8 },
  head: { gap: 2 },
  stickerGap: { paddingRight: 52 },
  cardName: { flexShrink: 1, fontSize: 18, lineHeight: 24 },
  note: {
    alignSelf: "flex-start",
    backgroundColor: "#FFFFFF",
    borderWidth: 2,
    borderColor: BRAND.ink,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  noteText: { color: BRAND.loss },
});
