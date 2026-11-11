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
import { type Account, type AccountList, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type CloseRdForm, closeRdForm, closeRdPayload } from "@/lib/deposits";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { previousDay, savedMonth, todayIndia } from "@/lib/transactions";

const FIELDS = ["amount", "date", "account_id"] as const;

export default function CloseRdScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<CloseRdForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);

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
        const rd = result.accounts.find((a) => a.type === "rd" && String(a.id) === id);
        if (rd) setForm((existing) => existing ?? closeRdForm(rd, todayIndia(), result.accounts));
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

  const rd = accounts?.find((a) => a.type === "rd" && String(a.id) === id) ?? null;
  const banks = (accounts ?? []).filter((a) => a.type === "bank");
  const busy = saving;

  const header = <ScreenHeader title="Close RD" back backDisabled={saving} />;

  if (accounts === null || rd === null || form === null) {
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
                This RD was not found. It may already be closed.
              </Text>
              <ChunkyButton label="Back to accounts" onPress={() => router.back()} />
            </>
          )}
        </View>
      </View>
    );
  }

  const set = (key: keyof CloseRdForm, value: string) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const today = todayIndia();
  const yesterday = previousDay(today);

  async function save() {
    if (savingRef.current || form === null || rd === null) return;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      await apiFetch(`/accounts/${rd.id}/close-rd`, {
        method: "POST",
        token: token ?? undefined,
        body: closeRdPayload(form),
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
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setGeneral([errorMessage(err)]);
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

          <Text variant="titleMedium">{rd.name}</Text>

          <View>
            <TextInput
              mode="outlined"
              label="Amount received (₹)"
              value={form.amount}
              onChangeText={(text) => set("amount", text)}
              error={Boolean(errors.amount)}
              disabled={busy}
              keyboardType="numeric"
              maxLength={24}
              autoComplete="off"
              importantForAutofill="no"
              autoCorrect={false}
            />
            {errors.amount ? (
              <HelperText type="error" visible>
                {errors.amount}
              </HelperText>
            ) : null}
          </View>

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
            {errors.account_id ? (
              <HelperText type="error" visible>
                {errors.account_id}
              </HelperText>
            ) : null}
          </View>

          <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
            Balance {formatRupees(rd.balance)}. The difference is recorded as interest, or as a fee if you received
            less. The RD is then archived.
          </Text>

          <ChunkyButton
            label={saving ? "Closing..." : "Close RD"}
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
  save: { marginTop: 8 },
});
