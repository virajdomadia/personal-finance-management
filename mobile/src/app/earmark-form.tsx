import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { Switch, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { DateField } from "@/components/date-field";
import { Banner, Choice, Heading, LoadingScreen, useBlockBack, useFieldScroll } from "@/components/form-parts";
import { type Account, type AccountList, cleanMoney, errorMessage, formatRupees, headlineBalance, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type EarmarkAction,
  type EarmarkForm,
  type GoalDetail,
  earmarkErrors,
  earmarkFormBlank,
  earmarkPayload,
} from "@/lib/goals";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { previousDay, todayIndia } from "@/lib/transactions";

const MONEY_MAX_LENGTH = 24;
const RENDERED = ["action", "account_id", "amount", "date", "note"];
// Money is only set aside from spending accounts; investments and deposits go in as whole holdings.
const SOURCE_TYPES = new Set(["bank", "cash", "wallet"]);

type Key = Exclude<keyof EarmarkForm, "goal_id" | "action">;
type Loaded = { goal: GoalDetail; sources: Account[] };

// Set money aside for a goal, or release some. `action` picks which; `amount` pre-fills (a monthly reminder).
export default function EarmarkFormScreen() {
  const { goalId, action, amount } = useLocalSearchParams<{ goalId: string; action?: string; amount?: string }>();
  const { token, logOut } = useSession();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    Promise.all([apiFetch<GoalDetail>(`/goals/${goalId}`, auth), apiFetch<AccountList>("/accounts", auth)])
      .then(([goal, accounts]) => {
        if (!current) return;
        if (goal.archived) setLoadError("Restore this goal first.");
        else setLoaded({ goal, sources: accounts.accounts.filter((a) => SOURCE_TYPES.has(a.type)) });
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return;
        }
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? "This goal was not found."
            : errorMessage(err instanceof ApiError ? { detail: err.detail } : err),
        );
      });
    return () => {
      current = false;
    };
  }, [goalId, token, logOut, attempt]);

  const start: EarmarkAction = action === "release" ? "release" : "set_aside";
  if (loaded === null) {
    return (
      <LoadingScreen
        title={start === "release" ? "Release" : "Set aside"}
        error={loadError}
        onRetry={() => {
          setLoadError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  return <FormBody {...loaded} start={start} amount={amount ?? ""} />;
}

function FormBody({ goal, sources, start, amount }: Loaded & { start: EarmarkAction; amount: string }) {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [today] = useState(() => todayIndia());
  const [form, setForm] = useState<EarmarkForm>(() => {
    const blank = { ...earmarkFormBlank(goal.id, start, today), amount };
    // With only one place to choose from, choose it.
    const choices = start === "release" ? goal.earmarks.map((e) => e.account_id) : sources.map((a) => a.id);
    if (choices.length === 1) blank.account_id = String(choices[0]);
    return blank;
  });
  const [recordExpense, setRecordExpense] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const { scrollRef, scrollTo, field } = useFieldScroll();
  const busy = saving || conflict !== null;
  const releasing = form.action === "release";

  useBlockBack(useCallback(() => savingRef.current, []));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const changeAction = (next: EarmarkAction) => {
    if (next === form.action) return;
    setErrors({});
    // The accounts differ between the two, so the choice starts again.
    const choices = next === "release" ? goal.earmarks.map((e) => e.account_id) : sources.map((a) => a.id);
    setForm((f) => ({ ...f, action: next, account_id: choices.length === 1 ? String(choices[0]) : "" }));
  };
  const showErrors = (fields: Record<string, string>, messages: string[]) => {
    setErrors(fields);
    setGeneral(messages);
    scrollTo(RENDERED.find((key) => fields[key]));
  };

  async function save() {
    if (savingRef.current) return;
    const found = earmarkErrors(form, today);
    if (Object.keys(found).length > 0) {
      showErrors(found, []);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      await apiFetch(`/goals/${goal.id}/earmarks`, {
        method: "POST",
        token: token ?? undefined,
        body: earmarkPayload(form),
      });
      done = true;
      if (!mounted.current) return;
      if (releasing && recordExpense) {
        // The release is saved; now the ordinary expense form, from the same account for the same amount.
        router.replace({
          pathname: "/transaction-form",
          params: { releaseAccount: form.account_id, releaseAmount: cleanMoney(form.amount) },
        });
      } else {
        router.back();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setConflict(errorMessage({ detail: err.detail }));
        scrollTo();
      } else if (err instanceof ApiError && err.status === 422) {
        const result = splitErrors(err.detail, RENDERED);
        showErrors(result.fields, result.general);
      } else {
        showErrors({}, [errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      if (!done) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  const options = releasing
    ? goal.earmarks.map((e) => ({ value: String(e.account_id), label: `${e.account_name} · ${whole(e.amount)} set aside` }))
    : sources.map((a) => ({ value: String(a.id), label: `${a.name} · ${formatRupees(headlineBalance(a))} free` }));

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={releasing ? "Release" : "Set aside"} back backDisabled={saving} />

      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {conflict !== null ? (
            <ChunkyBox radius={14} offset={3} style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
              <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                {conflict}
              </Text>
              <ChunkyButton label="Go back" onPress={() => router.back()} />
            </ChunkyBox>
          ) : null}
          <Banner messages={general} />

          <Text variant="titleMedium">{goal.name}</Text>
          <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
            {releasing
              ? "The money stays in the account and is free to spend again."
              : "Nothing moves: the money stays in the account, marked for this goal."}
          </Text>

          {goal.earmarks.length > 0
            ? field(
                "action",
                <View style={styles.chips}>
                  <Choice label="Set aside" selected={!releasing} disabled={busy} onPress={() => changeAction("set_aside")} />
                  <Choice label="Release" selected={releasing} disabled={busy} onPress={() => changeAction("release")} />
                </View>,
                errors.action,
              )
            : null}

          {field(
            "account_id",
            <>
              <Heading label={releasing ? "Release from" : "Set aside in"} />
              {options.length === 0 ? (
                <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
                  Add a bank, cash or wallet account first.
                </Text>
              ) : (
                <View style={styles.chips}>
                  {options.map((o) => (
                    <Choice
                      key={o.value}
                      label={o.label}
                      selected={form.account_id === o.value}
                      disabled={busy}
                      onPress={() => set("account_id", o.value)}
                    />
                  ))}
                </View>
              )}
            </>,
            errors.account_id,
          )}
          {field(
            "amount",
            <TextInput
              mode="outlined"
              label="Amount (₹)"
              value={form.amount}
              onChangeText={(text) => set("amount", text)}
              error={Boolean(errors.amount)}
              disabled={busy}
              keyboardType="decimal-pad"
              maxLength={MONEY_MAX_LENGTH}
              autoComplete="off"
              importantForAutofill="no"
              autoCorrect={false}
            />,
            errors.amount,
          )}
          {field(
            "date",
            <DateField
              label="Date"
              value={form.date}
              onChange={(iso) => set("date", iso)}
              disabled={busy}
              maxDate={today}
              invalid={Boolean(errors.date)}
              chips={[
                { label: "Today", value: today },
                { label: "Yesterday", value: previousDay(today) },
              ]}
            />,
            errors.date,
          )}
          {field(
            "note",
            <TextInput
              mode="outlined"
              label="Note (optional)"
              value={form.note}
              onChangeText={(text) => set("note", text)}
              error={Boolean(errors.note)}
              disabled={busy}
              maxLength={200}
              autoComplete="off"
              importantForAutofill="no"
            />,
            errors.note,
          )}

          {releasing ? (
            <View style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text variant="bodyLarge">Record an expense too</Text>
                <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
                  After releasing, opens a new expense from the same account for the same amount.
                </Text>
              </View>
              <Switch
                value={recordExpense}
                disabled={busy}
                onValueChange={setRecordExpense}
                accessibilityLabel="Record an expense too"
              />
            </View>
          ) : null}

          <ChunkyButton
            variant="green"
            label={saving ? "Saving..." : releasing ? (recordExpense ? "Release and add expense" : "Release") : "Set aside"}
            onPress={() => void save()}
            loading={saving}
            disabled={busy && !saving}
            style={styles.save}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
  banner: { padding: 12, gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  switchLabel: { flexShrink: 1, gap: 2 },
  save: { marginTop: 8 },
});
