import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { HelperText, RadioButton, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { Banner, LoadingScreen, useBlockBack } from "@/components/form-parts";
import { type AccountList, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { formatCoinQty } from "@/lib/crypto";
import { formatUnits } from "@/lib/funds";
import type { GoalDetail } from "@/lib/goals";
import type { Portfolio } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

// An option's value is "i:<instrument id>" or "a:<account id>".
type Option = { value: string; title: string; detail: string };
type Group = { label: string; options: Option[] };
type Loaded = { goal: GoalDetail; groups: Group[] };

const taken = (rows: { in_goal?: unknown }[]) => rows.some((r) => r.in_goal);

// The stocks, funds and coins held now, and the active PPFs and RDs, leaving out anything already in a
// goal: a holding belongs to one active goal at most.
function holdingGroups(portfolio: Portfolio, accounts: AccountList): Group[] {
  const stocks = portfolio.by_stock
    .filter((s) => !taken(portfolio.holdings.filter((h) => h.stock_id === s.stock_id)))
    .map((s) => ({
      value: `i:${s.stock_id}`,
      title: s.symbol,
      detail: `${s.shares} ${s.shares === 1 ? "share" : "shares"} · ${formatRupees(s.value)}`,
    }));
  const funds = portfolio.funds.by_fund
    .filter((f) => !taken(portfolio.funds.holdings.filter((h) => h.fund_id === f.fund_id)))
    .map((f) => ({ value: `i:${f.fund_id}`, title: f.name, detail: `${formatUnits(f.units)} units · ${formatRupees(f.value)}` }));
  const coins = portfolio.crypto.by_coin
    .filter((c) => !taken(portfolio.crypto.holdings.filter((h) => h.coin_id === c.coin_id)))
    .map((c) => ({
      value: `i:${c.coin_id}`,
      title: c.name,
      detail: `${formatCoinQty(c.quantity)} ${c.symbol} · ${formatRupees(c.value)}`,
    }));
  const deposits = accounts.accounts
    .filter((a) => (a.type === "ppf" || a.type === "rd") && !a.in_goal)
    .map((a) => ({
      value: `a:${a.id}`,
      title: a.name,
      detail: `${a.type === "ppf" ? "PPF" : "RD"} · ${formatRupees(a.balance)}`,
    }));
  return [
    { label: "Stocks", options: stocks },
    { label: "Mutual funds", options: funds },
    { label: "Crypto", options: coins },
    { label: "PPF and RD", options: deposits },
  ].filter((g) => g.options.length > 0);
}

export default function GoalHoldingFormScreen() {
  const { goalId } = useLocalSearchParams<{ goalId: string }>();
  const { token, logOut } = useSession();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    Promise.all([
      apiFetch<GoalDetail>(`/goals/${goalId}`, auth),
      apiFetch<Portfolio>("/investments/portfolio", auth),
      apiFetch<AccountList>("/accounts", auth),
    ])
      .then(([goal, portfolio, accounts]) => {
        if (!current) return;
        if (goal.archived) setLoadError("Restore this goal first.");
        else setLoaded({ goal, groups: holdingGroups(portfolio, accounts) });
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return;
        }
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? "This goal was not found."
            : errorMessage(err instanceof ApiError ? { detail: err.detail } : err),
        );
      });
    return () => {
      current = false;
    };
  }, [goalId, token, logOut, attempt]);

  if (loaded === null) {
    return (
      <LoadingScreen
        title="Add holding"
        error={loadError}
        onRetry={() => {
          setLoadError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  return <FormBody {...loaded} />;
}

function FormBody({ goal, groups }: Loaded) {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [general, setGeneral] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const busy = saving || conflict !== null;

  useBlockBack(useCallback(() => savingRef.current, []));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function save() {
    if (savingRef.current) return;
    if (choice === "") {
      setError("Choose a fund, stock, coin, PPF or RD.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setGeneral([]);
    const [kind, id] = choice.split(":");
    const body = kind === "a" ? { account_id: Number(id) } : { instrument_id: Number(id) };
    let done = false;
    try {
      await apiFetch(`/goals/${goal.id}/holdings`, { method: "POST", token: token ?? undefined, body });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setConflict(errorMessage({ detail: err.detail }));
        scrollRef.current?.scrollTo({ y: 0, animated: true });
      } else if (err instanceof ApiError && err.status === 422) {
        // Both fields are this one picker.
        const { fields, general: rest } = splitErrors(err.detail, ["instrument_id", "account_id"]);
        setError(fields.instrument_id ?? fields.account_id ?? null);
        setGeneral(rest);
      } else {
        setGeneral([errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
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
      <ScreenHeader title="Add holding" back backDisabled={saving} />

      <ScrollView ref={scrollRef} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {conflict !== null ? (
          <ChunkyBox radius={14} offset={3} style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
            <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
              {conflict}
            </Text>
            <ChunkyButton label="Go back" onPress={() => router.back()} />
          </ChunkyBox>
        ) : null}
        <Banner messages={general} />

        <Text variant="titleMedium">{goal.name}</Text>
        <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
          The whole holding counts toward the goal at its current value, as your portfolio shows it. It can be in one goal at a
          time.
        </Text>

        {groups.length === 0 ? (
          <View style={styles.empty}>
            <Text variant="titleMedium">Nothing left to add</Text>
            <Text variant="bodyMedium" style={[styles.centerText, { color: BRAND.zinc600 }]}>
              Everything you hold is already in a goal, or you don&apos;t hold any stocks, funds, coins, PPF or RD yet.
            </Text>
          </View>
        ) : (
          <RadioButton.Group
            value={choice}
            onValueChange={(value) => {
              setChoice(value);
              setError(null);
            }}
          >
            {groups.map((group) => (
              <View key={group.label} style={styles.group}>
                <Text variant="titleSmall" accessibilityRole="header" style={{ color: BRAND.ink }}>
                  {group.label.toUpperCase()}
                </Text>
                {group.options.map((o) => (
                  <ChunkyBox
                    key={o.value}
                    radius={14}
                    offset={3}
                    style={choice === o.value ? { backgroundColor: BRAND.yellow } : undefined}
                  >
                    <RadioButton.Item
                      value={o.value}
                      label={`${o.title}
${o.detail}`}
                      accessibilityLabel={`${o.title}, ${o.detail}`}
                      disabled={busy}
                      mode="android"
                      labelVariant="bodyLarge"
                      style={styles.option}
                    />
                  </ChunkyBox>
                ))}
              </View>
            ))}
          </RadioButton.Group>
        )}
        {error ? (
          <HelperText type="error" visible>
            {error}
          </HelperText>
        ) : null}

        <ChunkyButton
          variant="green"
          label={saving ? "Adding..." : "Add to goal"}
          onPress={() => void save()}
          loading={saving}
          disabled={busy && !saving || groups.length === 0}
          style={styles.save}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  banner: { padding: 12, gap: 8 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 24 },
  group: { gap: 8, marginBottom: 8 },
  option: { paddingHorizontal: 4, borderRadius: 12 },
  save: { marginTop: 8 },
});
