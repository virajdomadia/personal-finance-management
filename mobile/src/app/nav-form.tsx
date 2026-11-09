import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  View,
  type TextInputInstance,
} from "react-native";
import { Appbar, Button, Chip, HelperText, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Fund, type Nav, formatNav } from "@/lib/funds";
import { useSession } from "@/lib/session";
import { formatDate, previousDay, todayIndia } from "@/lib/transactions";

type Key = "nav" | "date";
const FIELDS: Key[] = ["nav", "date"];

// Update NAV: the fund's value is its units at the latest NAV. Purchases and redemptions record their own.
export default function NavFormScreen() {
  const { fundId } = useLocalSearchParams<{ fundId?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [fund, setFund] = useState<Fund | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Record<Key, string>>(() => ({ nav: "", date: todayIndia() }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [missing, setMissing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const needFocus = useRef(false);
  const inputs = useRef<Record<string, TextInputInstance | null>>({});

  useEffect(() => {
    let current = true;
    apiFetch<{ funds: Fund[] }>("/investments/funds", { token: token ?? undefined })
      .then((result) => {
        if (!current) return;
        const found = result.funds.find((f) => String(f.id) === fundId);
        if (found) setFund(found);
        else setLoadError("This fund was not found.");
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
  }, [fundId, token, logOut, attempt]);

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

  // After a failed save, focus the first invalid field.
  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const first = FIELDS.find((key) => errors[key]);
    if (first) inputs.current[first]?.focus();
  }, [errors, saving]);

  async function save() {
    if (!fund || savingRef.current) return;
    Keyboard.dismiss();
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      const nav = form.nav.trim();
      const date = form.date.trim();
      await apiFetch<Nav>(`/investments/funds/${fund.id}/navs`, {
        method: "POST",
        token: token ?? undefined,
        body: { date: date === "" ? null : date, nav: nav === "" ? null : nav },
      });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const result = splitErrors(err.detail, FIELDS);
        setErrors(result.fields);
        setGeneral(result.general);
      } else if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        setMissing(errorMessage({ detail: err.detail }));
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

  const title = fund ? `Update NAV of ${fund.symbol}` : "Update NAV";
  const busy = saving || missing !== null;
  const today = todayIndia();
  const yesterday = previousDay(today);

  const input = (key: Key, label: string, extra: Partial<React.ComponentProps<typeof TextInput>>) => (
    <View>
      <TextInput
        ref={(node: TextInputInstance | null) => {
          inputs.current[key] = node;
        }}
        mode="outlined"
        label={label}
        value={form[key]}
        onChangeText={(text) => setForm((f) => ({ ...f, [key]: text }))}
        error={Boolean(errors[key])}
        disabled={busy}
        autoComplete="off"
        importantForAutofill="no"
        autoCorrect={false}
        {...extra}
      />
      {errors[key] ? (
        <HelperText type="error" visible>
          {errors[key]}
        </HelperText>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} disabled={saving} />
        <Appbar.Content title={title} />
      </Appbar.Header>

      {fund === null ? (
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
      ) : (
        <KeyboardAvoidingView style={styles.screen} behavior="padding">
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
          >
            {missing !== null ? (
              <View style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
                <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                  {missing}
                </Text>
                <Button mode="contained" onPress={() => router.back()}>
                  Go back
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

            <Text variant="titleMedium">{fund.name}</Text>
            <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
              {fund.nav !== null && fund.nav_date !== null
                ? `Last recorded ${formatNav(fund.nav)} on ${formatDate(fund.nav_date)}.`
                : "No NAV recorded yet, so holdings are valued at cost."}
            </Text>

            {input("nav", "NAV (₹)", { keyboardType: "decimal-pad", maxLength: 16, placeholder: "84.3793", autoFocus: true })}

            <View>
              {input("date", "As of (YYYY-MM-DD)", { maxLength: 10 })}
              <View style={styles.chips}>
                {[
                  ["Today", today],
                  ["Yesterday", yesterday],
                ].map(([label, value]) => (
                  <Chip
                    key={label}
                    selected={form.date === value}
                    showSelectedCheck
                    disabled={busy}
                    onPress={() => setForm((f) => ({ ...f, date: value }))}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: form.date === value, disabled: busy }}
                  >
                    {label}
                  </Chip>
                ))}
              </View>
            </View>

            <Button
              mode="contained"
              onPress={() => void save()}
              loading={saving}
              disabled={busy}
              contentStyle={styles.saveContent}
              style={styles.save}
            >
              {saving ? "Saving..." : "Save NAV"}
            </Button>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
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
