import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  View,
  type TextInputInstance,
} from "react-native";
import { Appbar, Button, Dialog, HelperText, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { Coin } from "@/lib/crypto";
import { useSession } from "@/lib/session";

type Key = "name" | "symbol";
const FIELDS: Key[] = ["name", "symbol"];

// Renames a coin, or deletes one that has nothing recorded. Its transactions and prices stay with it.
export default function CoinFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [coin, setCoin] = useState<Coin | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Record<Key, string>>({ name: "", symbol: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [missing, setMissing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const mounted = useRef(true);
  const needFocus = useRef(false);
  const inputs = useRef<Record<string, TextInputInstance | null>>({});

  useEffect(() => {
    let current = true;
    apiFetch<{ coins: Coin[] }>("/investments/coins", { token: token ?? undefined })
      .then((result) => {
        if (!current) return;
        const found = result.coins.find((c) => String(c.id) === id);
        if (found) {
          setCoin(found);
          setForm({ name: found.name, symbol: found.symbol });
        } else {
          setLoadError("This coin was not found.");
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
  }, [id, token, logOut, attempt]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Leaving mid-save would let the later router.back() pop an unrelated screen.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => savingRef.current || deletingRef.current);
    return () => subscription.remove();
  }, []);

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !deletingRef.current) setConfirming(false);
    });
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
    if (!coin || savingRef.current || deletingRef.current) return;
    Keyboard.dismiss();
    const body: Record<string, string> = {};
    if (form.name !== coin.name) body.name = form.name;
    if (form.symbol !== coin.symbol) body.symbol = form.symbol;
    if (Object.keys(body).length === 0) {
      router.back();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      await apiFetch<Coin>(`/investments/coins/${coin.id}`, { method: "PATCH", token: token ?? undefined, body });
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
      } else if (err instanceof ApiError && err.status === 404) {
        setMissing(errorMessage({ detail: err.detail }));
      } else {
        // A 409 is a short name already in use, which can be fixed here.
        setGeneral([errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      if (!done) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  // Only a coin with no transactions or prices can go; otherwise the server's reason is shown.
  async function remove() {
    if (!coin || deletingRef.current || savingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    let done = false;
    try {
      await apiFetch(`/investments/coins/${coin.id}`, { method: "DELETE", token: token ?? undefined });
      done = true;
      // The coin's own screen is behind this one, so go past it.
      if (mounted.current) router.dismissTo("/investments");
    } catch (err) {
      setConfirming(false);
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 404) {
        setMissing(errorMessage({ detail: err.detail }));
      } else {
        setGeneral([errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      if (!done) {
        deletingRef.current = false;
        setDeleting(false);
      }
    }
  }

  const title = coin ? `Edit ${coin.symbol}` : "Edit coin";
  const busy = saving || deleting || missing !== null;

  const input = (key: Key, label: string, extra: Partial<React.ComponentProps<typeof TextInput>>, hint?: string) => (
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
      ) : hint ? (
        <HelperText type="info" visible>
          {hint}
        </HelperText>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} disabled={saving || deleting} />
        <Appbar.Content title={title} />
        {coin ? (
          <Appbar.Action icon="delete-outline" accessibilityLabel="Delete coin" disabled={busy} onPress={() => setConfirming(true)} />
        ) : null}
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

            {input("name", "Coin name", { maxLength: 60 })}
            {input("symbol", "Ticker", { maxLength: 20, autoCapitalize: "characters" }, "The ticker, like BTC.")}

            <Button
              mode="contained"
              onPress={() => void save()}
              loading={saving}
              disabled={busy}
              contentStyle={styles.saveContent}
              style={styles.save}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      <Portal>
        <Dialog visible={confirming} onDismiss={() => (deleting ? undefined : setConfirming(false))}>
          <Dialog.Title>{coin ? `Delete ${coin.name}?` : "Delete this coin?"}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Only a coin with no transactions can be deleted. Its prices are deleted with it. This can&apos;t be undone.
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
  save: { marginTop: 8 },
  saveContent: { height: 48 },
});
