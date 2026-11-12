import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { Switch, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { CategoryChips } from "@/components/category-chips";
import { DateField } from "@/components/date-field";
import { Banner, Choice, Heading, LoadingScreen, useBlockBack, useFieldScroll } from "@/components/form-parts";
import { type Account, type AccountList, errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { CATEGORIES_PATH, EMPTY_TREE, type CategoryTree, pickerGroups, sameName } from "@/lib/categories";
import {
  type Frequency,
  type Template,
  type TemplateForm,
  type TemplateType,
  changedTemplate,
  templateErrors,
  templateFormBlank,
  templateFormFrom,
  templatePayload,
} from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { isDeposit, todayIndia } from "@/lib/transactions";

const MONEY_MAX_LENGTH = 24;
const TYPES: { value: TemplateType; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
];
const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "monthly", label: "Every month" },
  { value: "yearly", label: "Every year" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// What a policy's reminder lets you change; the rest follows the policy.
const POLICY_FIELDS = new Set(["name", "note", "remind_days"]);

type Key = keyof TemplateForm;
type Loaded = { accounts: Account[]; categories: CategoryTree; template: Template | null };

export default function TemplateFormScreen() {
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
      // Only suggestions: if this fails the user can still type a category.
      apiFetch<CategoryTree>(CATEGORIES_PATH, auth).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) throw err;
        return EMPTY_TREE;
      }),
      editing ? apiFetch<{ templates: Template[] }>("/recurring", auth) : Promise.resolve(null),
    ])
      .then(([accounts, categories, list]) => {
        if (!current) return;
        const template = list?.templates.find((t) => String(t.id) === id) ?? null;
        if (editing && template === null) {
          setLoadError("This reminder was not found.");
          return;
        }
        setLoaded({ accounts: accounts.accounts, categories, template });
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
        title={editing ? "Edit reminder" : "Add reminder"}
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

function FormBody({ accounts, categories, template }: Loaded) {
  const editing = template !== null;
  const fromPolicy = template !== null && template.policy_id !== null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<TemplateForm>(() => (template ? templateFormFrom(template) : templateFormBlank("monthly")));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const { scrollRef, scrollTo, field } = useFieldScroll();

  const busy = saving || conflict !== null;
  const locked = (key: string) => busy || (fromPolicy && !POLICY_FIELDS.has(key));

  useBlockBack(useCallback(() => savingRef.current, []));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const changeType = (type: TemplateType) => {
    if (type === form.type) return;
    setErrors({});
    setForm((f) => ({ ...f, type, category: "", to_account_id: "" }));
  };
  const changeFrequency = (next: Frequency) => {
    if (next === form.frequency) return;
    setErrors({});
    // The reminder window has a default for each frequency; follow it unless the user set their own.
    setForm((f) => {
      const untouched = f.remind_days === templateFormBlank(f.frequency).remind_days;
      return { ...f, frequency: next, remind_days: untouched ? templateFormBlank(next).remind_days : f.remind_days };
    });
  };
  const changeFrom = (accountId: string) =>
    setForm((f) => ({ ...f, account_id: accountId, to_account_id: f.to_account_id === accountId ? "" : f.to_account_id }));

  const rendered: Key[] = [
    "name",
    "amount",
    "account_id",
    form.type === "transfer" ? "to_account_id" : "category",
    "note",
    "frequency",
    "day",
    ...(form.frequency === "yearly" ? (["month"] as const) : []),
    "start_date",
    "end_date",
    "remind_days",
  ];
  const showErrors = (fields: Record<string, string>, messages: string[]) => {
    setErrors(fields);
    setGeneral(messages);
    scrollTo(rendered.find((key) => fields[key]));
  };

  async function save() {
    if (savingRef.current) return;

    let payload: Record<string, unknown>;
    if (template) {
      payload = changedTemplate(form, template);
      if (Object.keys(payload).length === 0) {
        router.back();
        return;
      }
    } else {
      payload = templatePayload(form, "create");
    }
    const found = templateErrors(form);
    const mine = Object.fromEntries(Object.entries(found).filter(([key]) => !fromPolicy || POLICY_FIELDS.has(key)));
    if (Object.keys(mine).length > 0) {
      showErrors(mine, []);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      const auth = { token: token ?? undefined, body: payload };
      if (template) await apiFetch(`/recurring/${template.id}`, { method: "PATCH", ...auth });
      else await apiFetch("/recurring", { method: "POST", ...auth });
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
      value={form[key] as string}
      onChangeText={(text) => set(key, text)}
      error={Boolean(errors[key])}
      disabled={locked(key)}
      autoComplete="off"
      importantForAutofill="no"
      autoCorrect={false}
      {...extra}
    />
  );

  const option = (a: Account) => (
    <Choice
      key={a.id}
      label={a.name}
      selected={form.account_id === String(a.id)}
      disabled={locked("account_id")}
      onPress={() => changeFrom(String(a.id))}
    />
  );
  // A reminder is recorded as a transaction, which can't be paid from a PPF or RD; the server has the final say.
  const fromAccounts = accounts.filter(
    (a) =>
      String(a.id) === form.account_id ||
      (form.type === "expense" ? !isDeposit(a) : form.type === "transfer" ? String(a.id) !== form.to_account_id : true),
  );
  const toAccounts = accounts.filter((a) => String(a.id) === form.to_account_id || String(a.id) !== form.account_id);
  const fromLabel = form.type === "income" ? "Received in" : form.type === "transfer" ? "From account" : "Paid from";
  // Live categories, with subcategories under their parent; archived ones are left out.
  const categoryGroups = form.type === "transfer" ? [] : pickerGroups(categories[form.type]);
  const today = todayIndia();

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={editing ? "Edit reminder" : "Add reminder"} back backDisabled={saving} />

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
              <ChunkyButton label="Back to reminders" onPress={() => router.back()} />
            </ChunkyBox>
          ) : null}
          <Banner messages={general} />
          {fromPolicy ? (
            <Banner
              tone="info"
              messages={[
                "This reminder belongs to an insurance policy. Change its amount, account and dates from the policy; here you can edit only its name, note and reminder window.",
              ]}
            />
          ) : null}

          <View>
            <Heading label="Type" />
            {editing ? (
              <Text variant="bodyLarge">{TYPES.find((t) => t.value === form.type)?.label}</Text>
            ) : (
              <View style={styles.chips}>
                {TYPES.map((t) => (
                  <Choice key={t.value} label={t.label} selected={form.type === t.value} disabled={busy} onPress={() => changeType(t.value)} />
                ))}
              </View>
            )}
          </View>

          {field("name", input("name", "Name", { maxLength: 60 }), errors.name)}
          {field("amount", input("amount", "Amount (₹)", { keyboardType: "decimal-pad", maxLength: MONEY_MAX_LENGTH }), errors.amount)}
          {field(
            "account_id",
            <>
              <Heading label={fromLabel} />
              <View style={styles.chips}>{fromAccounts.map(option)}</View>
            </>,
            errors.account_id,
          )}
          {form.type === "transfer"
            ? field(
                "to_account_id",
                <>
                  <Heading label="To account" />
                  <View style={styles.chips}>
                    {toAccounts.map((a) => (
                      <Choice
                        key={a.id}
                        label={a.name}
                        selected={form.to_account_id === String(a.id)}
                        disabled={locked("to_account_id")}
                        onPress={() => set("to_account_id", String(a.id))}
                      />
                    ))}
                  </View>
                </>,
                errors.to_account_id,
              )
            : field(
                "category",
                <>
                  {input("category", "Category", { maxLength: 40 })}
                  <CategoryChips
                    groups={categoryGroups}
                    selected={(name) => sameName(form.category, name)}
                    onPick={(name) => set("category", name)}
                    disabled={locked("category")}
                  />
                </>,
                errors.category,
              )}
          {field("note", input("note", "Note (optional)", { maxLength: 200 }), errors.note)}

          {field(
            "frequency",
            <>
              <Heading label="Repeats" />
              <View style={styles.chips}>
                {FREQUENCIES.map((f) => (
                  <Choice
                    key={f.value}
                    label={f.label}
                    selected={form.frequency === f.value}
                    disabled={locked("frequency")}
                    onPress={() => changeFrequency(f.value)}
                  />
                ))}
              </View>
            </>,
            errors.frequency,
          )}
          {field("day", input("day", "Day of the month", { keyboardType: "number-pad", maxLength: 2 }), errors.day)}
          {Number(form.day) > 28 ? (
            <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
              In shorter months it falls on the last day.
            </Text>
          ) : null}
          {form.frequency === "yearly"
            ? field(
                "month",
                <>
                  <Heading label="Month" />
                  <View style={styles.chips}>
                    {MONTHS.map((name, index) => (
                      <Choice
                        key={name}
                        label={name}
                        selected={form.month === String(index + 1)}
                        disabled={locked("month")}
                        onPress={() => set("month", String(index + 1))}
                      />
                    ))}
                  </View>
                </>,
                errors.month,
              )
            : null}

          {field(
            "start_date",
            <DateField
              label="Starting"
              value={form.start_date}
              onChange={(iso) => set("start_date", iso)}
              disabled={locked("start_date")}
              invalid={Boolean(errors.start_date)}
              chips={[{ label: "Today", value: today }]}
            />,
            errors.start_date,
          )}
          {field(
            "end_date",
            <DateField
              label="Ending (optional)"
              value={form.end_date}
              onChange={(iso) => set("end_date", iso)}
              disabled={locked("end_date")}
              invalid={Boolean(errors.end_date)}
              chips={[{ label: "No end", value: "" }]}
            />,
            errors.end_date,
          )}
          {field(
            "remind_days",
            input("remind_days", "Show it this many days ahead", { keyboardType: "number-pad", maxLength: 2 }),
            errors.remind_days,
          )}

          {editing && !fromPolicy ? (
            <View style={styles.switchRow}>
              <Text variant="bodyLarge" style={styles.switchLabel}>
                Active
              </Text>
              <Switch
                value={form.active}
                disabled={busy}
                onValueChange={(value) => setForm((f) => ({ ...f, active: value }))}
                accessibilityLabel="Active"
              />
            </View>
          ) : null}

          <ChunkyButton
            variant="green"
            label={saving ? "Saving..." : editing ? "Save changes" : "Add reminder"}
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
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { flexShrink: 1 },
  save: { marginTop: 8 },
});
