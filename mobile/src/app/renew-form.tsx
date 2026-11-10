import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { Appbar, Button, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DateField } from "@/components/date-field";
import { Banner, Choice, Heading, LoadingScreen, useBlockBack, useFieldScroll } from "@/components/form-parts";
import { type Account, type AccountList, errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Policy, type RenewForm, renewErrors, renewFormFrom, renewPayload } from "@/lib/insurance";
import { useSession } from "@/lib/session";
import { isDeposit, previousDay, todayIndia } from "@/lib/transactions";

const MONEY_MAX_LENGTH = 24;
const RENDERED = ["date", "amount", "account_id", "period_start", "period_end", "sum_insured"];

type Key = keyof RenewForm;
type Loaded = { accounts: Account[]; policy: Policy };

export default function RenewFormScreen() {
  const { policyId } = useLocalSearchParams<{ policyId?: string }>();
  const { token, logOut } = useSession();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    Promise.all([apiFetch<AccountList>("/accounts", auth), apiFetch<{ policies: Policy[] }>("/insurance", auth)])
      .then(([accounts, list]) => {
        if (!current) return;
        const policy = list.policies.find((p) => String(p.id) === policyId) ?? null;
        if (policy === null) setLoadError("That policy isn't there any more.");
        else setLoaded({ accounts: accounts.accounts, policy });
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return;
        }
        setLoadError(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
      });
    return () => {
      current = false;
    };
  }, [policyId, token, logOut, attempt]);

  if (loaded === null) {
    return (
      <LoadingScreen
        title="Renew policy"
        error={loadError}
        onRetry={() => {
          setLoadError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  return <FormBody {...loaded} />;
}

function FormBody({ accounts, policy }: Loaded) {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<RenewForm>(() => renewFormFrom(policy, todayIndia()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const { scrollRef, scrollTo, field } = useFieldScroll();
  const busy = saving || conflict !== null;

  useBlockBack(useCallback(() => savingRef.current, []));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const showErrors = (fields: Record<string, string>, messages: string[]) => {
    setErrors(fields);
    setGeneral(messages);
    scrollTo(RENDERED.find((key) => fields[key]));
  };

  async function save() {
    if (savingRef.current) return;
    const found = renewErrors(form, todayIndia(), policy.period_end);
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
      await apiFetch(`/insurance/${policy.id}/renew`, {
        method: "POST",
        token: token ?? undefined,
        body: renewPayload(form),
      });
      done = true;
      if (mounted.current) router.back();
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

  const input = (key: Key, label: string) => (
    <TextInput
      mode="outlined"
      label={label}
      value={form[key]}
      onChangeText={(text) => set(key, text)}
      error={Boolean(errors[key])}
      disabled={busy}
      keyboardType="decimal-pad"
      maxLength={MONEY_MAX_LENGTH}
      autoComplete="off"
      importantForAutofill="no"
      autoCorrect={false}
    />
  );

  // Keep the account the policy was paid from listed even if it has since been archived.
  const payFrom = accounts
    .filter((a) => String(a.id) === form.account_id || (!isDeposit(a) && a.type !== "loan"))
    .map((a) => ({ value: String(a.id), label: a.name }));
  if (form.account_id !== "" && !payFrom.some((o) => o.value === form.account_id)) {
    payFrom.push({ value: form.account_id, label: policy.paying_account_name });
  }
  const today = todayIndia();

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} disabled={saving} />
        <Appbar.Content title="Renew policy" />
      </Appbar.Header>

      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {conflict !== null ? (
            <View style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
              <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                {conflict}
              </Text>
              <Button mode="contained" onPress={() => router.back()}>
                Go back
              </Button>
            </View>
          ) : null}
          <Banner messages={general} />

          <Text variant="titleMedium">
            {policy.insurer}, {policy.plan}
          </Text>
          <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
            Records this year&apos;s premium as a payment and moves the policy on to its next year.
          </Text>

          {field(
            "date",
            <DateField
              label="Paid on"
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
          {field("amount", input("amount", "Premium (₹)"), errors.amount)}
          {field(
            "account_id",
            <>
              <Heading label="Paid from" />
              <View style={styles.chips}>
                {payFrom.map((o) => (
                  <Choice
                    key={o.value}
                    label={o.label}
                    selected={form.account_id === o.value}
                    disabled={busy}
                    onPress={() => set("account_id", o.value)}
                  />
                ))}
              </View>
            </>,
            errors.account_id,
          )}
          {field(
            "period_start",
            <DateField
              label="New year starts"
              value={form.period_start}
              onChange={(iso) => set("period_start", iso)}
              disabled={busy}
              invalid={Boolean(errors.period_start)}
              chips={[]}
            />,
            errors.period_start,
          )}
          {field(
            "period_end",
            <DateField
              label="New year ends"
              value={form.period_end}
              onChange={(iso) => set("period_end", iso)}
              disabled={busy}
              invalid={Boolean(errors.period_end)}
              chips={[]}
            />,
            errors.period_end,
          )}
          {field("sum_insured", input("sum_insured", "Sum insured (₹)"), errors.sum_insured)}

          <Button
            mode="contained"
            onPress={() => void save()}
            loading={saving}
            disabled={busy}
            contentStyle={styles.saveContent}
            style={styles.save}
          >
            {saving ? "Renewing..." : "Renew"}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
  banner: { borderRadius: 12, padding: 12, gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  save: { marginTop: 8 },
  saveContent: { height: 48 },
});
