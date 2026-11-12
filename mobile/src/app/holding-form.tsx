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
import { Button, Dialog, HelperText, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, HeaderAction, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { MarketSearch } from "@/components/market-search";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type MarketKind, type MarketMatch, linkLabel } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

type Key = "name" | "symbol";

// A stock, fund or coin as this screen needs it.
type Holding = { id: number; symbol: string; name: string; source_code: string | null };

type Kind = {
  path: string; // under /investments
  list: "stocks" | "funds" | "coins";
  noun: string;
  fields: { key: Key; label: string; hint?: string; characters?: boolean }[];
  // Only a fund or coin with nothing recorded can be deleted here. A stock is deleted from its own screen.
  deleteText: string | null;
};

const KINDS: Record<MarketKind, Kind> = {
  stock: {
    path: "stocks",
    list: "stocks",
    noun: "stock",
    fields: [
      { key: "symbol", label: "Symbol", characters: true },
      { key: "name", label: "Company name" },
    ],
    deleteText: null,
  },
  mutual_fund: {
    path: "funds",
    list: "funds",
    noun: "fund",
    fields: [
      { key: "name", label: "Fund name" },
      { key: "symbol", label: "Short name", hint: "Shown where space is short.", characters: true },
    ],
    deleteText: "Only a fund with no transactions, NAVs or SIPs can be deleted. This can't be undone.",
  },
  crypto: {
    path: "coins",
    list: "coins",
    noun: "coin",
    fields: [
      { key: "name", label: "Coin name" },
      { key: "symbol", label: "Ticker", hint: "The ticker, like BTC.", characters: true },
    ],
    deleteText: "Only a coin with no transactions can be deleted. Its prices are deleted with it. This can't be undone.",
  },
};

const FIELDS: string[] = ["name", "symbol"];

// One place to change a stock, fund or coin: its name and symbol, its link to live prices (or
// unlinking it), and for a fund or coin with nothing recorded, deleting it. Its trades stay with it.
// Params: kind (stock | mutual_fund | crypto), id, and focus=link to open at the price search.
export default function HoldingFormScreen() {
  const params = useLocalSearchParams<{ kind?: string; id?: string; focus?: string }>();
  const kindName: MarketKind = params.kind === "mutual_fund" || params.kind === "crypto" ? params.kind : "stock";
  const kind = KINDS[kindName];
  const linkFirst = params.focus === "link";
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [holding, setHolding] = useState<Holding | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Record<Key, string>>({ name: "", symbol: "" });
  const [pick, setPick] = useState<MarketMatch | null>(null);
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
    apiFetch<Record<string, Holding[]>>(`/investments/${kind.path}`, { token: token ?? undefined })
      .then((result) => {
        if (!current) return;
        const found = (result[kind.list] ?? []).find((h) => String(h.id) === params.id);
        if (found) {
          setHolding(found);
          setForm({ name: found.name, symbol: found.symbol });
        } else {
          setLoadError(`This ${kind.noun} was not found.`);
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
  }, [kind, params.id, token, logOut, attempt]);

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
    const first = kind.fields.map((f) => f.key).find((key) => errors[key]);
    if (first) inputs.current[first]?.focus();
  }, [errors, saving, kind]);

  // Sends only what changed, so a stale screen can't undo a change made elsewhere. `link` is the
  // code to link to, null to unlink, or undefined to leave the link alone.
  async function save(link?: string | null) {
    if (!holding || savingRef.current || deletingRef.current) return;
    Keyboard.dismiss();
    const body: Record<string, string | null> = {};
    if (form.name !== holding.name) body.name = form.name;
    if (form.symbol !== holding.symbol) body.symbol = form.symbol;
    if (link !== undefined) body.source_code = link;
    else if (pick && pick.code !== holding.source_code) body.source_code = pick.code;
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
      await apiFetch(`/investments/${kind.path}/${holding.id}`, { method: "PATCH", token: token ?? undefined, body });
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
        // A 409 is a symbol already in use, which can be fixed here.
        setGeneral([errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      if (!done) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  // Only a fund or coin with nothing recorded can go; otherwise the server's reason is shown.
  async function remove() {
    if (!holding || deletingRef.current || savingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    let done = false;
    try {
      await apiFetch(`/investments/${kind.path}/${holding.id}`, { method: "DELETE", token: token ?? undefined });
      done = true;
      // The holding's own screen is behind this one, so go past it.
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

  const title = holding ? `${linkFirst ? "Link" : "Edit"} ${holding.symbol}` : `Edit ${kind.noun}`;
  const busy = saving || deleting || missing !== null;

  const input = (field: Kind["fields"][number]) => (
    <View key={field.key}>
      <TextInput
        ref={(node: TextInputInstance | null) => {
          inputs.current[field.key] = node;
        }}
        mode="outlined"
        label={field.label}
        value={form[field.key]}
        onChangeText={(text) => setForm((f) => ({ ...f, [field.key]: text }))}
        error={Boolean(errors[field.key])}
        disabled={busy}
        autoComplete="off"
        importantForAutofill="no"
        autoCorrect={false}
        maxLength={field.key === "name" ? 60 : 20}
        autoCapitalize={field.characters ? "characters" : "sentences"}
      />
      {errors[field.key] ? (
        <HelperText type="error" visible>
          {errors[field.key]}
        </HelperText>
      ) : field.hint ? (
        <HelperText type="info" visible>
          {field.hint}
        </HelperText>
      ) : null}
    </View>
  );

  const linkSection = holding ? (
    <View style={styles.section}>
      <Text variant="labelLarge" style={{ color: BRAND.zinc600 }}>
        Live prices
      </Text>
      <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
        {holding.source_code && !pick
          ? `${linkLabel(holding.source_code)}. Its price updates every night. Pick another match to change it.`
          : "Link it once and its price updates every night."}
      </Text>
      <MarketSearch kind={kindName} selected={pick} onSelect={setPick} disabled={busy} autoFocus={linkFirst} />
      {holding.source_code ? (
        <ChunkyButton variant="alt" label="Unlink" disabled={busy} onPress={() => void save(null)} />
      ) : null}
    </View>
  ) : null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={title}
        back
        backDisabled={saving || deleting}
        right={
          holding && kind.deleteText ? (
            <HeaderAction icon="delete-outline" label={`Delete ${kind.noun}`} disabled={busy} onPress={() => setConfirming(true)} />
          ) : undefined
        }
      />

      {holding === null ? (
        <View style={styles.center}>
          {loadError === null ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
          ) : (
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
          )}
        </View>
      ) : (
        <KeyboardAvoidingView style={styles.screen} behavior="padding">
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
            {missing !== null ? (
              <ChunkyBox radius={14} offset={3} style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
                <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                  {missing}
                </Text>
                <ChunkyButton label="Go back" onPress={() => router.back()} />
              </ChunkyBox>
            ) : null}
            <Banner messages={general} />

            {linkFirst ? linkSection : null}
            {kind.fields.map(input)}
            {linkFirst ? null : linkSection}

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

      <Portal>
        <Dialog visible={confirming} onDismiss={() => (deleting ? undefined : setConfirming(false))}>
          <Dialog.Title>{holding ? `Delete ${holding.name}?` : `Delete this ${kind.noun}?`}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{kind.deleteText}</Text>
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
  banner: { padding: 12, gap: 8 },
  section: { gap: 12, marginTop: 8 },
  save: { marginTop: 8 },
});
