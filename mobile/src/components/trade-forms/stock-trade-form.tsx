import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewInstance,
  type TextInputInstance,
} from "react-native";
import {
  Button,
  Dialog,
  HelperText,
  List,
  Portal,
  Searchbar,
  Surface,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Account, type AccountList, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Holding,
  type Portfolio,
  type Stock,
  type Trade,
  type TradeForm,
  type MarketMatch,
  asFirstTrade,
  blankTradeForm,
  prefillFromMatch,
  changedTrade,
  sideLabel,
  tradeDeleteText,
  tradeErrors,
  tradeFormFrom,
  tradePayload,
  tradeTotal,
  withTradePath,
} from "@/lib/investments";
import { MarketSearch } from "@/components/market-search";
import { ChunkyBox, ChunkyButton, Chip, HeaderAction, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { DateField } from "@/components/date-field";
import { BRAND, FONT } from "@/lib/theme";
import { useSession } from "@/lib/session";
import { previousDay, todayIndia } from "@/lib/transactions";

type Kind = "buy" | "sell" | "opening";

const KINDS: { value: Kind; label: string }[] = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "opening", label: "Add existing shares" },
];

const NEW_STOCK = "new";
const MONEY_MAX_LENGTH = 24;
const MATCHES_SHOWN = 8;
// The fields the form shows, in screen order, which is where field errors can be displayed.
const RENDERED = ["stock_id", "symbol", "name", "account_id", "quantity", "date", "price", "charges", "note"] as const;

type Form = TradeForm & { symbol: string; name: string };
type Key = Exclude<keyof Form, "side" | "opening">;

type Loaded = { stocks: Stock[]; holdings: Holding[]; brokers: Account[]; trade: Trade | null };

export function StockTradeScreen() {
  const params = useLocalSearchParams<{
    id?: string;
    mode?: string;
    side?: string;
    opening?: string;
    stockId?: string;
    accountId?: string;
    new?: string;
  }>();
  const { id, stockId } = params;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const editing = id !== undefined;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    const tradesPath = stockId !== undefined ? `/investments/trades?stock_id=${encodeURIComponent(stockId)}` : "/investments/trades";
    Promise.all([
      apiFetch<{ stocks: Stock[] }>("/investments/stocks", auth),
      apiFetch<Portfolio>("/investments/portfolio", auth),
      apiFetch<AccountList>("/accounts", auth),
      editing ? apiFetch<{ trades: Trade[] }>(tradesPath, auth) : Promise.resolve(null),
    ])
      .then(([stocks, portfolio, accounts, trades]) => {
        if (!current) return;
        const trade = trades?.trades.find((t) => String(t.id) === id) ?? null;
        if (editing && trade === null) {
          setLoadError("This trade was not found.");
          return;
        }
        setLoaded({
          stocks: stocks.stocks,
          holdings: portfolio.holdings,
          // Only active brokers: the accounts list leaves archived ones out.
          brokers: accounts.accounts.filter((a) => a.type === "broker"),
          trade,
        });
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return;
        }
        setLoadError(err instanceof ApiError && err.status === 422 ? "This trade was not found." : errorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [editing, id, stockId, token, logOut, attempt]);

  const kind: Kind =
    params.opening === "1" || params.mode === "opening" ? "opening" : params.side === "sell" || params.mode === "sell" ? "sell" : "buy";
  const fallbackTitle = editing ? "Edit trade" : kind === "opening" ? "Add existing shares" : kind === "buy" ? "Buy shares" : "Sell shares";

  if (loaded === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScreenHeader title={fallbackTitle} back />
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
      </View>
    );
  }

  if (loaded.brokers.length === 0 && !editing) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScreenHeader title={fallbackTitle} back />
        <View style={styles.center}>
          <Text variant="titleMedium">Add a broker account first</Text>
          <Text variant="bodyMedium" style={[styles.centerText, { color: BRAND.zinc600 }]}>
            Shares are held in a broker account, and buys and sells move its cash.
          </Text>
          <ChunkyButton label="Go to accounts" onPress={() => router.navigate("/accounts")} />
        </View>
      </View>
    );
  }

  return (
    <FormBody
      {...loaded}
      kind={kind}
      defaultStockId={stockId}
      defaultAccountId={params.accountId}
      fresh={params.new === "1"}
    />
  );
}

type FieldInputProps = {
  name: Key;
  label: string;
  value: string;
  invalid: boolean;
  disabled: boolean;
  onChange: (name: Key, value: string) => void;
  onFocusField: (name: string) => void;
  onBlurField: (name: string) => void;
  register: (name: string, node: TextInputInstance | null) => void;
  extra: Partial<React.ComponentProps<typeof TextInput>>;
};

// Its own component so the form's refs are only touched from callbacks, never during render.
function FieldInput({ name, label, value, invalid, disabled, onChange, onFocusField, onBlurField, register, extra }: FieldInputProps) {
  return (
    <TextInput
      ref={(node: TextInputInstance | null) => register(name, node)}
      mode="outlined"
      label={label}
      value={value}
      onChangeText={(text) => onChange(name, text)}
      onFocus={() => onFocusField(name)}
      onBlur={() => onBlurField(name)}
      error={invalid}
      disabled={disabled}
      autoComplete="off"
      importantForAutofill="no"
      autoCorrect={false}
      {...extra}
    />
  );
}

function StockSearch({
  value,
  disabled,
  onChange,
  onFocusField,
  onBlurField,
  register,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onFocusField: (name: string) => void;
  onBlurField: (name: string) => void;
  register: (name: string, node: TextInputInstance | null) => void;
}) {
  return (
    <Searchbar
      ref={(node: TextInputInstance | null) => register("stock_id", node)}
      mode="bar"
      placeholder="Search your stocks"
      value={value}
      onChangeText={onChange}
      onFocus={() => onFocusField("stock_id")}
      onBlur={() => onBlurField("stock_id")}
      editable={!disabled}
      autoCorrect={false}
      autoCapitalize="characters"
    />
  );
}

type BodyProps = Loaded & { kind: Kind; defaultStockId?: string; defaultAccountId?: string; fresh?: boolean };

function startForm(props: BodyProps): Form {
  if (props.trade) return { ...tradeFormFrom(props.trade), symbol: "", name: "" };
  const base = blankTradeForm(props.kind === "sell" ? "sell" : "buy", todayIndia(), props.kind === "opening");
  // A sell can only be of a stock held somewhere.
  const stockOk =
    props.defaultStockId !== undefined &&
    props.stocks.some((s) => String(s.id) === props.defaultStockId) &&
    (props.kind !== "sell" || props.holdings.some((h) => String(h.stock_id) === props.defaultStockId));
  const accountId = props.defaultAccountId ?? (props.brokers.length === 1 ? String(props.brokers[0].id) : "");
  return {
    ...base,
    // From Add investment, a new stock is the likely one; an existing one can still be chosen.
    stock_id: stockOk ? (props.defaultStockId ?? "") : props.fresh && props.kind !== "sell" ? NEW_STOCK : "",
    account_id: props.brokers.some((b) => String(b.id) === accountId) ? accountId : "",
    symbol: "",
    name: "",
  };
}

function FormBody(props: BodyProps) {
  const { brokers, holdings, trade } = props;
  const editing = trade !== null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<Form>(() => startForm(props));
  const stocks = props.stocks;
  // A match from the search links live prices and fills in what it knows, unless it was already typed.
  const [source, setSource] = useState<MarketMatch | null>(null);
  const pickSource = (match: MarketMatch | null) => {
    setSource(match);
    if (!match) return;
    const fill = prefillFromMatch("stock", match);
    setForm((f) => ({ ...f, name: f.name.trim() || fill.name, symbol: f.symbol.trim() || fill.symbol }));
  };
  const [search, setSearch] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [missing, setMissing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const inputs = useRef<Record<string, TextInputInstance | null>>({});
  const positions = useRef<Record<string, number>>({});
  const focusedKey = useRef<string | null>(null);
  const needFocus = useRef(false);
  const mounted = useRef(true);

  const kind: Kind = form.opening ? "opening" : form.side;
  const busy = saving || deleting || missing !== null;

  const scrollToField = useCallback((key: string) => {
    const y = positions.current[key];
    if (y === undefined) return;
    // Waits a frame so the viewport has already shrunk for the keyboard.
    setTimeout(() => scrollRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true }), 60);
  }, []);

  const handleFocus = useCallback(
    (key: string) => {
      focusedKey.current = key;
      scrollToField(key);
    },
    [scrollToField],
  );

  const handleBlur = useCallback((key: string) => {
    if (focusedKey.current === key) focusedKey.current = null;
  }, []);

  // The keyboard opens after focus lands, so scroll again once it is up.
  useEffect(() => {
    const subscription = Keyboard.addListener("keyboardDidShow", () => {
      if (focusedKey.current) scrollToField(focusedKey.current);
    });
    return () => subscription.remove();
  }, [scrollToField]);

  // Leaving mid-save would let the later router.back() pop an unrelated screen.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => savingRef.current || deletingRef.current);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      Keyboard.dismiss();
      if (!deletingRef.current) setConfirming(false);
    });
    return () => subscription.remove();
  }, []);

  // After a failed save, move to the first invalid field, or to the top for a general message.
  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const first = RENDERED.find((key) => errors[key]);
    if (first) {
      scrollToField(first);
      inputs.current[first]?.focus();
    } else {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    }
  }, [errors, general, saving, scrollToField]);

  const registerInput = useCallback((key: string, node: TextInputInstance | null) => {
    inputs.current[key] = node;
  }, []);

  const set = useCallback((key: Key, value: string) => setForm((f) => ({ ...f, [key]: value })), []);

  const changeKind = (next: Kind) => {
    if (next === kind) return;
    setErrors({});
    setGeneral([]);
    setForm((f) => ({
      ...f,
      side: next === "sell" ? "sell" : "buy",
      opening: next === "opening",
      // A sell can only be of a stock held somewhere, so drop one that isn't (or a new stock).
      stock_id: next === "sell" && !holdings.some((h) => String(h.stock_id) === f.stock_id) ? "" : f.stock_id,
    }));
  };

  const chooseStock = (value: string) => {
    setSearch("");
    setForm((f) => ({
      ...f,
      stock_id: value,
      // Starts a new stock with what was typed in the search, as its symbol.
      symbol: value === NEW_STOCK && f.symbol === "" ? search.trim().toUpperCase() : f.symbol,
    }));
    setErrors((e) => {
      const rest = { ...e };
      delete rest.stock_id;
      return rest;
    });
  };

  async function save() {
    if (savingRef.current || deletingRef.current) return;
    Keyboard.dismiss();

    // Checked here before anything is sent: tradePayload sends NaN for a quantity that isn't a whole
    // number, and a new stock must not be created for a trade that is bound to be refused.
    const local = tradeErrors(form, todayIndia());
    if (form.stock_id === "") local.stock_id = "Choose a stock.";
    if (Object.keys(local).length > 0) {
      needFocus.current = true;
      setGeneral([]);
      setErrors(local);
      return;
    }

    let payload: Record<string, unknown> | null = null;
    if (trade) {
      payload = changedTrade(form, trade);
      if (Object.keys(payload).length === 0) {
        router.back();
        return;
      }
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    const auth = { token: token ?? undefined };
    try {
      if (!trade && form.stock_id === NEW_STOCK) {
        // The new stock and its first trade are saved together: if the trade is refused, no stock is left behind.
        await apiFetch(withTradePath("stock"), {
          method: "POST",
          ...auth,
          body: {
            stock: { symbol: form.symbol, name: form.name, source_code: source?.code ?? null },
            trade: asFirstTrade(tradePayload(form, "create")),
          },
        });
      } else if (trade && payload) {
        await apiFetch<Trade>(`/investments/trades/${trade.id}`, { method: "PATCH", ...auth, body: payload });
      } else {
        await apiFetch<Trade>("/investments/trades", { method: "POST", ...auth, body: tradePayload(form, "create") });
      }
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const result = splitErrors(err.detail, RENDERED);
        setErrors(result.fields);
        setGeneral(result.general);
      } else if (err instanceof ApiError && err.status === 404) {
        // The trade, stock or account is gone, so this form can't be saved.
        setMissing(errorMessage({ detail: err.detail }));
      } else {
        // A 409 (an archived broker, or a later sale left short) can be fixed here, so the form stays open.
        needFocus.current = true;
        setGeneral([errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      // After success the screen is on its way out, so keep a second tap from saving again.
      if (!done) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  async function remove() {
    if (!trade || deletingRef.current || savingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    let done = false;
    try {
      await apiFetch(`/investments/trades/${trade.id}`, { method: "DELETE", token: token ?? undefined });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      setConfirming(false);
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 404) {
        // The trade is already gone, so there is nothing left to edit or delete.
        setMissing(errorMessage({ detail: err.detail }));
      } else {
        needFocus.current = true;
        setGeneral([errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      if (!done) {
        deletingRef.current = false;
        setDeleting(false);
      }
    }
  }

  const field = (key: Key, content: React.ReactNode, hint?: React.ReactNode) => (
    <View
      key={key}
      onLayout={(event) => {
        positions.current[key] = event.nativeEvent.layout.y;
      }}
    >
      {content}
      {errors[key] ? (
        <HelperText type="error" visible>
          {errors[key]}
        </HelperText>
      ) : (
        hint
      )}
    </View>
  );

  const input = (key: Key, label: string, extra: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
    <FieldInput
      name={key}
      label={label}
      value={form[key]}
      invalid={Boolean(errors[key])}
      disabled={busy}
      onChange={set}
      onFocusField={handleFocus}
      onBlurField={handleBlur}
      register={registerInput}
      extra={extra}
    />
  );

  const choice = (label: string, selected: boolean, onPress: () => void, key = label) => (
    <Chip key={key} label={label} selected={selected} disabled={busy} onPress={onPress} accessibilityRole="radio" />
  );

  const heading = (label: string) => (
    <Text variant="labelLarge" style={{ color: BRAND.zinc600 }}>
      {label}
    </Text>
  );

  // A sell can only be of a stock held somewhere (or the one being edited).
  const heldIds = new Set(holdings.map((h) => h.stock_id));
  const choosable = stocks.filter((s) => kind !== "sell" || heldIds.has(s.id) || s.id === trade?.stock_id);
  const query = search.trim().toLowerCase();
  const matches = query
    ? choosable.filter((s) => s.symbol.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
    : choosable;
  const chosen = stocks.find((s) => String(s.id) === form.stock_id);
  const canAddStock = !editing && kind !== "sell";
  const held = holdings.find((h) => String(h.stock_id) === form.stock_id && String(h.account_id) === form.account_id);
  const total = tradeTotal(form);
  const today = todayIndia();
  const yesterday = previousDay(today);
  const title = editing ? "Edit trade" : kind === "opening" ? "Add existing shares" : kind === "buy" ? "Buy shares" : "Sell shares";

  const stockPicker =
    form.stock_id === NEW_STOCK ? (
      <View style={styles.picked}>
        <Text variant="bodyLarge" style={styles.grow}>
          New stock
        </Text>
        <ChunkyButton compact variant="alt" label="Choose another" disabled={busy} onPress={() => chooseStock("")} />
      </View>
    ) : chosen ? (
      <View style={styles.picked}>
        <View style={styles.grow}>
          <Text variant="titleMedium">{chosen.symbol}</Text>
          <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
            {chosen.name}
          </Text>
        </View>
        {editing ? null : (
          <ChunkyButton compact variant="alt" label="Change" disabled={busy} accessibilityLabel={`Change stock, ${chosen.symbol} chosen`} onPress={() => chooseStock("")} />
        )}
      </View>
    ) : (
      <View style={styles.search}>
        {choosable.length > 0 ? (
          <StockSearch
            value={search}
            disabled={busy}
            onChange={setSearch}
            onFocusField={handleFocus}
            onBlurField={handleBlur}
            register={registerInput}
          />
        ) : null}
        <Surface elevation={0} style={[styles.results, { borderColor: errors.stock_id ? BRAND.loss : BRAND.ink }]}>
          {matches.slice(0, MATCHES_SHOWN).map((s) => (
            <List.Item
              key={s.id}
              title={s.symbol}
              description={s.name}
              disabled={busy}
              onPress={() => chooseStock(String(s.id))}
              accessibilityRole="button"
              accessibilityLabel={`Choose ${s.symbol}, ${s.name}`}
            />
          ))}
          {matches.length > MATCHES_SHOWN ? (
            <Text variant="bodySmall" style={[styles.more, { color: BRAND.zinc600 }]}>
              {matches.length - MATCHES_SHOWN} more. Type to narrow the list.
            </Text>
          ) : null}
          {query && matches.length === 0 ? (
            <Text variant="bodySmall" style={[styles.more, { color: BRAND.zinc600 }]}>
              No stock matches “{search.trim()}”.
            </Text>
          ) : null}
          {kind === "sell" && choosable.length === 0 ? (
            <Text variant="bodyMedium" style={[styles.more, { color: BRAND.zinc600 }]}>
              You don&apos;t hold any shares to sell.
            </Text>
          ) : null}
          {canAddStock ? (
            <List.Item
              title="Add a stock"
              description={query ? `Starts with ${search.trim().toUpperCase()} as its symbol` : undefined}
              left={(p) => <List.Icon {...p} icon="plus" />}
              disabled={busy}
              onPress={() => chooseStock(NEW_STOCK)}
              accessibilityRole="button"
            />
          ) : null}
        </Surface>
      </View>
    );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={title}
        back
        backDisabled={saving || deleting}
        right={
          editing ? (
            <HeaderAction icon="delete-outline" label="Delete trade" disabled={busy} onPress={() => setConfirming(true)} />
          ) : undefined
        }
      />

      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
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

          <View>
            {heading("Type")}
            {editing ? (
              <Text variant="bodyLarge">{sideLabel(form)}</Text>
            ) : (
              <View style={styles.chips} accessibilityRole="radiogroup">
                {KINDS.filter((option) => !props.fresh || option.value !== "sell").map((option) => choice(option.label, kind === option.value, () => changeKind(option.value)))}
              </View>
            )}
          </View>

          {field(
            "stock_id",
            <>
              {heading("Stock")}
              <View style={styles.gap}>{stockPicker}</View>
            </>,
          )}

          {form.stock_id === NEW_STOCK ? (
            <>
              <MarketSearch
                kind="stock"
                label="Find it to link live prices (optional)"
                selected={source}
                onSelect={pickSource}
                disabled={busy}
              />
              {field("symbol", input("symbol", "Symbol, like INFY", { maxLength: 20, autoCapitalize: "characters" }))}
              {field("name", input("name", "Company name", { maxLength: 60 }))}
            </>
          ) : null}

          {field(
            "account_id",
            <>
              {heading("Broker account")}
              <View style={styles.chips} accessibilityRole="radiogroup">
                {brokers.map((b) => choice(b.name, form.account_id === String(b.id), () => set("account_id", String(b.id)), String(b.id)))}
              </View>
            </>,
            kind === "sell" && form.stock_id && form.stock_id !== NEW_STOCK && form.account_id ? (
              <HelperText type="info" visible accessibilityLiveRegion="polite">
                {held ? `You hold ${held.shares} here.` : "You hold none of this stock here."}
              </HelperText>
            ) : null,
          )}

          {field("quantity", input("quantity", "Shares", { keyboardType: "number-pad", maxLength: 9 }))}

          {field(
            "date",
            <>
              <DateField
                label={kind === "opening" ? "Bought around" : "Date"}
                value={form.date}
                onChange={(iso) => set("date", iso)}
                disabled={busy}
                maxDate={today}
                invalid={Boolean(errors.date)}
                chips={[
                  { label: "Today", value: today },
                  { label: "Yesterday", value: yesterday },
                ]}
              />
            </>,
          )}

          {field(
            "price",
            input("price", kind === "opening" ? "Average buy price (₹)" : "Price per share (₹)", {
              keyboardType: "decimal-pad",
              maxLength: MONEY_MAX_LENGTH,
            }),
          )}

          {field(
            "charges",
            input("charges", "Charges (₹, optional)", { keyboardType: "decimal-pad", maxLength: MONEY_MAX_LENGTH }),
            <HelperText type="info" visible>
              Brokerage, taxes and fees together.
            </HelperText>,
          )}

          {field("note", input("note", "Note (optional)", { maxLength: 200 }))}

          <ChunkyBox radius={14} offset={3} style={[styles.total, { backgroundColor: BRAND.due }]}>
            <Text variant="bodyLarge" accessibilityLiveRegion="polite" style={{ color: BRAND.zinc600 }}>
              {kind === "opening" ? (
                <>
                  {total !== null && !total.startsWith("-") ? (
                    <Text style={styles.strong}>Cost {formatRupees(total)}. </Text>
                  ) : null}
                  Your broker&apos;s cash won&apos;t change.
                </>
              ) : total === null ? (
                "Enter shares and price to see the total."
              ) : total.startsWith("-") ? (
                "The charges are more than the sale value."
              ) : (
                <>
                  {kind === "buy" ? "You pay " : "You receive "}
                  <Text style={[styles.strong, { color: BRAND.ink }]}>{formatRupees(total)}</Text>
                  {kind === "buy" ? " from your broker's cash." : " into your broker's cash."}
                </>
              )}
            </Text>
          </ChunkyBox>

          <ChunkyButton
            variant={kind === "sell" ? "pink" : "green"}
            label={saving ? "Saving..." : editing ? "Save changes" : kind === "opening" ? "Add shares" : kind === "buy" ? "Buy" : "Sell"}
            onPress={() => void save()}
            loading={saving}
            disabled={busy && !saving}
            style={styles.save}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={confirming} onDismiss={() => (deleting ? undefined : setConfirming(false))}>
          <Dialog.Title>{trade ? tradeDeleteText(trade).title : "Delete this trade?"}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{trade ? tradeDeleteText(trade).body : ""}</Text>
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  gap: { marginTop: 8 },
  picked: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  search: { gap: 8 },
  results: { borderRadius: 14, borderWidth: 2.5, overflow: "hidden" },
  more: { paddingHorizontal: 16, paddingVertical: 8 },
  total: { padding: 12 },
  strong: { fontFamily: FONT.black },
  save: { marginTop: 8 },
});
