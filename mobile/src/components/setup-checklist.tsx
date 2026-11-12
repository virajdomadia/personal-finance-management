import { type Href, router, useFocusEffect } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { ChunkyBox, ChunkyButton, ProgressBar, Row } from "@/components/chunky";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  type ChecklistStep,
  type Mode,
  SETUP_KEY,
  type ServerStep,
  type SetupResponse,
  type SetupState,
  checklistSteps,
  parseSetupState,
  progressOf,
  progressText,
  shownAs,
  statusText,
  withNone,
} from "@/lib/setup";
import { loadSmsSettings } from "@/lib/sms/settings";
import { BRAND } from "@/lib/theme";
import { isAvailable } from "../../modules/sms-inbox";

function readState(): SetupState {
  try {
    return parseSetupState(SecureStore.getItem(SETUP_KEY));
  } catch {
    return parseSetupState(null);
  }
}

function saveState(state: SetupState): void {
  try {
    SecureStore.setItem(SETUP_KEY, JSON.stringify(state));
  } catch {
    // Not remembered, then; the change still shows until the app restarts.
  }
}

// The new-user checklist at the top of the dashboard. It loads its own data each time the
// dashboard comes into focus, so a step ticks off when the user comes back from adding something.
// Bank SMS is a step only in an app that can read SMS, and it's done when reading is on.
export function SetupChecklist() {
  const { token } = useSession();
  const [server, setServer] = useState<ServerStep[] | null>(null);
  const [smsOn, setSmsOn] = useState<boolean | null>(null);
  const [state, setState] = useState<SetupState>(readState);
  const latest = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const mine = ++latest.current;
      const sms = isAvailable() ? loadSmsSettings().then((s) => s.enabled) : Promise.resolve(null);
      Promise.all([apiFetch<SetupResponse>("/setup", { token: token ?? undefined }), sms])
        .then(([data, on]) => {
          if (mine !== latest.current) return;
          setServer(data.steps);
          setSmsOn(on);
          setState(readState());
        })
        .catch(() => {
          // The dashboard says when it can't load; the checklist just stays as it was.
        });
    }, [token]),
  );

  const update = (next: SetupState) => {
    saveState(next);
    setState(next);
  };
  const setMode = (mode: Mode) => update({ ...state, mode });

  if (server === null) return null;
  const steps = checklistSteps(server, smsOn, state.none);
  const shown = shownAs(steps, state.mode);
  if (shown === "nothing") return null;

  if (shown === "later") {
    return (
      <ChunkyBox radius={14} offset={3} style={styles.strip}>
        <Text variant="titleSmall" style={styles.ink}>
          🧭 Finish setting up · {progressText(steps)}
        </Text>
        <View style={styles.actions}>
          <ChunkyButton compact label="Resume" onPress={() => setMode("open")} />
          <ChunkyButton compact variant="alt" label="Don't show again" onPress={() => setMode("hidden")} />
        </View>
      </ChunkyBox>
    );
  }

  const { finished, total } = progressOf(steps);
  return (
    <ChunkyBox radius={18} offset={4} style={styles.card}>
      <View style={styles.top}>
        <Text variant="titleMedium" accessibilityRole="header" style={[styles.ink, styles.title]}>
          Let&apos;s set up your Gullak
        </Text>
        <ChunkyButton compact variant="alt" label="Later" accessibilityLabel="Skip setup for now" onPress={() => setMode("later")} />
      </View>
      <Text variant="bodySmall" style={styles.sub}>
        A few minutes now and your dashboard fills itself in. Any order; skip what you don&apos;t have.
      </Text>
      <View style={styles.progress}>
        <ProgressBar percent={(finished / total) * 100} reached={false} label="Setup progress" style={styles.bar} />
        <Text variant="labelLarge" style={styles.ink}>
          {progressText(steps)}
        </Text>
      </View>
      {steps.map((step) => (
        <StepRow key={step.key} step={step} onNone={(on) => update(withNone(state, step.key, on))} />
      ))}
    </ChunkyBox>
  );
}

function StepRow({ step, onNone }: { step: ChecklistStep; onNone: (on: boolean) => void }) {
  const done = step.status === "done";
  const none = step.status === "none";
  const open = () => {
    const { pathname, params } = step.target;
    // The investments tab is navigated to, so it isn't stacked on top of the dashboard.
    if (pathname === "/investments") router.navigate(pathname as Href);
    else router.push((params ? { pathname, params } : pathname) as Href);
  };
  const label = `${step.title}, ${done ? "done" : none ? "skipped" : "to do"}. ${statusText(step)}`;
  const action = none ? "undo" : "skip";
  return (
    <Row
      emoji={done ? "✅" : step.emoji}
      tone={done ? "green" : none ? "card" : "yellow"}
      title={step.title}
      meta={statusText(step)}
      onPress={done ? undefined : open}
      accessibilityLabel={label}
      accessibilityHint={done ? undefined : "Opens the screen to add it"}
      accessibilityActions={step.canSkip && !done ? [{ name: action, label: none ? "Undo skip" : "Not for me" }] : undefined}
      onAccessibilityAction={(event) => onNone(event.nativeEvent.actionName === "skip")}
    >
      {step.canSkip && !done ? (
        <View style={styles.rowActions}>
          <ChunkyButton
            compact
            variant="alt"
            label={none ? "Undo" : "Not for me"}
            accessibilityLabel={none ? `Undo skipping ${step.title}` : `${step.title}: not for me`}
            onPress={() => onNone(!none)}
          />
        </View>
      ) : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: BRAND.card, padding: 14, gap: 10 },
  strip: { backgroundColor: BRAND.due, paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { flexShrink: 1 },
  ink: { color: BRAND.ink },
  sub: { color: BRAND.zinc600 },
  progress: { flexDirection: "row", alignItems: "center", gap: 10 },
  bar: { flex: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  rowActions: { flexDirection: "row", justifyContent: "flex-end", marginTop: 8 },
});
