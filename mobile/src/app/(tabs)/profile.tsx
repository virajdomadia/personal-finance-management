import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView } from "react-native";
import { Button, Dialog, Portal, Text } from "react-native-paper";

import { type NotificationSwitch, ProfileView } from "@/components/profile-view";
import { type Streak } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { EXPORTS, ExportError, type ExportKind, exportError } from "@/lib/data-export";
import { type Family, possessive, viewingLabel } from "@/lib/family";
import { shareExport } from "@/lib/export-share";
import { NEEDS_UPDATE } from "@/lib/native";
import { useProfile } from "@/lib/profile";
import { type ReminderKind, disableReminder, enableReminder, readReminderPref } from "@/lib/reminder-schedule";
import { useSession } from "@/lib/session";
import { disableWeeklySummary, enableWeeklySummary, readSummaryPref } from "@/lib/weekly-summary";

const DENIED = "Notifications weren't allowed, so this stays off.";
const BLOCKED = "Notifications are off for Gullak. Allow them in your phone's settings, then turn this on again.";
const FAILED = "Couldn't set the reminder. Try again.";
const OFFLINE_REMINDERS = "Couldn't reach the server to set these up. Check your connection and try again.";

type SwitchState = { on: boolean; busy: boolean; note: string | null };

// A due-reminder or budget-alert switch: asks for permission when turned on, and fetches what to
// remind about there and then.
function useReminderSwitch(kind: ReminderKind, token: string | null) {
  const [state, setState] = useState<SwitchState>(() => ({ on: readReminderPref(kind), busy: false, note: null }));
  const onChange = async (on: boolean) => {
    setState((s) => ({ ...s, busy: true, note: null }));
    try {
      if (on) {
        if (token === null) {
          setState({ on: false, busy: false, note: FAILED });
          return;
        }
        const result = await enableReminder(kind, token);
        const note = result === "denied" ? DENIED : result === "blocked" ? BLOCKED : result === "needs-update" ? NEEDS_UPDATE : null;
        setState({ on: result === "on", busy: false, note });
      } else {
        await disableReminder(kind);
        setState({ on: false, busy: false, note: null });
      }
    } catch {
      // Turned on but the first fetch failed: it stays on and catches up on the next app open.
      setState({ on: readReminderPref(kind), busy: false, note: on ? OFFLINE_REMINDERS : FAILED });
    }
  };
  return { ...state, onChange: (on: boolean) => void onChange(on) };
}

export default function ProfileScreen() {
  const { token, logOut } = useSession();
  const { profile, switchProfile, syncFamily } = useProfile();
  const [family, setFamily] = useState<Family | null>(null);
  const [familyFailed, setFamilyFailed] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [streak, setStreak] = useState<number | null>(null);
  const [summaryOn, setSummaryOn] = useState(readSummaryPref);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryNote, setSummaryNote] = useState<string | null>(null);
  const dueSwitch = useReminderSwitch("due", token);
  const budgetSwitch = useReminderSwitch("budget", token);

  // Asked only when the user turns it on; off cancels the schedule.
  const onSummary = async (on: boolean) => {
    setSummaryBusy(true);
    setSummaryNote(null);
    try {
      if (on) {
        const result = await enableWeeklySummary();
        setSummaryOn(result === "on");
        if (result === "denied") setSummaryNote(DENIED);
        if (result === "blocked") setSummaryNote(BLOCKED);
        if (result === "needs-update") setSummaryNote(NEEDS_UPDATE);
      } else {
        await disableWeeklySummary();
        setSummaryOn(false);
      }
    } catch {
      setSummaryOn(readSummaryPref());
      setSummaryNote(FAILED);
    } finally {
      setSummaryBusy(false);
    }
  };
  const latest = useRef(0);
  const [exporting, setExporting] = useState<"choose" | ExportKind | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const startExport = (kind: ExportKind) => {
    setExporting(kind);
    setExportMessage(null);
    shareExport(kind, token ?? undefined).then(
      () => setExporting(null),
      (err: unknown) => {
        const failure = err instanceof ExportError ? err.failure : ({ stage: "save" } as const);
        if (failure.stage === "server" && failure.status === 401) {
          setExporting(null);
          void logOut();
          return;
        }
        setExportMessage(exportError(failure));
        setExporting("choose");
      },
    );
  };
  const busy = exporting !== null && exporting !== "choose";

  const notifications: NotificationSwitch[] = [
    {
      key: "due",
      title: "📅 Bills and dues",
      label: "Bills and dues",
      text: "At 9 am the day before and on the day: card bills, EMIs, SIPs, RDs, FDs and recurring payments. Premiums a week ahead too.",
      ...dueSwitch,
    },
    {
      key: "budget",
      title: "💰 Budget alerts",
      label: "Budget alerts",
      text: "When a budget reaches 80% and again when it goes over, once each a month.",
      ...budgetSwitch,
    },
    {
      key: "summary",
      title: "🗞️ Weekly summary",
      label: "Weekly summary",
      text: "Sunday at 7 pm (phone time): what you spent, budgets at risk and what's due next.",
      on: summaryOn,
      busy: summaryBusy,
      note: summaryNote,
      onChange: (on) => void onSummary(on),
    },
  ];

  const loadFamily = useCallback(() => {
    setFamilyFailed(false);
    apiFetch<Family>("/family", { token: token ?? undefined }).then(
      (f) => {
        setFamily(f);
        syncFamily(f);
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logOut();
        else setFamilyFailed(true);
      },
    );
  }, [token, logOut, syncFamily]);

  useFocusEffect(
    useCallback(() => {
      loadFamily();
    }, [loadFamily]),
  );

  useFocusEffect(
    useCallback(() => {
      const mine = ++latest.current;
      apiFetch<Streak>("/streak", { token: token ?? undefined }).then(
        (s) => {
          if (mine === latest.current) setStreak(s.days);
        },
        (err: unknown) => {
          if (mine !== latest.current) return;
          if (err instanceof ApiError && err.status === 401) void logOut();
        },
      );
    }, [token, logOut]),
  );

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
      <ProfileView
        viewing={viewingLabel(profile)}
        viewingMember={profile !== null}
        onViewing={() => {
          setChoosing(true);
          loadFamily();
        }}
        onManageFamily={() => router.push("/family-members")}
        streak={streak}
        notifications={notifications}
        onGoals={() => router.push("/goals")}
        onRecurring={() => router.push("/recurring")}
        onInsurance={() => router.push("/insurance")}
        onArchived={() => router.push("/archived-accounts")}
        onSms={() => router.push("/sms-settings")}
        onPayeeRules={() => router.push("/payee-rules")}
        onCategories={() => router.push("/categories")}
        onBudgets={() => router.push("/budgets")}
        onExport={() => {
          setExportMessage(null);
          setExporting("choose");
        }}
        onLogOut={() => void logOut()}
      />
      <Portal>
        <Dialog visible={choosing} onDismiss={() => setChoosing(false)}>
          <Dialog.Title>Whose profile?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Everything you see and record is for the profile you choose, until you switch back. Bank SMS stay yours.
            </Text>
            {familyFailed && family === null ? (
              <Text variant="bodyMedium" accessibilityRole="alert" style={{ marginTop: 8, fontWeight: "700" }}>
                We couldn&apos;t load your family. Try again.
              </Text>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions style={{ flexDirection: "column", alignItems: "stretch" }}>
            {[{ id: null, name: "Me" }, ...(family?.members ?? [])].map((person) => {
              const selected = (profile?.id ?? null) === person.id;
              return (
                <Button
                  key={person.id ?? "me"}
                  mode={selected ? "contained" : "outlined"}
                  icon={selected ? "check" : undefined}
                  accessibilityState={{ selected }}
                  onPress={() => {
                    setChoosing(false);
                    if (!selected) switchProfile(person.id === null ? null : { id: person.id, name: person.name });
                  }}
                  style={{ marginBottom: 8 }}
                >
                  {person.name}
                </Button>
              );
            })}
            <Button
              onPress={() => {
                setChoosing(false);
                router.push("/family-members");
              }}
            >
              Manage family
            </Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={exporting !== null} onDismiss={() => (busy ? undefined : setExporting(null))}>
          <Dialog.Title>Export my data</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Spreadsheets and the Excel workbook open in Excel or Sheets. The full backup holds everything, for loading back in later.{" "}
              {profile === null ? "Only your own data is included." : `Only ${possessive(profile.name)} data is included.`}
            </Text>
            {exportMessage ? (
              <Text variant="bodyMedium" accessibilityLiveRegion="polite" style={{ marginTop: 8, fontWeight: "700" }}>
                {exportMessage}
              </Text>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions style={{ flexDirection: "column", alignItems: "stretch" }}>
            {(["csv", "xlsx", "backup"] as const).map((kind) => (
              <Button
                key={kind}
                mode={kind === "csv" ? "contained" : "outlined"}
                onPress={() => startExport(kind)}
                loading={exporting === kind}
                disabled={busy}
                style={{ marginBottom: 8 }}
              >
                {EXPORTS[kind].title}
              </Button>
            ))}
            <Button onPress={() => setExporting(null)} disabled={busy}>
              Cancel
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}
