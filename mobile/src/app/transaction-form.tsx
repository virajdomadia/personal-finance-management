import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewInstance,
  type TextInputInstance,
} from "react-native";
import { Appbar, Button, Chip, Dialog, HelperText, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Account, type AccountList, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  type CategoryList,
  TRANSACTION_TYPES,
  type Transaction,
  type TransactionForm,
  type TransactionType,
  blankForm,
  changedPayload,
  formFromTransaction,
  previousDay,
  renderedFields,
  savedMonth,
  toPayload,
  todayIndia,
} from "@/lib/transactions";

const MONEY_MAX_LENGTH = 24;

const FROM_LABELS: Record<TransactionType, string> = {
  expense: "Paid from",
  income: "Received in",
  transfer: "From account",
};

type Loaded = { accounts: Account[]; categories: CategoryList; transaction: Transaction | null };

export default function TransactionFormScreen() {
  const { id, account } = useLocalSearchParams<{ id?: string; account?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
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
      apiFetch<CategoryList>("/transactions/categories", auth).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) throw err;
        return { income: [], expense: [] };
      }),
      editing ? apiFetch<Transaction>(`/transactions/${id}`, auth) : Promise.resolve(null),
    ])
      .then(([accounts, categories, transaction]) => {
        if (current) setLoaded({ accounts: accounts.accounts, categories, transaction });
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return;
        }
        setLoadError(
          err instanceof ApiError && err.status === 404 ? "This transaction was not found." : errorMessage(err),
        );
      });
    return () => {
      current = false;
    };
  }, [editing, id, token, logOut, attempt]);

  if (loaded === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title={editing ? "Edit transaction" : "Add transaction"} />
        </Appbar.Header>
        <View style={styles.center}>
          {loadError === null ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {loadError}
              </Text>
              <Button
                mode="contained"
                onPress={() => {
                  setLoadError(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            </>
          )}
        </View>
      </View>
    );
  }

  const preselected = account !== undefined && loaded.accounts.some((a) => String(a.id) === account) ? Number(account) : null;
  return <FormBody {...loaded} defaultAccountId={preselected ?? loaded.accounts[0]?.id ?? null} />;
}

type FieldInputProps = {
  name: keyof TransactionForm;
  label: string;
  value: string;
  invalid: boolean;
  disabled: boolean;
  onChange: (name: keyof TransactionForm, value: string) => void;
  onFocusField: (name: string) => void;
  onBlurField: (name: string) => void;
  register: (name: string, node: TextInputInstance | null) => void;
  extra: Partial<React.ComponentProps<typeof TextInput>>;
};

function FieldInput({ name, label, value, invalid, disabled, onChange, onFocusField, onBlurField, register, extra }: FieldInputProps) {
  return (
    <TextInput
      ref={(node: TextInputInstance | null) => register(name, node)}
      mode="outlined"
      label={label}
      value={value}
      onChangeText={(text) => onChange(name, text)}
      onFocus={() => onFocusField(name)}
      onBlur={() => onBlurField(name)}
      error={invalid}
      disabled={disabled}
      autoComplete="off"
      importantForAutofill="no"
      autoCorrect={false}
      {...extra}
    />
  );
}

function FormBody({
  accounts,
  categories,
  transaction,
  defaultAccountId,
}: Loaded & { defaultAccountId: number | null }) {
  const editing = transaction !== null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<TransactionForm>(() =>
    transaction ? formFromTransaction(transaction) : blankForm("expense", todayIndia(), defaultAccountId),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const inputs = useRef<Record<string, TextInputInstance | null>>({});
  const positions = useRef<Record<string, number>>({});
  const focusedKey = useRef<string | null>(null);
  const needFocus = useRef(false);
  const mounted = useRef(true);

  const type = form.type;
  const busy = saving || deleting || conflict !== null;

  const scrollToField = useCallback((key: string) => {
    const y = positions.current[key];
    if (y === undefined) return;
    // Waits a frame so the viewport has already shrunk for the keyboard.
    setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true }), 60);
  }, []);

  const handleFocus = useCallback(
    (key: string) => {
      focusedKey.current = key;
      scrollToField(key);
    },
    [scrollToField],
  );

  const handleBlur = useCallback((key: string) => {
    if (focusedKey.current === key) focusedKey.current = null;
  }, []);

  const registerInput = useCallback((key: string, node: TextInputInstance | null) => {
    inputs.current[key] = node;
  }, []);

  // The keyboard opens after focus lands, so scroll again once it is up.
  useEffect(() => {
    const subscription = Keyboard.addListener("keyboardDidShow", () => {
      if (focusedKey.current) scrollToField(focusedKey.current);
    });
    return () => subscription.remove();
  }, [scrollToField]);

  // Leaving mid-save would let the later router.back() pop an unrelated screen.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => savingRef.current || deletingRef.current);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      Keyboard.dismiss();
      if (!deletingRef.current) setConfirming(false);
    });
    return () => subscription.remove();
  }, []);

  // After a failed save the inputs are disabled until the response lands, which drops focus.
  // Once they are enabled again, move to the first invalid field, or to the top for a general message.
  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const first = renderedFields(type).find((key) => errors[key]);
    if (first) {
      scrollToField(first);
      inputs.current[first]?.focus();
    } else {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    }
  }, [errors, general, saving, type, scrollToField]);

  const set = useCallback((key: keyof TransactionForm, value: string) => setForm((f) => ({ ...f, [key]: value })), []);

  // Keeps what the types share and resets what only some of them have.
  const changeType = (next: TransactionType) => {
    if (next === type) return;
    setErrors({});
    setGeneral([]);
    setForm((f) => ({ ...f, type: next, category: "", to_account_id: "" }));
  };

  // A transfer can't go from an account to itself, so picking the "to" account as "from" clears it.
  const changeFrom = (accountId: string) =>
    setForm((f) => ({ ...f, account_id: accountId, to_account_id: f.to_account_id === accountId ? "" : f.to_account_id }));

  async function save() {
    if (savingRef.current || deletingRef.current) return;

    let payload: Record<string, unknown>;
    if (transaction) {
      payload = changedPayload(form, transaction);
      if (Object.keys(payload).length === 0) {
        router.back();
        return;
      }
    } else {
      payload = toPayload(form, "create");
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      const auth = { token: token ?? undefined, body: payload };
      const saved = transaction
        ? await apiFetch<Transaction>(`/transactions/${transaction.id}`, { method: "PATCH", ...auth })
        : await apiFetch<Transaction>("/transactions", { method: "POST", ...auth });
      done = true;
      savedMonth.current = saved.date.slice(0, 7);
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        needFocus.current = true;
        setConflict(errorMessage({ detail: err.detail }));
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const result = splitErrors(err.detail, renderedFields(type));
        setErrors(result.fields);
        setGeneral(result.general);
      } else {
        needFocus.current = true;
        setGeneral([errorMessage(err)]);
      }
    } finally {
      // After success the screen is on its way out, so keep a second tap from saving again.
      if (!done) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  async function remove() {
    if (!transaction || deletingRef.current || savingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    let done = false;
    try {
      await apiFetch(`/transactions/${transaction.id}`, { method: "DELETE", token: token ?? undefined });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      setConfirming(false);
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else {
        needFocus.current = true;
        setGeneral([errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      if (!done) {
        deletingRef.current = false;
        setDeleting(false);
      }
    }
  }

  const field = (key: keyof TransactionForm, content: React.ReactNode) => (
    <View
      key={key}
      onLayout={(event) => {
        positions.current[key] = event.nativeEvent.layout.y;
      }}
    >
      {content}
      {errors[key] ? (
        <HelperText type="error" visible>
          {errors[key]}
        </HelperText>
      ) : null}
    </View>
  );

  const input = (key: keyof TransactionForm, label: string, extra: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
    <FieldInput
      name={key}
      label={label}
      value={form[key]}
      invalid={Boolean(errors[key])}
      disabled={busy}
      onChange={set}
      onFocusField={handleFocus}
      onBlurField={handleBlur}
      register={registerInput}
      extra={extra}
    />
  );

  const choice = (label: string, selected: boolean, onPress: () => void, key = label) => (
    <Chip
      key={key}
      selected={selected}
      showSelectedCheck
      disabled={busy}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: busy }}
    >
      {label}
    </Chip>
  );

  const heading = (label: string) => (
    <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
      {label}
    </Text>
  );

  const today = todayIndia();
  const yesterday = previousDay(today);
  const typeLabel = TRANSACTION_TYPES.find((t) => t.value === type)?.label;
  const suggestions = type === "transfer" ? [] : categories[type];

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} disabled={saving || deleting} />
        <Appbar.Content title={editing ? "Edit transaction" : "Add transaction"} />
        {editing ? (
          <Appbar.Action icon="delete-outline" accessibilityLabel="Delete transaction" disabled={busy} onPress={() => setConfirming(true)} />
        ) : null}
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
                Back to transactions
              </Button>
            </View>
          ) : null}
          {general.length > 0 ? (
            <View style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
              {general.map((message) => (
                <Text key={message} variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                  {message}
                </Text>
              ))}
            </View>
          ) : null}

          <View>
            {heading("Type")}
            {editing ? (
              <Text variant="bodyLarge">{typeLabel}</Text>
            ) : (
              <View style={styles.chips}>
                {TRANSACTION_TYPES.map((option) => choice(option.label, type === option.value, () => changeType(option.value)))}
              </View>
            )}
          </View>

          {field("amount", input("amount", "Amount (₹)", { keyboardType: "numeric", maxLength: MONEY_MAX_LENGTH }))}

          {field(
            "date",
            <>
              {input("date", "Date (YYYY-MM-DD)", { maxLength: 10 })}
              <View style={styles.chips}>
                {choice("Today", form.date === today, () => set("date", today))}
                {choice("Yesterday", form.date === yesterday, () => set("date", yesterday))}
              </View>
            </>,
          )}

          {field(
            "account_id",
            <>
              {heading(FROM_LABELS[type])}
              <View style={styles.chips}>
                {accounts.map((a) => choice(a.name, form.account_id === String(a.id), () => changeFrom(String(a.id)), String(a.id)))}
              </View>
            </>,
          )}

          {type === "transfer"
            ? field(
                "to_account_id",
                <>
                  {heading("To account")}
                  <View style={styles.chips}>
                    {accounts
                      .filter((a) => String(a.id) !== form.account_id)
                      .map((a) => choice(a.name, form.to_account_id === String(a.id), () => set("to_account_id", String(a.id)), String(a.id)))}
                  </View>
                </>,
              )
            : field(
                "category",
                <>
                  {input("category", "Category", { maxLength: 40 })}
                  <View style={styles.chips}>
                    {suggestions.map((name) =>
                      choice(name, form.category.trim().toLowerCase() === name.toLowerCase(), () => set("category", name)),
                    )}
                  </View>
                </>,
              )}

          {field("note", input("note", "Note (optional)", { maxLength: 200 }))}

          <Button
            mode="contained"
            onPress={() => void save()}
            loading={saving}
            disabled={busy}
            contentStyle={styles.saveContent}
            style={styles.save}
          >
            {saving ? "Saving..." : editing ? "Save changes" : "Add transaction"}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={confirming} onDismiss={() => (deleting ? undefined : setConfirming(false))}>
          <Dialog.Title>Delete this transaction?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {transaction ? `This ${transaction.type} of ${formatRupees(transaction.amount)} is removed for good, ` : ""}
              and the account balance moves back. This can&apos;t be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirming(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button onPress={() => void remove()} loading={deleting} disabled={deleting}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  banner: { borderRadius: 12, padding: 12, gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  save: { marginTop: 8 },
  saveContent: { height: 48 },
});
