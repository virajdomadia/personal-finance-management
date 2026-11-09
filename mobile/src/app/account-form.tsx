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
import { Appbar, Button, Checkbox, Chip, Dialog, HelperText, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Account,
  type AccountForm,
  type AccountList,
  type AccountType,
  TYPE_LABELS,
  TYPE_ORDER,
  changedPayload,
  countError,
  dayError,
  errorMessage,
  formFromAccount,
  renderedFields,
  splitErrors,
  toPayload,
} from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";

const BANK_KINDS = [
  { value: "savings", label: "Savings" },
  { value: "salary", label: "Salary" },
  { value: "current", label: "Current" },
];

const INSTITUTION_LABELS: Record<AccountType, string> = {
  bank: "Bank name",
  credit_card: "Card issuer",
  cash: "",
  broker: "Broker name",
  wallet: "Provider",
  ppf: "Bank or post office",
  rd: "Bank name",
  loan: "Lender",
};

const CASH_NAME = "Cash in hand";
const MONEY_MAX_LENGTH = 24;

function blankForm(type: AccountType): AccountForm {
  return {
    type,
    name: type === "cash" ? CASH_NAME : "",
    balance: "",
    institution: "",
    bank_kind: type === "bank" ? "savings" : "",
    last4: "",
    credit_limit: "",
    statement_day: "",
    due_day: "",
    interest_rate: "",
    emi_amount: "",
    emis_left: "",
    pay_from_id: "",
    opened_on: "",
    deposit_amount: "",
    tenure_months: "",
    deposits_paid: "",
    moved_from_card: "",
  };
}

// Finds the account to edit in the list, because the API has no single-account route.
export default function AccountFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const editing = id !== undefined;
  const [account, setAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "failed">(editing ? "loading" : "ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!editing) return;
    let current = true;
    apiFetch<AccountList>("/accounts", { token: token ?? undefined })
      .then((result) => {
        if (!current) return;
        const found = result.accounts.find((a) => String(a.id) === id);
        setAccount(found ?? null);
        setAccounts(result.accounts);
        setStatus(found ? "ready" : "missing");
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return;
        }
        setLoadError(errorMessage(err));
        setStatus("failed");
      });
    return () => {
      current = false;
    };
  }, [editing, id, token, logOut, attempt]);

  if (status !== "ready") {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title="Edit account" />
        </Appbar.Header>
        <View style={styles.center}>
          {status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading account" />
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {status === "missing" ? "This account was not found. It may have been archived." : loadError}
              </Text>
              {status === "failed" ? (
                <Button mode="contained" onPress={() => {
                    setStatus("loading");
                    setAttempt((n) => n + 1);
                  }}>
                  Try again
                </Button>
              ) : (
                <Button mode="contained" onPress={() => router.back()}>
                  Back to accounts
                </Button>
              )}
            </>
          )}
        </View>
      </View>
    );
  }

  return <FormBody account={editing ? account : null} loadedAccounts={editing ? accounts : null} />;
}

type FieldInputProps = {
  name: string;
  label: string;
  value: string;
  invalid: boolean;
  disabled: boolean;
  onChange: (name: keyof AccountForm, value: string) => void;
  onFocusField: (name: string) => void;
  onBlurField: (name: string) => void;
  register: (name: string, node: TextInputInstance | null) => void;
  extra: Partial<React.ComponentProps<typeof TextInput>>;
};

function FieldInput({
  name,
  label,
  value,
  invalid,
  disabled,
  onChange,
  onFocusField,
  onBlurField,
  register,
  extra,
}: FieldInputProps) {
  return (
    <TextInput
      ref={(node: TextInputInstance | null) => register(name, node)}
      mode="outlined"
      label={label}
      value={value}
      onChangeText={(text) => onChange(name as keyof AccountForm, text)}
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

function FormBody({ account, loadedAccounts }: { account: Account | null; loadedAccounts: Account[] | null }) {
  const editing = account !== null;
  const { token, logOut } = useSession();
  // The active accounts a loan can be paid from. Adding loads them here; if that fails, the loan
  // can still be saved without one.
  const [accounts, setAccounts] = useState<Account[]>(loadedAccounts ?? []);
  useEffect(() => {
    if (loadedAccounts !== null) return;
    let current = true;
    apiFetch<AccountList>("/accounts", { token: token ?? undefined })
      .then((result) => {
        if (current) setAccounts(result.accounts);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [loadedAccounts, token]);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<AccountForm>(() => (account ? formFromAccount(account) : blankForm("bank")));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const savingRef = useRef(false);
  const archivingRef = useRef(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const inputs = useRef<Record<string, TextInputInstance | null>>({});
  const positions = useRef<Record<string, number>>({});
  const focusedKey = useRef<string | null>(null);
  const needFocus = useRef(false);
  const mounted = useRef(true);

  const type = form.type;
  const busy = saving || archiving || conflict !== null;

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

  // The keyboard opens after focus lands, so scroll again once it is up.
  useEffect(() => {
    const subscription = Keyboard.addListener("keyboardDidShow", () => {
      if (focusedKey.current) scrollToField(focusedKey.current);
    });
    return () => subscription.remove();
  }, [scrollToField]);

  // Leaving mid-save would let the later router.back() pop an unrelated screen.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => savingRef.current || archivingRef.current);
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
      if (!archivingRef.current) setConfirming(false);
    });
    return () => subscription.remove();
  }, []);

  // After a failed save the inputs are disabled until the response lands, which drops focus.
  // Once they are enabled again, move to the first invalid field, or to the top for a general message.
  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const first = renderedFields(type, editing ? "edit" : "create").find((key) => errors[key]);
    if (first) {
      scrollToField(first);
      inputs.current[first]?.focus();
    } else {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    }
  }, [errors, general, saving, type, editing, scrollToField]);

  const set = (key: keyof AccountForm, value: string) => setForm((f) => ({ ...f, [key]: value }));

  // Keeps what the types share (name and balance) and resets the type-specific fields.
  const changeType = (next: AccountType) => {
    if (next === type) return;
    setErrors({});
    setGeneral([]);
    setForm((f) => {
      const blank = blankForm(next);
      const name = f.name === CASH_NAME || f.name === "" ? blank.name : f.name;
      return { ...blank, name, balance: f.balance };
    });
  };

  async function save() {
    if (savingRef.current || archivingRef.current) return;

    const local: Record<string, string> = {};
    if (type === "credit_card") {
      for (const key of ["statement_day", "due_day"] as const) {
        const message = dayError(form[key]);
        if (message) local[key] = message;
      }
    }
    if (type === "loan") {
      const dueProblem = dayError(form.due_day);
      if (dueProblem) local.due_day = dueProblem;
      const count = countError(form.emis_left);
      if (count) local.emis_left = count;
    }
    if (Object.keys(local).length > 0) {
      needFocus.current = true;
      setErrors(local);
      setGeneral([]);
      return;
    }

    let payload: Record<string, unknown>;
    if (account) {
      payload = changedPayload(form, account);
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
      if (account) {
        await apiFetch(`/accounts/${account.id}`, { method: "PATCH", token: token ?? undefined, body: payload });
      } else {
        await apiFetch("/accounts", { method: "POST", token: token ?? undefined, body: payload });
      }
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 409) {
        needFocus.current = true;
        setConflict(errorMessage({ detail: err.detail }));
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const result = splitErrors(err.detail, renderedFields(type, editing ? "edit" : "create"));
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

  async function archive() {
    if (!account || archivingRef.current || savingRef.current) return;
    archivingRef.current = true;
    setArchiving(true);
    let done = false;
    try {
      await apiFetch(`/accounts/${account.id}/archive`, { method: "POST", token: token ?? undefined });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      setConfirming(false);
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else {
        needFocus.current = true;
        setGeneral([errorMessage(err)]);
      }
    } finally {
      if (!done) {
        archivingRef.current = false;
        setArchiving(false);
      }
    }
  }

  const hint = (key: keyof AccountForm): string | undefined => {
    if (key === "balance" && editing) return "Changing this corrects the balance. Your transactions stay as they are.";
    if (key === "balance" && type === "credit_card") return "Enter what you owe as a positive amount.";
    if (key === "balance" && type === "loan") return "The principal still to repay, as your lender shows it.";
    if (key === "emis_left") return "Goes down as you record EMIs.";
    if (key === "interest_rate") return "Optional. Used to suggest each EMI's interest.";
    if (key === "pay_from_id") return "For a loan on a credit card, choose the card. Its available credit leaves out what the loan still owes.";
    if (key === "last4") return "Only the last 4 digits. Never enter the full number.";
    if (key === "statement_day" || key === "due_day") return "1 to 31";
    return undefined;
  };

  const field = (key: keyof AccountForm, content: React.ReactNode) => (
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
      ) : hint(key) ? (
        <HelperText type="info" visible>
          {hint(key)}
        </HelperText>
      ) : null}
    </View>
  );

  const registerInput = useCallback((key: string, node: TextInputInstance | null) => {
    inputs.current[key] = node;
  }, []);

  const input = (
    key: keyof AccountForm,
    label: string,
    extra: Partial<React.ComponentProps<typeof TextInput>> = {},
  ) =>
    field(
      key,
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
      />,
    );

  const money = (key: "balance" | "credit_limit" | "emi_amount" | "interest_rate", label: string) =>
    input(key, label, { keyboardType: "numeric", maxLength: MONEY_MAX_LENGTH });

  const day = (key: "statement_day" | "due_day", label: string) =>
    input(key, label, { keyboardType: "number-pad", maxLength: 2 });

  const payFrom = accounts.filter((a) => a.type !== "loan" && a.id !== account?.id);
  // Kept when the linked account was archived after the loan was set up, so the choice still shows.
  if (account?.pay_from_id != null && !payFrom.some((a) => a.id === account.pay_from_id)) {
    payFrom.push({ ...account, id: account.pay_from_id, name: "Archived account" });
  }
  const payFromCard = accounts.find((a) => String(a.id) === form.pay_from_id && a.type === "credit_card");

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} disabled={saving || archiving} />
        <Appbar.Content title={editing ? "Edit account" : "Add account"} />
        {editing ? (
          <Appbar.Action
            icon="format-list-bulleted"
            accessibilityLabel="Transactions for this account"
            disabled={busy}
            onPress={() =>
              router.push({
                pathname: "/account-transactions",
                params: { id: String(account.id), name: account.name },
              })
            }
          />
        ) : null}
        {editing ? (
          <Appbar.Action
            icon="archive-outline"
            accessibilityLabel="Archive account"
            disabled={busy}
            onPress={() => setConfirming(true)}
          />
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
                Back to accounts
              </Button>
            </View>
          ) : null}
          {general.length > 0 ? (
            <View style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
              {general.map((message) => (
                <Text
                  key={message}
                  variant="bodyMedium"
                  accessibilityRole="alert"
                  style={{ color: colors.onErrorContainer }}
                >
                  {message}
                </Text>
              ))}
            </View>
          ) : null}

          {editing ? (
            <View>
              <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
                Type
              </Text>
              <Text variant="bodyLarge">{TYPE_LABELS[type]}</Text>
            </View>
          ) : (
            field(
              "type",
              <View>
              <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
                Type
              </Text>
              <View style={styles.chips}>
                {TYPE_ORDER.map((option) => (
                  <Chip
                    key={option}
                    selected={type === option}
                    showSelectedCheck
                    disabled={busy}
                    onPress={() => changeType(option)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: type === option, disabled: busy }}
                  >
                    {TYPE_LABELS[option]}
                  </Chip>
                ))}
              </View>
              </View>,
            )
          )}

          {input("name", "Name", { maxLength: 60 })}
          {money("balance", type === "credit_card" ? "Amount owed (₹)" : type === "loan" ? "Outstanding (₹)" : "Balance (₹)")}

          {type !== "cash" ? input("institution", INSTITUTION_LABELS[type], { maxLength: 60 }) : null}

          {type === "bank"
            ? field(
                "bank_kind",
                <View>
                  <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
                    Kind
                  </Text>
                  <View style={styles.chips}>
                    {BANK_KINDS.map((kind) => (
                      <Chip
                        key={kind.value}
                        selected={form.bank_kind === kind.value}
                        showSelectedCheck
                        disabled={busy}
                        onPress={() => set("bank_kind", kind.value)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: form.bank_kind === kind.value, disabled: busy }}
                      >
                        {kind.label}
                      </Chip>
                    ))}
                  </View>
                </View>,
              )
            : null}

          {type === "bank" || type === "credit_card"
            ? input("last4", "Last 4 digits", { keyboardType: "number-pad", maxLength: 4 })
            : null}

          {type === "credit_card" ? (
            <>
              {money("credit_limit", "Credit limit (₹)")}
              {day("statement_day", "Statement day")}
              {day("due_day", "Due day")}
            </>
          ) : null}

          {type === "loan" ? (
            <>
              {money("emi_amount", "EMI (₹)")}
              {input("emis_left", "EMIs left", { keyboardType: "number-pad", maxLength: 3 })}
              {day("due_day", "EMI day")}
              {money("interest_rate", "Interest rate (% a year)")}
              {field(
                "pay_from_id",
                <View>
                  <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
                    EMIs paid from
                  </Text>
                  <View style={styles.chips}>
                    {[{ id: "", name: "Not linked" }, ...payFrom.map((a) => ({ id: String(a.id), name: a.name }))].map((option) => (
                      <Chip
                        key={option.id || "none"}
                        selected={form.pay_from_id === option.id}
                        showSelectedCheck
                        disabled={busy}
                        onPress={() => setForm((f) => ({ ...f, pay_from_id: option.id, moved_from_card: "" }))}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: form.pay_from_id === option.id, disabled: busy }}
                      >
                        {option.name}
                      </Chip>
                    ))}
                  </View>
                </View>,
              )}
              {!editing && payFromCard
                ? field(
                    "moved_from_card",
                    <Checkbox.Item
                      mode="android"
                      position="leading"
                      disabled={busy}
                      status={form.moved_from_card === "yes" ? "checked" : "unchecked"}
                      onPress={() => set("moved_from_card", form.moved_from_card === "yes" ? "" : "yes")}
                      label={`This amount is already in ${payFromCard.name}'s balance. Move it from the card to this loan, so it isn't counted twice.`}
                      labelVariant="bodyMedium"
                      labelStyle={styles.checkLabel}
                      style={styles.check}
                    />,
                  )
                : null}
            </>
          ) : null}

          <Button
            mode="contained"
            onPress={() => void save()}
            loading={saving}
            disabled={busy}
            contentStyle={styles.saveContent}
            style={styles.save}
          >
            {saving ? "Saving..." : editing ? "Save changes" : "Add account"}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={confirming} onDismiss={() => (archiving ? undefined : setConfirming(false))}>
          <Dialog.Title>Archive this account?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              It leaves your list and totals. Nothing is lost, and you can restore it from Archived accounts.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirming(false)} disabled={archiving}>
              Cancel
            </Button>
            <Button onPress={() => void archive()} loading={archiving} disabled={archiving}>
              Archive
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
  content: { padding: 16, gap: 4 },
  banner: { borderRadius: 12, padding: 12, gap: 8, marginBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8, marginBottom: 8 },
  save: { marginTop: 16 },
  saveContent: { height: 48 },
  check: { paddingHorizontal: 0 },
  checkLabel: { textAlign: "left" },
});
