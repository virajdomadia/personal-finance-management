import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { Button, Dialog, Portal, Text } from "react-native-paper";

import { ChunkyButton, Chip, Row } from "@/components/chunky";
import { errorMessage, formatDueDate } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { categoryEmoji } from "@/lib/fun";
import { type Template, scheduleText, toggleLabel, whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { formatDate } from "@/lib/transactions";

const TYPE_LABEL = { expense: "Expense", income: "Income", transfer: "Transfer" } as const;

// "Due since 1 Mar", "Coming up on 6 Apr", or why there is nothing to show.
function nextText(t: Template): string {
  if (!t.active) return "Stopped";
  if (t.due.length > 0) return `Due since ${formatDueDate(t.due[0])}`;
  if (t.coming_up) return `Coming up on ${formatDueDate(t.coming_up)}`;
  if (t.end_date) return `Ends ${formatDate(t.end_date)}`;
  return "Nothing due yet";
}

type Props = {
  templates: Template[];
  onEdit: (t: Template) => void;
  onChanged: () => void; // after a stop, restart, delete or undone skip
  onNotice: (message: string | null) => void;
};

// Reminders with their actions: edit (tap), stop or restart, delete, and undo a skipped date.
export function ReminderList({ templates, onEdit, onChanged, onNotice }: Props) {
  const { token, logOut } = useSession();
  const [toggling, setToggling] = useState<number | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const [removing, setRemoving] = useState(false);
  const busy = useRef(false);

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busy.current) setDeleting(null);
    });
    return () => subscription.remove();
  }, []);

  // Runs one change, reporting a failure and reloading either way.
  async function act(start: () => void, request: () => Promise<unknown>, end: () => void) {
    if (busy.current) return;
    busy.current = true;
    start();
    onNotice(null);
    try {
      await request();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else onNotice(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
    } finally {
      busy.current = false;
      end();
    }
    onChanged();
  }
  const auth = { token: token ?? undefined };
  const toggle = (t: Template) =>
    act(
      () => setToggling(t.id),
      () => apiFetch(`/recurring/${t.id}`, { method: "PATCH", ...auth, body: { active: !t.active } }),
      () => setToggling(null),
    );
  // Takes a skipped date back, so it shows as due (or coming up) again.
  const undoSkip = (t: Template, occurrence: string) =>
    act(
      () => setUndoing(`${t.id}-${occurrence}`),
      () => apiFetch(`/recurring/${t.id}/skip/${occurrence}`, { method: "DELETE", ...auth }),
      () => setUndoing(null),
    );
  const remove = (t: Template) =>
    act(
      () => setRemoving(true),
      () => apiFetch(`/recurring/${t.id}`, { method: "DELETE", ...auth }),
      () => {
        setRemoving(false);
        setDeleting(null);
      },
    );

  return (
    <View style={styles.list}>
      {templates.map((t) => {
        const accounts = t.type === "transfer" ? `${t.account_name} to ${t.to_account_name}` : t.account_name;
        const details = [TYPE_LABEL[t.type], scheduleText(t), accounts, t.category].filter(Boolean).join(" · ");
        const working = toggling === t.id;
        const skipped = t.skipped ?? [];
        const toggleText = toggleLabel(t);
        return (
          <Row
            key={t.id}
            emoji={t.policy_id !== null ? "🛡️" : t.type === "transfer" ? "🔁" : categoryEmoji(t.category)}
            tone={!t.active ? "card" : t.type === "income" ? "green" : t.type === "transfer" ? "blue" : "pink"}
            title={t.name}
            amount={whole(t.amount)}
            meta={
              <>
                <Text variant="bodySmall" style={styles.meta}>
                  {details}
                </Text>
                <Text variant="bodySmall" style={[styles.meta, t.active ? styles.next : null]}>
                  {t.policy_id !== null ? `Insurance policy · ${nextText(t)}` : nextText(t)}
                </Text>
              </>
            }
            onPress={() => onEdit(t)}
            accessibilityLabel={`${t.name}, ${whole(t.amount)}. ${details}. ${nextText(t)}. Edit`}
          >
            {skipped.length > 0 ? (
              <View style={styles.skipped}>
                <Text variant="bodySmall" style={styles.meta}>
                  Skipped
                </Text>
                {skipped.map((occurrence) => {
                  const key = `${t.id}-${occurrence}`;
                  return (
                    <Chip
                      key={occurrence}
                      icon="undo"
                      label={undoing === key ? "Undoing..." : formatDate(occurrence)}
                      onPress={() => void undoSkip(t, occurrence)}
                      disabled={undoing !== null || removing}
                      accessibilityLabel={`Undo skipping ${t.name} on ${formatDate(occurrence)}`}
                    />
                  );
                })}
              </View>
            ) : null}
            {toggleText !== null || t.policy_id === null ? (
              <View style={styles.actions}>
                {toggleText !== null ? (
                  <ChunkyButton
                    compact
                    variant="alt"
                    label={toggleText}
                    disabled={working || removing}
                    loading={working}
                    onPress={() => void toggle(t)}
                  />
                ) : null}
                {t.policy_id === null ? (
                  <ChunkyButton compact variant="alt" label="Delete" disabled={working || removing} onPress={() => setDeleting(t)} />
                ) : null}
              </View>
            ) : null}
          </Row>
        );
      })}

      <Portal>
        <Dialog visible={deleting !== null} onDismiss={() => (removing ? undefined : setDeleting(null))}>
          <Dialog.Title>{deleting ? `Delete ${deleting.name}?` : "Delete?"}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              The reminder is removed for good. Transactions you recorded from it stay. If it has any, stop it instead.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleting(null)} disabled={removing}>
              Cancel
            </Button>
            <Button onPress={() => deleting && void remove(deleting)} loading={removing} disabled={removing}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 4 },
  meta: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  next: { color: BRAND.ink },
  skipped: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, paddingTop: 8 },
});
