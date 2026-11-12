import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Icon, Text, TextInput, useTheme } from "react-native-paper";

import { ChunkyBox, ChunkyButton } from "@/components/chunky";
import { errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type MarketKind, type MarketMatch, canSearchMarket, marketSearchPath, selectedLabel } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const DEBOUNCE_MS = 300;

export const MARKET_TEXT: Record<MarketKind, { placeholder: string; noMatch: string }> = {
  stock: { placeholder: "Search NSE stocks, like Infosys", noMatch: "No match. Try the company's full name." },
  mutual_fund: { placeholder: "Search funds, like Parag Parikh", noMatch: "No match. Try the fund's full name." },
  crypto: { placeholder: "Search coins, like Bitcoin", noMatch: "No match. Try the coin's full name." },
};

// The outcome of the search for `text`; it is stale (and the box says "Searching...") until the
// text it was run for matches what is typed.
type Outcome = { text: string; results: MarketMatch[]; message: string | null };

// A server message for a failed search: field errors, then anything general, joined.
function failureText(err: unknown): string {
  if (err instanceof ApiError && Array.isArray(err.detail)) {
    const { fields, general } = splitErrors(err.detail, ["q"]);
    return [fields.q, ...general].filter(Boolean).join(" ");
  }
  return errorMessage(err instanceof ApiError ? { detail: err.detail } : err);
}

// Search the market's codes (NSE stocks, AMFI funds, CoinGecko coins) and pick one. `selected` is the
// pick, shown as a card with a way to clear it; the form around it saves it.
export function MarketSearch({
  kind,
  selected,
  onSelect,
  disabled = false,
  autoFocus = false,
  label = "Search live prices",
}: {
  kind: MarketKind;
  selected: MarketMatch | null;
  onSelect: (match: MarketMatch | null) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  label?: string;
}) {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const latest = useRef(0);

  // Each keystroke bumps `latest`, so only the newest search may write its answer.
  useEffect(() => {
    const request = ++latest.current;
    if (!canSearchMarket(text)) return;
    const timer = setTimeout(() => {
      apiFetch<{ results: MarketMatch[] }>(marketSearchPath(kind, text), { token: token ?? undefined })
        .then((res) => {
          if (request === latest.current) setOutcome({ text, results: res.results, message: null });
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) void logOut();
          else if (request === latest.current) setOutcome({ text, results: [], message: failureText(err) });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, kind, token, logOut]);

  const choose = (match: MarketMatch) => {
    latest.current++;
    setText("");
    setOutcome(null);
    onSelect(match);
  };

  if (selected) {
    return (
      <ChunkyBox radius={14} offset={3} style={styles.picked}>
        <View style={styles.grow}>
          <Text variant="titleMedium">{selectedLabel(selected.name)}</Text>
          <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
            {selected.code}
            {selected.price ? ` · ${formatRupees(selected.price)}` : ""}
          </Text>
        </View>
        <ChunkyButton
          compact
          variant="alt"
          label="Clear"
          disabled={disabled}
          accessibilityLabel="Clear the chosen match"
          onPress={() => onSelect(null)}
        />
      </ChunkyBox>
    );
  }

  const searching = canSearchMarket(text);
  const current = searching && outcome?.text === text ? outcome : null;
  const results = current?.results ?? [];

  return (
    <View style={styles.gap}>
      <TextInput
        mode="outlined"
        label={label}
        placeholder={MARKET_TEXT[kind].placeholder}
        value={text}
        onChangeText={setText}
        disabled={disabled}
        autoFocus={autoFocus}
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
            {MARKET_TEXT[kind].noMatch}
          </Text>
        ) : null}
      </View>
      {results.map((match) => (
        <Pressable
          key={match.code}
          disabled={disabled}
          onPress={() => choose(match)}
          accessibilityRole="button"
          accessibilityLabel={`${match.name}, ${match.code}${match.price ? `, ${formatRupees(match.price)}` : ""}`}
          accessibilityHint="Choose this match"
        >
          {({ pressed }) => (
            <ChunkyBox pressed={pressed} radius={14} offset={3} style={styles.match}>
              <View style={styles.grow}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 12 },
  status: { flexDirection: "row", alignItems: "center", gap: 8 },
  picked: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, backgroundColor: BRAND.card },
  grow: { flex: 1, minWidth: 0 },
  match: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, backgroundColor: BRAND.card, minHeight: 56 },
});
