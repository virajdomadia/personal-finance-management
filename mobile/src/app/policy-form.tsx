import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { HelperText, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { DateField } from "@/components/date-field";
import { Banner, Choice, Heading, LoadingScreen, useBlockBack, useFieldScroll } from "@/components/form-parts";
import { type Account, type AccountList, errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Policy,
  type PolicyForm,
  addDays,
  addYear,
  changedPolicy,
  policyErrors,
  policyFormBlank,
  policyFormFrom,
  policyPayload,
} from "@/lib/insurance";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { isDeposit, todayIndia } from "@/lib/transactions";

const MONEY_MAX_LENGTH = 24;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

type Key = keyof PolicyForm;
type Loaded = { accounts: Account[]; policy: Policy | null };

// Only a year paid before the app has a date to edit here; a recorded payment's date is its transaction's.
function paidOnEditable(policy: Policy): boolean {
  const current = policy.periods.find((p) => p.period_start === policy.period_start) ?? policy.periods[policy.periods.length - 1];
  return current !== undefined && current.transaction_id === null;
}

export default function PolicyFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { token, logOut } = useSession();
  const editing = id !== undefined;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    Promise.all([
      apiFetch<AccountList>("/accounts", auth),
      editing ? apiFetch<{ policies: Policy[] }>("/insurance", auth) : Promise.resolve(null),
    ])
      .then(([accounts, list]) => {
        if (!current) return;
        const policy = list?.policies.find((p) => String(p.id) === id) ?? null;
        if (editing && policy === null) {
          setLoadError("This policy was not found.");
          return;
        }
        setLoaded({ accounts: accounts.accounts, policy });
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
  }, [editing, id, token, logOut, attempt]);

  if (loaded === null) {
    return (
      <LoadingScreen
        title={editing ? "Edit policy" : "Add policy"}
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
  const editing = policy !== null;
  const showPaidOn = policy === null || paidOnEditable(policy);
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<PolicyForm>(() => (policy ? policyFormFrom(policy) : policyFormBlank()));
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

  const set = (key: Key, value: string) =>
    setForm((f) => {
      const next = { ...f, [key]: value };
      // A policy year runs to the day before its anniversary: fill the end in when it's still empty.
      if (key === "period_start" && DATE_SHAPE.test(value) && f.period_end === "" && !editing) {
        next.period_end = addDays(addYear(value), -1);
      }
      return next;
    });

  const rendered: Key[] = [
    "insurer",
    "plan",
    "policy_number",
    "insured",
    "sum_insured",
    "premium",
    "period_start",
    "period_end",
    "account_id",
    "funded_by_id",
    "details",
    ...(showPaidOn ? (["paid_on"] as const) : []),
  ];
  const showErrors = (fields: Record<string, string>, messages: string[]) => {
    setErrors(fields);
    setGeneral(messages);
    scrollTo(rendered.find((key) => fields[key]));
  };

  async function save() {
    if (savingRef.current) return;

    const today = todayIndia();
    const found = policyErrors(form, today);
    if (!showPaidOn) delete found.paid_on;
    // An edit sends only what changed, so an old card or a closed funding account never blocks a note.
    let payload: Record<string, unknown>;
    if (policy) {
      payload = changedPolicy(form, policy);
      if (!showPaidOn) delete payload.paid_on;
      if (Object.keys(payload).length === 0) {
        router.back();
        return;
      }
    } else {
      payload = policyPayload(form, "create");
    }
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
      const auth = { token: token ?? undefined, body: payload };
      if (policy) await apiFetch(`/insurance/${policy.id}`, { method: "PATCH", ...auth });
      else await apiFetch("/insurance", { method: "POST", ...auth });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setConflict(errorMessage({ detail: err.detail }));
        scrollTo();
      } else if (err instanceof ApiError && err.status === 422) {
        const result = splitErrors(err.detail, rendered);
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

  const input = (key: Key, label: string, extra: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
    <TextInput
      mode="outlined"
      label={label}
      value={form[key]}
      onChangeText={(text) => set(key, text)}
      error={Boolean(errors[key])}
      disabled={busy}
      autoComplete="off"
      importantForAutofill="no"
      autoCorrect={false}
      {...extra}
    />
  );

  // Keep an account the policy already uses listed even if it has since been archived or closed.
  const withCurrent = (list: Account[], id: string, name: string | undefined) => {
    const options = list.map((a) => ({ value: String(a.id), label: a.name }));
    if (id !== "" && name && !options.some((o) => o.value === id)) options.push({ value: id, label: name });
    return options;
  };
  const payFrom = withCurrent(
    accounts.filter((a) => !isDeposit(a) && a.type !== "loan"),
    form.account_id,
    policy?.paying_account_name,
  );
  const funding = withCurrent(
    accounts.filter((a) => a.type === "rd"),
    form.funded_by_id,
    policy?.funded_by?.name,
  );
  const today = todayIndia();

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={editing ? "Edit policy" : "Add policy"} back backDisabled={saving} />

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
              <ChunkyButton label="Back to insurance" onPress={() => router.back()} />
            </ChunkyBox>
          ) : null}
          <Banner messages={general} />
          {!editing ? (
            <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
              Add the policy as it stands now. A yearly reminder for the premium is created with it, starting at the end of
              this year.
            </Text>
          ) : null}

          {field("insurer", input("insurer", "Insurer", { maxLength: 52 }), errors.insurer)}
          {field("plan", input("plan", "Plan", { maxLength: 100 }), errors.plan)}
          {field("policy_number", input("policy_number", "Policy number", { maxLength: 40 }), errors.policy_number)}
          {field("insured", input("insured", "Insured", { maxLength: 100 }), errors.insured)}
          {field(
            "sum_insured",
            input("sum_insured", "Sum insured (₹)", { keyboardType: "decimal-pad", maxLength: MONEY_MAX_LENGTH }),
            errors.sum_insured,
          )}
          {field(
            "premium",
            input("premium", "Yearly premium (₹)", { keyboardType: "decimal-pad", maxLength: MONEY_MAX_LENGTH }),
            errors.premium,
          )}
          {field(
            "period_start",
            <DateField
              label="Current year starts"
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
              label="Current year ends"
              value={form.period_end}
              onChange={(iso) => set("period_end", iso)}
              disabled={busy}
              invalid={Boolean(errors.period_end)}
              chips={[]}
            />,
            errors.period_end,
          )}
          {field(
            "account_id",
            <>
              <Heading label="Premium is paid from" />
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
            "funded_by_id",
            <>
              <Heading label="Set aside in (optional)" />
              <View style={styles.chips}>
                <Choice label="None" selected={form.funded_by_id === ""} disabled={busy} onPress={() => set("funded_by_id", "")} />
                {funding.map((o) => (
                  <Choice
                    key={o.value}
                    label={o.label}
                    selected={form.funded_by_id === o.value}
                    disabled={busy}
                    onPress={() => set("funded_by_id", o.value)}
                  />
                ))}
              </View>
              {errors.funded_by_id ? null : (
                <HelperText type="info" visible>
                  An RD you&apos;re saving in to pay the premium. The policy then shows whether it will cover it.
                </HelperText>
              )}
            </>,
            errors.funded_by_id,
          )}
          {field(
            "details",
            <>
              {input("details", "Details (optional)", { multiline: true, numberOfLines: 3, maxLength: 2000 })}
              {errors.details ? null : (
                <HelperText type="info" visible>
                  Bonus, add-ons, waiting periods, nominee.
                </HelperText>
              )}
            </>,
            errors.details,
          )}

          {showPaidOn
            ? field(
                "paid_on",
                <>
                  <Heading label="This year's premium" />
                  <DateField
                    label="Paid on"
                    value={form.paid_on}
                    onChange={(iso) => set("paid_on", iso)}
                    disabled={busy}
                    maxDate={today}
                    invalid={Boolean(errors.paid_on)}
                    helper={editing ? "Paid before you used the app, so its date can be corrected here." : undefined}
                  />
                </>,
                errors.paid_on,
              )
            : null}

          <ChunkyButton
            variant="green"
            label={saving ? "Saving..." : editing ? "Save changes" : "Add policy"}
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
  save: { marginTop: 8 },
});
