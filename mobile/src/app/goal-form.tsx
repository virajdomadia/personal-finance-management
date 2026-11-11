import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { DateField } from "@/components/date-field";
import { Banner, Choice, Heading, LoadingScreen, useBlockBack, useFieldScroll } from "@/components/form-parts";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Goal,
  type GoalDetail,
  type GoalForm,
  type GoalKind,
  type GoalList,
  changedGoal,
  efText,
  goalErrors,
  goalFormBlank,
  goalFormFrom,
  goalPayload,
} from "@/lib/goals";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const MONEY_MAX_LENGTH = 24;
const KINDS: { value: GoalKind; label: string }[] = [
  { value: "custom", label: "A goal" },
  { value: "emergency", label: "Emergency fund" },
];

type Key = Exclude<keyof GoalForm, "kind">;
// `hasEmergency`: an active emergency fund exists, so a new goal can only be custom.
type Loaded = { goal: Goal | null; hasEmergency: boolean };

export default function GoalFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { token, logOut } = useSession();
  const editing = id !== undefined;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    const request = editing
      ? apiFetch<GoalDetail>(`/goals/${id}`, auth).then((goal) => ({ goal, hasEmergency: false }))
      : apiFetch<GoalList>("/goals?archived=false", auth).then((list) => ({
          goal: null,
          hasEmergency: list.goals.some((g) => g.kind === "emergency"),
        }));
    request
      .then((result) => {
        if (!current) return;
        if (result.goal?.archived) setLoadError("Restore this goal first.");
        else setLoaded(result);
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
  }, [editing, id, token, logOut, attempt]);

  if (loaded === null) {
    return (
      <LoadingScreen
        title={editing ? "Edit goal" : "Add goal"}
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

function FormBody({ goal, hasEmergency }: Loaded) {
  const editing = goal !== null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<GoalForm>(() => (goal ? goalFormFrom(goal) : goalFormBlank("custom")));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const { scrollRef, scrollTo, field } = useFieldScroll();
  const busy = saving || conflict !== null;
  const emergency = form.kind === "emergency";
  const noReminder = form.monthly_amount.trim() === "";

  useBlockBack(useCallback(() => savingRef.current, []));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));
  // Switching kind starts that kind's blank form, keeping what applies to both.
  const changeKind = (kind: GoalKind) => {
    if (kind === form.kind) return;
    setErrors({});
    setForm((f) => ({
      ...goalFormBlank(kind),
      name: f.name,
      target_date: f.target_date,
      monthly_amount: f.monthly_amount,
      reminder_day: f.reminder_day,
      note: f.note,
    }));
  };

  const rendered: string[] = [
    ...(editing ? [] : ["kind"]),
    "name",
    ...(emergency ? ["ef_months", "ef_monthly_override"] : ["target_amount"]),
    "target_date",
    "monthly_amount",
    "reminder_day",
    "note",
  ];
  const showErrors = (fields: Record<string, string>, messages: string[]) => {
    setErrors(fields);
    setGeneral(messages);
    scrollTo(rendered.find((key) => fields[key]));
  };

  async function save() {
    if (savingRef.current) return;

    let payload: Record<string, unknown>;
    if (goal) {
      payload = changedGoal(form, goal);
      if (Object.keys(payload).length === 0) {
        router.back();
        return;
      }
    } else {
      payload = goalPayload(form, "create");
    }
    const found = goalErrors(form);
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
      if (goal) {
        await apiFetch(`/goals/${goal.id}`, { method: "PATCH", ...auth });
        done = true;
        if (mounted.current) router.back();
      } else {
        const saved = await apiFetch<Goal>("/goals", { method: "POST", ...auth });
        done = true;
        // Straight to the new goal, so the next step (set aside, add a holding) is right there.
        if (mounted.current) router.replace({ pathname: "/goal", params: { id: String(saved.id) } });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 409 && !editing) {
        // "You already have an emergency fund.": it can be made a custom goal instead, so the form stays open.
        showErrors({}, [errorMessage({ detail: err.detail })]);
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
      // After success the screen is on its way out, so keep a second tap from saving again.
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
  const money = { keyboardType: "decimal-pad", maxLength: MONEY_MAX_LENGTH } as const;

  // How the emergency fund's monthly figure is worked out today, when editing one.
  const computed = goal?.ef?.computed ?? null;
  const overrideHint =
    computed === null
      ? editing
        ? "There isn't a full month of spending recorded yet, so enter your own figure."
        : "Leave it blank to use the average of your recorded spending over the last 6 full months."
      : `Leave it blank to use your recorded average, ${whole(computed)} a month.`;
  const hint = (text: string) => (
    <Text variant="bodySmall" style={[styles.hint, { color: BRAND.zinc600 }]}>
      {text}
    </Text>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={editing ? "Edit goal" : "Add goal"} back backDisabled={saving} />

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

          {editing ? null : (
            field(
              "kind",
              <>
                <Heading label="What is it" />
                <View style={styles.chips}>
                  {KINDS.map((k) => (
                    <Choice
                      key={k.value}
                      label={k.label}
                      selected={form.kind === k.value}
                      disabled={busy || (k.value === "emergency" && hasEmergency)}
                      onPress={() => changeKind(k.value)}
                    />
                  ))}
                </View>
                {hasEmergency ? hint("You already have an emergency fund.") : null}
              </>,
              errors.kind,
            )
          )}

          {field(
            "name",
            input("name", "Name", { maxLength: 60, placeholder: emergency ? "Emergency fund" : "Bike" }),
            errors.name,
          )}

          {emergency ? (
            <>
              {editing && goal.ef ? hint(`Target now: ${efText(goal)}`) : null}
              {field(
                "ef_months",
                input("ef_months", "Months of expenses", { keyboardType: "number-pad", maxLength: 2 }),
                errors.ef_months,
              )}
              {field(
                "ef_monthly_override",
                <>
                  {input("ef_monthly_override", "Monthly expenses (₹, optional)", money)}
                  {hint(overrideHint)}
                </>,
                errors.ef_monthly_override,
              )}
            </>
          ) : (
            field("target_amount", input("target_amount", "Target (₹)", money), errors.target_amount)
          )}

          {field(
            "target_date",
            <DateField
              label="Reach it by (optional)"
              value={form.target_date}
              onChange={(iso) => set("target_date", iso)}
              disabled={busy}
              invalid={Boolean(errors.target_date)}
              chips={[{ label: "No date", value: "" }]}
            />,
            errors.target_date,
          )}

          <Heading label="Monthly reminder" />
          {field(
            "monthly_amount",
            <>
              {input("monthly_amount", "Set aside each month (₹)", money)}
              {hint("Leave it blank for no reminder.")}
            </>,
            errors.monthly_amount,
          )}
          {field(
            "reminder_day",
            <>
              {input("reminder_day", "Remind me on day", {
                keyboardType: "number-pad",
                maxLength: 2,
                disabled: busy || noReminder,
              })}
              {hint("1 to 31. A short month uses its last day.")}
            </>,
            errors.reminder_day,
          )}

          {field("note", input("note", "Note (optional)", { maxLength: 200, multiline: true }), errors.note)}

          <ChunkyButton
            variant="green"
            label={saving ? "Saving..." : editing ? "Save changes" : "Add goal"}
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
  hint: { marginTop: 4, paddingHorizontal: 4 },
  save: { marginTop: 8 },
});
