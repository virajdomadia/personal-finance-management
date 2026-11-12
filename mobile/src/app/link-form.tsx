import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type MarketKind, type MarketMatch, canSearchMarket, linkLabel, marketSearchPath } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const DEBOUNCE_MS = 300;

const KINDS: Record<MarketKind, { path: string; placeholder: string; noMatch: string }> = {
  stock: { path: "stocks", placeholder: "Search NSE stocks, like Infosys", noMatch: "No match. Try the company's full name." },
  mutual_fund: { path: "funds", placeholder: "Search funds, like Parag Parikh", noMatch: "No match. Try the fund's full name." },
  crypto: { path: "coins", placeholder: "Search coins, like Bitcoin", noMatch: "No match. Try the coin's full name." },
};

// The outcome of the search for `text`; it is stale (and the screen says "Searching...") until the
// text it was run for matches what is typed.
type Outcome = { text: string; results: MarketMatch[]; message: string | null };

// A server message for a failed request: field errors, then anything general, joined.
function failureText(err: unknown, field: string): string {
  if (err instanceof ApiError && Array.isArray(err.detail)) {
    const { fields, general } = splitErrors(err.detail, [field]);
    return [fields[field], ...general].filter(Boolean).join(" ");
  }
  return errorMessage(err instanceof ApiError ? { detail: err.detail } : err);
}

// Full-screen search to link a holding (stock, fund or coin) to a market code, or to unlink it.
export default function LinkFormScreen() {
  const params = useLocalSearchParams<{ kind?: string; id?: string; title?: string; code?: string }>();
  const kind: MarketKind | null =
    params.kind === "stock" || params.kind === "mutual_fund" || params.kind === "crypto" ? params.kind : null;
  const id = typeof params.id === "string" && /^\d{1,9}$/.test(params.id) ? params.id : null;
  const linkedCode = params.code ? params.code : null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pick, setPick] = useState<MarketMatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const latest = useRef(0);

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

  // Each keystroke bumps `latest`, so only the newest search may write its answer.
  useEffect(() => {
    const request = ++latest.current;
    if (kind === null || !canSearchMarket(text)) return;
    const timer = setTimeout(() => {
      apiFetch<{ results: MarketMatch[] }>(marketSearchPath(kind, text), { token: token ?? undefined })
        .then((res) => {
          if (request === latest.current) setOutcome({ text, results: res.results, message: null });
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            void logOut();
          } else if (request === latest.current) {
            setOutcome({ text, results: [], message: failureText(err, "q") });
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, kind, token, logOut]);

  async function save(code: string | null) {
    if (kind === null || id === null || savingRef.current) return;
    Keyboard.dismiss();
    savingRef.current = true;
    setSaving(true);
    setError(null);
    let done = false;
    try {
      // Only source_code goes up, so nothing else on the holding can change.
      await apiFetch(`/investments/${KINDS[kind].path}/${id}`, {
        method: "PATCH",
        token: token ?? undefined,
        body: { source_code: code },
      });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else if (err instanceof ApiError && err.status === 404) setMissing(errorMessage({ detail: err.detail }));
      else setError(failureText(err, "source_code"));
    } finally {
      if (!done) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  const choose = (match: MarketMatch) => {
    latest.current++;
    Keyboard.dismiss();
    setText("");
    setOutcome(null);
    setError(null);
    setPick(match);
  };

  if (kind === null || id === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Link to live prices" back />
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            This holding was not found.
          </Text>
          <ChunkyButton label="Go back" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  const title = params.title ? `Link ${params.title}` : "Link to live prices";
  const busy = saving || missing !== null;
  const searching = canSearchMarket(text);
  const current = searching && outcome?.text === text ? outcome : null;
  const results = current?.results ?? [];

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={title} back backDisabled={saving} />
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
          <Banner messages={error ? [error] : []} />

          <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
            {linkedCode && !pick
              ? `${linkLabel(linkedCode)}. Its price updates every night. Pick another match to change it.`
              : "Link it once and its price updates every night."}
          </Text>

          {pick ? (
            <ChunkyBox radius={14} offset={3} style={styles.picked}>
              <View style={styles.pickedText}>
                <Text variant="titleMedium">{linkLabel(pick.code)}</Text>
                <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
                  {pick.name}
                </Text>
              </View>
              <ChunkyButton compact variant="alt" label="Clear" disabled={busy} accessibilityLabel="Clear the chosen match" onPress={() => setPick(null)} />
            </ChunkyBox>
          ) : (
            <>
              <TextInput
                mode="outlined"
                label="Search live prices"
                placeholder={KINDS[kind].placeholder}
                value={text}
                onChangeText={setText}
                disabled={busy}
                autoFocus
                maxLength={60}
                autoCapitalize="none"
                autoComplete="off"
                importantForAutofill="no"
                autoCorrect={false}
                returnKeyType="search"
              />
              <View accessibilityLiveRegion="polite">
                {searching && !current ? (
                  <View style={styles.status}>
                    <ActivityIndicator size="small" color={colors.primary} accessibilityLabel="Searching" />
                    <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
                      Searching...
                    </Text>
                  </View>
                ) : null}
                {current?.message ? (
                  <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: BRAND.loss }}>
                    {current.message}
                  </Text>
                ) : null}
                {current && !current.message && results.length === 0 ? (
                  <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
                    {KINDS[kind].noMatch}
                  </Text>
                ) : null}
              </View>
              {results.map((match) => (
                <Pressable
                  key={match.code}
                  disabled={busy}
                  onPress={() => choose(match)}
                  accessibilityRole="button"
                  accessibilityLabel={`${match.name}, ${match.code}${match.price ? `, ${formatRupees(match.price)}` : ""}`}
                  accessibilityHint="Choose this match"
                >
                  {({ pressed }) => (
                    <ChunkyBox pressed={pressed} radius={14} offset={3} style={styles.match}>
                      <View style={styles.pickedText}>
                        <Text variant="titleSmall">{match.name}</Text>
                        <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
                          {match.code}
                          {match.price ? ` · ${formatRupees(match.price)}` : ""}
                        </Text>
                      </View>
                      <Icon source="chevron-right" size={22} color={BRAND.ink} />
                    </ChunkyBox>
                  )}
                </Pressable>
              ))}
            </>
          )}

          <ChunkyButton
            variant="green"
            label={saving ? "Saving..." : "Link"}
            onPress={() => {
              if (pick) void save(pick.code);
            }}
            loading={saving}
            disabled={!pick || (busy && !saving)}
            style={styles.save}
          />
          {linkedCode ? <ChunkyButton variant="alt" label="Unlink" disabled={busy} onPress={() => void save(null)} /> : null}
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
  banner: { padding: 12, gap: 8 },
  status: { flexDirection: "row", alignItems: "center", gap: 8 },
  picked: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, backgroundColor: BRAND.card },
  pickedText: { flex: 1, minWidth: 0 },
  match: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, backgroundColor: BRAND.card, minHeight: 56 },
  save: { marginTop: 8 },
});
