import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ScrollView } from "react-native";
import { Button, Dialog, Portal, Text } from "react-native-paper";

import { ProfileView } from "@/components/profile-view";
import { type Streak } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { EXPORTS, ExportError, type ExportKind, exportError } from "@/lib/data-export";
import { shareExport } from "@/lib/export-share";
import { NEEDS_UPDATE } from "@/lib/native";
import { useSession } from "@/lib/session";
import { disableWeeklySummary, enableWeeklySummary, readSummaryPref } from "@/lib/weekly-summary";

const DENIED = "Notifications weren't allowed, so the summary stays off.";
const BLOCKED = "Notifications are off for Gullak. Allow them in your phone's settings, then turn this on again.";
const FAILED = "Couldn't set the reminder. Try again.";

export default function ProfileScreen() {
  const { token, logOut } = useSession();
  const [streak, setStreak] = useState<number | null>(null);
  const [summaryOn, setSummaryOn] = useState(readSummaryPref);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryNote, setSummaryNote] = useState<string | null>(null);

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
  const busy = exporting === "csv" || exporting === "backup";

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
        streak={streak}
        summaryOn={summaryOn}
        summaryBusy={summaryBusy}
        summaryNote={summaryNote}
        onSummary={(on) => void onSummary(on)}
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
        <Dialog visible={exporting !== null} onDismiss={() => (busy ? undefined : setExporting(null))}>
          <Dialog.Title>Export my data</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Spreadsheets open in Excel or Sheets. The full backup holds everything, for loading back in later. Only your own data is included.
            </Text>
            {exportMessage ? (
              <Text variant="bodyMedium" accessibilityLiveRegion="polite" style={{ marginTop: 8, fontWeight: "700" }}>
                {exportMessage}
              </Text>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions style={{ flexDirection: "column", alignItems: "stretch" }}>
            {(["csv", "backup"] as const).map((kind) => (
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
