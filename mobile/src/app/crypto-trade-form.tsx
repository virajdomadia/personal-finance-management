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
import { Button, Dialog, HelperText, List, Portal, Surface, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Account, type AccountList, cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Coin,
  type CoinHolding,
  type CryptoPortfolio,
  type CryptoTrade,
  type CryptoTradeForm,
  type CryptoTradeMode,
  blankCryptoTradeForm,
  changedCryptoTrade,
  cryptoTradeDeleteText,
  cryptoTradeErrors,
  cryptoTradeFormFrom,
  cryptoTradePayload,
  formatCoinQty,
  qtyMismatch,
} from "@/lib/crypto";
import { ChunkyBox, ChunkyButton, Chip, HeaderAction, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { DateField } from "@/components/date-field";
import { BRAND, FONT } from "@/lib/theme";
import { useSession } from "@/lib/session";
import { previousDay, todayIndia } from "@/lib/transactions";

const MODES: { value: CryptoTradeMode; label: string }[] = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "opening", label: "Add existing coins" },
];

const NEW_COIN = "new";
const MONEY_MAX_LENGTH = 24;
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const MISMATCH = "Quantity × price doesn't match the amount. Check the quantity and price.";
// The fields the form shows, in screen order, which is where field errors can be displayed.
const RENDERED = ["coin_id", "name", "symbol", "quantity", "price", "amount", "charges", "date", "account_id", "note"] as const;

type Form = CryptoTradeForm & { name: string; symbol: string };
type Key = Exclude<keyof Form, "mode">;

type Loaded = { coins: Coin[]; holdings: CoinHolding[]; brokers: Account[]; trade: CryptoTrade | null };
type Defaults = { mode: CryptoTradeMode; coinId?: string; accountId?: string };

function parseMode(value: string | undefined): CryptoTradeMode {
  return value === "sell" || value === "opening" ? value : "buy";
}

function titleFor(mode: CryptoTradeMode, editing: boolean): string {
  if (editing) return "Edit crypto transaction";
  return mode === "buy" ? "Buy crypto" : mode === "sell" ? "Sell crypto" : "Add existing coins";
}

export default function CryptoTradeFormScreen() {
  const params = useLocalSearchParams<{ id?: string; mode?: string; coinId?: string; accountId?: string }>();
  const { id, coinId } = params;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const editing = id !== undefined;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    const tradesPath =
      coinId !== undefined ? `/investments/crypto-trades?coin_id=${encodeURIComponent(coinId)}` : "/investments/crypto-trades";
    Promise.all([
      apiFetch<{ coins: Coin[] }>("/investments/coins", auth),
      apiFetch<{ crypto: CryptoPortfolio }>("/investments/portfolio", auth),
      apiFetch<AccountList>("/accounts", auth),
      editing ? apiFetch<{ trades: CryptoTrade[] }>(tradesPath, auth) : Promise.resolve(null),
    ])
      .then(([coins, portfolio, accounts, trades]) => {
        if (!current) return;
        const trade = trades?.trades.find((t) => String(t.id) === id) ?? null;
        if (editing && trade === null) {
          setLoadError("This transaction was not found.");
          return;
        }
        setLoaded({
          coins: coins.coins,
          holdings: portfolio.crypto.holdings,
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
        setLoadError(err instanceof ApiError && err.status === 422 ? "This transaction was not found." : errorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [editing, id, coinId, token, logOut, attempt]);

  const mode = parseMode(params.mode);
  const fallbackTitle = titleFor(mode, editing);

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
          <Text variant="titleMedium">Add a broker or exchange account first</Text>
          <Text variant="bodyMedium" style={[styles.centerText, { color: BRAND.zinc600 }]}>
            Coins are held in a broker account, like CoinDCX, and buys and sells move its cash.
          </Text>
          <ChunkyButton label="Go to accounts" onPress={() => router.navigate("/accounts")} />
        </View>
      </View>
    );
  }

  return <FormBody {...loaded} defaults={{ mode, coinId, accountId: params.accountId }} />;
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

function startForm({ coins, holdings, brokers, trade, defaults }: Loaded & { defaults: Defaults }): Form {
  if (trade) return { ...cryptoTradeFormFrom(trade), name: "", symbol: "" };
  const form: Form = { ...blankCryptoTradeForm(defaults.mode, todayIndia()), name: "", symbol: "" };
  // A sale can only be of a coin held somewhere.
  const coinOk =
    defaults.coinId !== undefined &&
    coins.some((c) => String(c.id) === defaults.coinId) &&
    (defaults.mode !== "sell" || holdings.some((h) => String(h.coin_id) === defaults.coinId));
  if (coinOk) form.coin_id = defaults.coinId ?? "";
  else if (coins.length === 0 && defaults.mode !== "sell") form.coin_id = NEW_COIN;
  const accountId = defaults.accountId ?? (brokers.length === 1 ? String(brokers[0].id) : "");
  if (brokers.some((b) => String(b.id) === accountId)) form.account_id = accountId;
  return form;
}

function FormBody(props: Loaded & { defaults: Defaults }) {
  const { brokers, holdings, trade } = props;
  const editing = trade !== null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<Form>(() => startForm(props));
  const [coins, setCoins] = useState<Coin[]>(props.coins);
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

  const mode = form.mode;
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

  const clearError = (key: string) =>
    setErrors((e) => {
      if (!(key in e)) return e;
      const rest = { ...e };
      delete rest[key];
      return rest;
    });

  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const changeMode = (next: CryptoTradeMode) => {
    if (next === mode) return;
    setErrors({});
    setGeneral([]);
    // A sale can only be of a coin held somewhere, so drop one that isn't (or a new coin).
    const coinId = next === "sell" && !holdings.some((h) => String(h.coin_id) === form.coin_id) ? "" : form.coin_id;
    setForm((f) => ({ ...f, mode: next, coin_id: coinId, ...(next === "opening" ? { charges: "", price: "" } : {}) }));
  };

  const chooseCoin = (value: string) => {
    clearError("coin_id");
    set("coin_id", value);
  };

  async function save() {
    if (savingRef.current || deletingRef.current) return;
    Keyboard.dismiss();

    // Checked before anything is sent, so a new coin isn't created for a transaction bound to be refused.
    const local = cryptoTradeErrors(form, todayIndia());
    if (form.coin_id === NEW_COIN) {
      if (form.name.trim() === "") local.name = "Enter a name.";
      if (form.symbol.trim() === "") local.symbol = "Enter the coin's ticker, like BTC.";
    }
    if (Object.keys(local).length > 0) {
      needFocus.current = true;
      setGeneral([]);
      setErrors(local);
      return;
    }

    let payload: Record<string, unknown> | null = null;
    if (trade) {
      payload = changedCryptoTrade(form, trade);
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
      let current: CryptoTradeForm = form;
      if (!trade && form.coin_id === NEW_COIN) {
        let created: Coin;
        try {
          created = await apiFetch<Coin>("/investments/coins", {
            method: "POST",
            ...auth,
            body: { name: form.name, symbol: form.symbol.trim() },
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 422) {
            needFocus.current = true;
            const result = splitErrors(err.detail, ["name", "symbol"]);
            setErrors(result.fields);
            setGeneral(result.general);
            return;
          }
          throw err;
        }
        // The coin exists now. If the transaction below fails, it stays chosen so a retry doesn't add it twice.
        setCoins((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
        setForm((f) => ({ ...f, coin_id: String(created.id), name: "", symbol: "" }));
        current = { ...form, coin_id: String(created.id) };
      }

      if (trade && payload) {
        await apiFetch<CryptoTrade>(`/investments/crypto-trades/${trade.id}`, { method: "PATCH", ...auth, body: payload });
      } else {
        await apiFetch<CryptoTrade>("/investments/crypto-trades", {
          method: "POST",
          ...auth,
          body: cryptoTradePayload(current, "create"),
        });
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
        // The transaction, coin or account is gone, so this form can't be saved.
        setMissing(errorMessage({ detail: err.detail }));
      } else {
        // A 409 (a later sale left short, say) can be fixed here, so the form stays open.
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
      await apiFetch(`/investments/crypto-trades/${trade.id}`, { method: "DELETE", token: token ?? undefined });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      setConfirming(false);
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 404) {
        // It's already gone, so there is nothing left to edit or delete.
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

  // A sale can only be of a coin held somewhere (or the one being edited).
  const heldIds = new Set(holdings.map((h) => h.coin_id));
  const choosable = coins.filter((c) => mode !== "sell" || heldIds.has(c.id) || c.id === trade?.coin_id);
  const chosen = coins.find((c) => String(c.id) === form.coin_id);
  const canAddCoin = !editing && mode !== "sell";
  const held = holdings.find((h) => String(h.coin_id) === form.coin_id && String(h.account_id) === form.account_id);
  const broker = brokers.find((b) => String(b.id) === form.account_id);
  const amount = cleanMoney(form.amount);
  const amountShown = MONEY.test(amount) && Number(amount) > 0 ? formatRupees(amount) : null;
  const mismatch = !errors.quantity && !errors.price && !errors.amount && qtyMismatch(form);
  const today = todayIndia();
  const yesterday = previousDay(today);
  const title = titleFor(mode, editing);

  // Editing never moves a transaction to another coin.
  const coinPicker =
    form.coin_id === NEW_COIN ? (
      <View style={styles.picked}>
        <Text variant="bodyLarge" style={styles.grow}>
          New coin
        </Text>
        {coins.length > 0 ? (
          <ChunkyButton compact variant="alt" label="Choose another" disabled={busy} onPress={() => chooseCoin("")} />
        ) : null}
      </View>
    ) : chosen ? (
      <View style={styles.picked}>
        <View style={styles.grow}>
          <Text variant="titleMedium">{chosen.name}</Text>
          <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
            {chosen.symbol}
          </Text>
        </View>
        {editing ? null : (
          <ChunkyButton compact variant="alt" label="Change" disabled={busy} accessibilityLabel={`Change coin, ${chosen.name} chosen`} onPress={() => chooseCoin("")} />
        )}
      </View>
    ) : (
      <Surface elevation={0} style={[styles.results, { borderColor: errors.coin_id ? BRAND.loss : BRAND.ink }]}>
        {choosable.map((c) => (
          <List.Item
            key={c.id}
            title={c.name}
            titleNumberOfLines={2}
            description={c.symbol}
            disabled={busy}
            onPress={() => chooseCoin(String(c.id))}
            accessibilityRole="button"
            accessibilityLabel={`Choose ${c.name}`}
          />
        ))}
        {mode === "sell" && choosable.length === 0 ? (
          <Text variant="bodyMedium" style={[styles.more, { color: BRAND.zinc600 }]}>
            You don&apos;t hold any coins to sell.
          </Text>
        ) : null}
        {canAddCoin ? (
          <List.Item
            title="Add a coin"
            left={(p) => <List.Icon {...p} icon="plus" />}
            disabled={busy}
            onPress={() => chooseCoin(NEW_COIN)}
            accessibilityRole="button"
          />
        ) : null}
      </Surface>
    );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={title}
        back
        backDisabled={saving || deleting}
        right={
          editing ? (
            <HeaderAction icon="delete-outline" label="Delete transaction" disabled={busy} onPress={() => setConfirming(true)} />
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

          {editing ? (
            <View>
              {heading("Type")}
              <Text variant="bodyLarge">{MODES.find((m) => m.value === mode)?.label}</Text>
            </View>
          ) : (
            <View>
              {heading("Type")}
              <View style={styles.chips} accessibilityRole="radiogroup">
                {MODES.map((option) => choice(option.label, mode === option.value, () => changeMode(option.value)))}
              </View>
            </View>
          )}

          {field(
            "coin_id",
            <>
              {heading("Coin")}
              <View style={styles.gap}>{coinPicker}</View>
            </>,
          )}

          {form.coin_id === NEW_COIN ? (
            <>
              {field("name", input("name", "Coin name, like Bitcoin", { maxLength: 60 }))}
              {field(
                "symbol",
                input("symbol", "Ticker, like BTC", { maxLength: 20, autoCapitalize: "characters" }),
                <HelperText type="info" visible>
                  The coin&apos;s short code. Prices are typed in by hand.
                </HelperText>,
              )}
            </>
          ) : null}

          {field("quantity", input("quantity", "Quantity", { keyboardType: "decimal-pad", maxLength: 26, placeholder: "0.00014067" }))}

          {mode !== "opening"
            ? field(
                "price",
                input("price", "Price per coin (₹)", { keyboardType: "decimal-pad", maxLength: 16, placeholder: "7504827.5" }),
                mismatch ? (
                  <HelperText type="info" visible accessibilityLiveRegion="polite" style={{ color: colors.tertiary }}>
                    {MISMATCH}
                  </HelperText>
                ) : null,
              )
            : null}

          {field(
            "amount",
            input("amount", mode === "sell" ? "Amount received (₹)" : mode === "opening" ? "Total cost (₹)" : "Amount paid (₹)", {
              keyboardType: "decimal-pad",
              maxLength: MONEY_MAX_LENGTH,
            }),
            <HelperText type="info" visible>
              {mode === "opening"
                ? "What you paid for these coins in all, from your statement."
                : mode === "buy"
                  ? "The total taken from your account, charges included."
                  : "What reached your account, after charges and TDS."}
            </HelperText>,
          )}

          {mode !== "opening"
            ? field(
                "charges",
                input("charges", "Charges (₹, optional)", { keyboardType: "decimal-pad", maxLength: MONEY_MAX_LENGTH }),
                <HelperText type="info" visible>
                  {mode === "buy" ? "Fees and GST, already inside the amount." : "Fees and TDS, taken off before you were paid."}
                </HelperText>,
              )
            : null}

          {field(
            "date",
            <DateField
              label={mode === "opening" ? "Bought around" : "Date"}
              value={form.date}
              onChange={(iso) => set("date", iso)}
              disabled={busy}
              maxDate={today}
              invalid={Boolean(errors.date)}
              chips={[
                { label: "Today", value: today },
                { label: "Yesterday", value: yesterday },
              ]}
            />,
          )}

          {field(
            "account_id",
            <>
              {heading("Broker or exchange account")}
              <View style={styles.chips} accessibilityRole="radiogroup">
                {brokers.map((b) => choice(b.name, form.account_id === String(b.id), () => set("account_id", String(b.id)), String(b.id)))}
              </View>
            </>,
            mode === "sell" && form.coin_id && form.coin_id !== NEW_COIN && form.account_id ? (
              <HelperText type="info" visible accessibilityLiveRegion="polite">
                {held ? `You hold ${formatCoinQty(held.quantity)} ${held.symbol} here.` : "You hold none of this coin here."}
              </HelperText>
            ) : null,
          )}

          {field("note", input("note", "Note (optional)", { maxLength: 200 }))}

          <ChunkyBox radius={14} offset={3} style={[styles.total, { backgroundColor: BRAND.due }]}>
            <Text variant="bodyLarge" accessibilityLiveRegion="polite" style={{ color: BRAND.zinc600 }}>
              {mode === "opening" ? (
                "The account's cash won't change."
              ) : amountShown === null ? (
                mode === "buy" ? (
                  "Enter the amount you paid."
                ) : (
                  "Enter the amount you received."
                )
              ) : (
                <>
                  <Text style={[styles.strong, { color: BRAND.ink }]}>{amountShown}</Text>
                  {mode === "buy" ? " leaves " : " goes into "}
                  {broker ? broker.name : "your account"}.
                </>
              )}
            </Text>
          </ChunkyBox>

          <ChunkyButton
            variant={mode === "sell" ? "pink" : "green"}
            label={saving ? "Saving..." : editing ? "Save changes" : mode === "buy" ? "Buy" : mode === "sell" ? "Sell" : "Add coins"}
            onPress={() => void save()}
            loading={saving}
            disabled={busy && !saving}
            style={styles.save}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={confirming} onDismiss={() => (deleting ? undefined : setConfirming(false))}>
          <Dialog.Title>{trade ? cryptoTradeDeleteText(trade).title : "Delete this transaction?"}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{trade ? cryptoTradeDeleteText(trade).body : ""}</Text>
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
  results: { borderRadius: 14, borderWidth: 2.5, overflow: "hidden" },
  more: { paddingHorizontal: 16, paddingVertical: 8 },
  total: { padding: 12 },
  strong: { fontFamily: FONT.black },
  save: { marginTop: 8 },
});
