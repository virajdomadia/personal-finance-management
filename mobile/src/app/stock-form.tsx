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
import { HelperText, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { Stock } from "@/lib/investments";
import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { useSession } from "@/lib/session";

type Key = "symbol" | "name";
const FIELDS: Key[] = ["symbol", "name"];

// Renames a stock: fixes its symbol or company name. Its trades and prices stay with it.
export default function StockFormScreen() {
  const { stockId } = useLocalSearchParams<{ stockId?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [stock, setStock] = useState<Stock | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Record<Key, string>>({ symbol: "", name: "" });
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
    apiFetch<{ stocks: Stock[] }>("/investments/stocks", { token: token ?? undefined })
      .then((result) => {
        if (!current) return;
        const found = result.stocks.find((s) => String(s.id) === stockId);
        if (found) {
          setStock(found);
          setForm({ symbol: found.symbol, name: found.name });
        } else {
          setLoadError("This stock was not found.");
        }
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
  }, [stockId, token, logOut, attempt]);

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
    if (!stock || savingRef.current) return;
    Keyboard.dismiss();
    if (form.symbol === stock.symbol && form.name === stock.name) {
      router.back();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      await apiFetch<Stock>(`/investments/stocks/${stock.id}`, {
        method: "PATCH",
        token: token ?? undefined,
        body: { symbol: form.symbol, name: form.name },
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

  const title = stock ? `Rename ${stock.symbol}` : "Rename stock";
  const busy = saving || missing !== null;

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
      <ScreenHeader title={title} back backDisabled={saving} />

      {stock === null ? (
        <View style={styles.center}>
          {loadError === null ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {loadError}
              </Text>
              <ChunkyButton label="Try again" onPress={() => {
                  setLoadError(null);
                  setAttempt((n) => n + 1);
                }} />
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
              <ChunkyBox radius={14} offset={3} style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
                <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                  {missing}
                </Text>
                <ChunkyButton label="Go back" onPress={() => router.back()} />
              </ChunkyBox>
            ) : null}
            <Banner messages={general} />

            {input("symbol", "Symbol, like INFY", { maxLength: 20, autoCapitalize: "characters" })}
            {input("name", "Company name", { maxLength: 60 })}

            <ChunkyButton
            variant="green"
            label={saving ? "Saving..." : "Save"}
            onPress={() => void save()}
            loading={saving}
            disabled={busy && !saving}
            style={styles.save}
          />
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
  banner: { padding: 12, gap: 8 },
  save: { marginTop: 8 },
});
