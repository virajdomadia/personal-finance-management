import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { Button, Card, Dialog, Portal, Text, useTheme } from "react-native-paper";

import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type GoalDue, goalDueText } from "@/lib/goals";
import { type DueItem, canSkip, dueText } from "@/lib/recurring";
import { useSession } from "@/lib/session";

import { Banner } from "./form-parts";

const itemKey = (item: DueItem) => `${item.template.id}-${item.occurrence}`;

// Record opens the transaction form for the reminder, or the renewal form for an insurance premium.
export function openRecord(item: DueItem) {
  if (item.template.policy_id !== null) {
    router.push({ pathname: "/renew-form", params: { policyId: String(item.template.policy_id) } });
  } else {
    router.push({
      pathname: "/transaction-form",
      params: { templateId: String(item.template.id), occurrence: item.occurrence },
    });
  }
}

// Set aside opens the earmark form for the goal, with what is left for this month filled in.
export function openSetAside(d: GoalDue) {
  router.push({ pathname: "/earmark-form", params: { goalId: String(d.goal_id), action: "set_aside", amount: d.amount } });
}

type Props = {
  items: DueItem[];
  // Goals with money still to set aside this month. Kept apart from `items`, which are always reminders.
  goals?: GoalDue[];
  // Called after a skip, so the screen reloads what it shows (also after a failed one).
  onChanged: () => void;
};

// Due and coming-up reminders: tap to record, hold to skip. An insurance premium is only renewed.
export function DueList({ items, goals = [], onChanged }: Props) {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [asking, setAsking] = useState<DueItem | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useRef(false);
  const due = items.filter((i) => i.state === "due");
  const comingUp = items.filter((i) => i.state === "coming_up");

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busy.current) setAsking(null);
    });
    return () => subscription.remove();
  }, []);

  async function skip(item: DueItem) {
    if (busy.current) return;
    busy.current = true;
    setSkipping(true);
    try {
      await apiFetch(`/recurring/${item.template.id}/skip`, {
        method: "POST",
        token: token ?? undefined,
        body: { occurrence: item.occurrence },
      });
      setNotice(null);
      setAsking(null);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else {
        // The list may be out of date (it was skipped or recorded elsewhere), so show it again.
        setNotice(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
        setAsking(null);
        onChanged();
      }
    } finally {
      busy.current = false;
      setSkipping(false);
    }
  }

  const group = (title: string, rows: DueItem[]) =>
    rows.length === 0 ? null : (
      <View style={styles.group}>
        <Text variant="titleSmall" accessibilityRole="header" style={{ color: colors.primary }}>
          {title}
        </Text>
        {rows.map((item) => {
          const skippable = canSkip(item);
          return (
            <Card
              key={itemKey(item)}
              mode="outlined"
              onPress={() => openRecord(item)}
              onLongPress={skippable ? () => setAsking(item) : undefined}
              accessibilityRole="button"
              accessibilityHint={skippable ? "Records it. Hold to skip." : "Renews it."}
              accessibilityActions={skippable ? [{ name: "skip", label: "Skip this one" }] : undefined}
              onAccessibilityAction={(event) => {
                if (skippable && event.nativeEvent.actionName === "skip") setAsking(item);
              }}
            >
              <Card.Content>
                <Text variant="bodyLarge">{dueText(item)}</Text>
              </Card.Content>
            </Card>
          );
        })}
      </View>
    );

  return (
    <>
      {notice !== null ? <Banner messages={[notice]} /> : null}
      {items.length > 0 ? (
        <View style={styles.list}>
          {group("Due", due)}
          {group("Coming up", comingUp)}
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {items.some(canSkip) ? "Tap to record, hold to skip." : "Tap to renew."}
          </Text>
        </View>
      ) : null}
      {goals.length > 0 ? (
        <View style={styles.group}>
          <Text variant="titleSmall" accessibilityRole="header" style={{ color: colors.primary }}>
            Set aside for goals
          </Text>
          {goals.map((d) => (
            <Card
              key={`goal-${d.goal_id}`}
              mode="outlined"
              onPress={() => openSetAside(d)}
              accessibilityRole="button"
              accessibilityHint="Opens set aside for this goal."
            >
              <Card.Content>
                <Text variant="bodyLarge">{goalDueText(d)}</Text>
              </Card.Content>
            </Card>
          ))}
        </View>
      ) : null}
      <Portal>
        <Dialog visible={asking !== null} onDismiss={() => (skipping ? undefined : setAsking(null))}>
          <Dialog.Title>Skip this one?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {asking ? `${dueText(asking).replace(/ Record it\.$/, "")} ` : ""}
              It won&apos;t show as due again. Nothing is recorded.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsking(null)} disabled={skipping}>
              Keep
            </Button>
            <Button onPress={() => asking && void skip(asking)} loading={skipping} disabled={skipping}>
              Skip
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  group: { gap: 8 },
});
