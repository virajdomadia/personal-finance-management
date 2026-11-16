import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { HelperText, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyButton, ScreenHeader } from "@/components/chunky";
import { DateField } from "@/components/date-field";
import { Banner, Choice } from "@/components/form-parts";
import {
  type Account,
  type AccountList,
  FD_PAYOUTS,
  FD_PAYOUT_LABELS,
  errorMessage,
  formatRupees,
  splitErrors,
} from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type RenewFdForm, renewFdForm, renewFdPayload } from "@/lib/deposits";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { previousDay, savedMonth, todayIndia } from "@/lib/transactions";

const FIELDS = ["amount", "date", "account_id", "reinvest", "interest_rate", "matures_on", "fd_payout", "name"] as const;
const MONEY_MAX_LENGTH = 24;

type TextKey = "amount" | "reinvest" | "interest_rate" | "name";

// Renew FD: the old FD is closed at what the bank paid, that lands in the bank, and the amount to
// renew moves from the bank into a new FD, all in one request. Anything not renewed stays in the bank.
export default function RenewFdScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<RenewFdForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  // The amount to renew follows the amount received until it is edited on its own.
  const reinvestEdited = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Leaving mid-save would let the later router.back() pop an unrelated screen.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => savingRef.current);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let current = true;
    apiFetch<AccountList>("/accounts", { token: token ?? undefined })
      .then((result) => {
        if (!current) return;
        setAccounts(result.accounts);
        const found = result.accounts.find((a) => a.type === "fd" && String(a.id) === id);
        if (found) setForm((existing) => existing ?? renewFdForm(found, todayIndia(), result.accounts));
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return;
        }
        setLoadError(errorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [id, token, logOut, attempt]);

  const fd = accounts?.find((a) => a.type === "fd" && String(a.id) === id) ?? null;
  const banks = (accounts ?? []).filter((a) => a.type === "bank");
  const busy = saving;

  const header = <ScreenHeader title="Renew FD" back backDisabled={saving} />;

  if (accounts === null || fd === null || form === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        {header}
        <View style={styles.center}>
          {loadError === null && accounts === null ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
          ) : loadError !== null ? (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {loadError}
              </Text>
              <ChunkyButton
                label="Try again"
                onPress={() => {
                  setLoadError(null);
                  setAttempt((n) => n + 1);
                }}
              />
            </>
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                This FD was not found. It may already be closed.
              </Text>
              <ChunkyButton label="Back to accounts" onPress={() => router.back()} />
            </>
          )}
        </View>
      </View>
    );
  }

  const set = <K extends keyof RenewFdForm>(key: K, value: RenewFdForm[K]) =>
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, [key]: value };
      if (key === "amount" && !reinvestEdited.current) next.reinvest = value as string;
      return next;
    });
  const today = todayIndia();
  const yesterday = previousDay(today);
  const bankName = banks.find((a) => String(a.id) === form.account_id)?.name ?? "the bank";

  async function save() {
    if (savingRef.current || form === null || fd === null) return;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      await apiFetch(`/accounts/${fd.id}/renew-fd`, {
        method: "POST",
        token: token ?? undefined,
        body: renewFdPayload(form),
      });
      done = true;
      if (/^\d{4}-\d{2}/.test(form.date)) savedMonth.current = form.date.slice(0, 7);
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 422) {
        const result = splitErrors(err.detail, FIELDS);
        setErrors(result.fields);
        setGeneral(result.general);
      } else {
        setGeneral([errorMessage(err)]);
      }
    } finally {
      if (!done) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  const fieldError = (key: (typeof FIELDS)[number]) =>
    errors[key] ? (
      <HelperText type="error" visible>
        {errors[key]}
      </HelperText>
    ) : null;

  const textInput = (
    key: TextKey,
    label: string,
    extra: Partial<React.ComponentProps<typeof TextInput>> = {},
    hint?: string,
  ) => (
    <View>
      <TextInput
        mode="outlined"
        label={label}
        value={form[key]}
        onChangeText={(text) => {
          if (key === "reinvest") reinvestEdited.current = true;
          set(key, text);
        }}
        error={Boolean(errors[key])}
        disabled={busy}
        autoComplete="off"
        importantForAutofill="no"
        autoCorrect={false}
        {...extra}
      />
      {errors[key] ? (
        fieldError(key)
      ) : hint ? (
        <HelperText type="info" visible>
          {hint}
        </HelperText>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {header}
      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          <Banner messages={general} />

          <Text variant="titleMedium">{fd.name}</Text>

          {textInput("amount", "Amount received (₹)", { keyboardType: "numeric", maxLength: MONEY_MAX_LENGTH })}

          <DateField
            label="Date"
            value={form.date}
            onChange={(iso) => set("date", iso)}
            disabled={busy}
            maxDate={today}
            error={errors.date}
            chips={[
              { label: "Today", value: today },
              { label: "Yesterday", value: yesterday },
            ]}
          />

          <View>
            <Text variant="labelLarge" style={{ color: BRAND.zinc600 }}>
              Received in
            </Text>
            <View style={styles.chips}>
              {banks.map((a) => (
                <Choice key={a.id} label={a.name} selected={form.account_id === String(a.id)} disabled={busy} onPress={() => set("account_id", String(a.id))} />
              ))}
            </View>
            {fieldError("account_id")}
          </View>

          <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
            The new FD
          </Text>

          {textInput(
            "reinvest",
            "Amount to renew (₹)",
            { keyboardType: "numeric", maxLength: MONEY_MAX_LENGTH },
            `Anything less than the amount received stays in ${bankName}.`,
          )}

          {textInput("interest_rate", "Interest rate (% a year)", { keyboardType: "numeric", maxLength: MONEY_MAX_LENGTH }, "The yearly rate, for example 7.10.")}

          <DateField
            label="Matures on"
            value={form.matures_on}
            onChange={(iso) => set("matures_on", iso)}
            disabled={busy}
            minDate={form.date || undefined}
            error={errors.matures_on}
            chips={[]}
          />

          <View>
            <Text variant="labelLarge" style={{ color: BRAND.zinc600 }}>
              Interest paid
            </Text>
            <View style={styles.chips}>
              {FD_PAYOUTS.map((payout) => (
                <Choice key={payout} label={FD_PAYOUT_LABELS[payout]} selected={form.fd_payout === payout} disabled={busy} onPress={() => set("fd_payout", payout)} />
              ))}
            </View>
            {fieldError("fd_payout")}
          </View>

          {textInput("name", "New name", { maxLength: 60, placeholder: fd.name }, `Optional. Leave blank to keep "${fd.name}".`)}

          <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
            Balance {formatRupees(fd.balance)}. The difference is recorded as interest, or as a fee if you received
            less. The old FD is archived and the new one starts on the date above.
          </Text>

          <ChunkyButton
            label={saving ? "Renewing..." : "Renew FD"}
            onPress={() => void save()}
            loading={saving}
            style={styles.save}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  heading: { color: BRAND.ink, marginTop: 8 },
  save: { marginTop: 8 },
});
