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
import { Appbar, Button, HelperText, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Coin, type CoinPrice, formatCoinPrice } from "@/lib/crypto";
import { DateField } from "@/components/date-field";
import { useSession } from "@/lib/session";
import { formatDate, previousDay, todayIndia } from "@/lib/transactions";

type Key = "price" | "date";
const FIELDS: Key[] = ["price", "date"];

export default function CoinPriceFormScreen() {
  const { coinId } = useLocalSearchParams<{ coinId?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [coin, setCoin] = useState<Coin | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Record<Key, string>>(() => ({ price: "", date: todayIndia() }));
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
    apiFetch<{ coins: Coin[] }>("/investments/coins", { token: token ?? undefined })
      .then((result) => {
        if (!current) return;
        const found = result.coins.find((c) => String(c.id) === coinId);
        if (found) setCoin(found);
        else setLoadError("This coin was not found.");
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
  }, [coinId, token, logOut, attempt]);

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
    if (!coin || savingRef.current) return;
    Keyboard.dismiss();
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      const price = form.price.trim();
      const date = form.date.trim();
      await apiFetch<CoinPrice>(`/investments/coins/${coin.id}/prices`, {
        method: "POST",
        token: token ?? undefined,
        body: { date: date === "" ? null : date, price: price === "" ? null : price },
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

  const title = coin ? `Update price of ${coin.symbol}` : "Update price";
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

      {coin === null ? (
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

            <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
              {coin.price !== null && coin.price_date !== null
                ? `Last recorded ${formatCoinPrice(coin.price)} on ${formatDate(coin.price_date)}.`
                : "No price recorded yet, so holdings are valued at cost."}
            </Text>

            {input("price", "Price per coin (₹)", { keyboardType: "decimal-pad", maxLength: 16, placeholder: "7504827.5", autoFocus: true })}

            <DateField
              label="As of"
              value={form.date}
              onChange={(iso) => setForm((f) => ({ ...f, date: iso }))}
              disabled={busy}
              maxDate={today}
              error={errors.date}
              chips={[
                { label: "Today", value: today },
                { label: "Yesterday", value: yesterday },
              ]}
            />

            <Button
              mode="contained"
              onPress={() => void save()}
              loading={saving}
              disabled={busy}
              contentStyle={styles.saveContent}
              style={styles.save}
            >
              {saving ? "Saving..." : "Save price"}
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
