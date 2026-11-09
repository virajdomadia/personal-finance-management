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
import { Appbar, Button, Chip, Dialog, HelperText, List, Portal, Surface, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Account, type AccountList, cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Fund,
  type FundHolding,
  type FundTrade,
  type FundTradeForm,
  type FundTradeMode,
  type Sip,
  blankFundTradeForm,
  changedFundTrade,
  formatUnits,
  fundTradeDeleteText,
  fundTradeErrors,
  fundTradeFormFrom,
  fundTradePayload,
  sipTradeForm,
  stampDuty,
  suggestedUnits,
  unitsMismatch,
} from "@/lib/funds";
import { realDate } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { previousDay, todayIndia } from "@/lib/transactions";

const MODES: { value: FundTradeMode; label: string }[] = [
  { value: "sip", label: "Record SIP" },
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Redeem" },
  { value: "opening", label: "Add existing units" },
];

const NEW_FUND = "new";
const MONEY_MAX_LENGTH = 24;
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const MISMATCH = "Units × NAV doesn't match the amount. Check the units and NAV.";
// The fields the form shows, in screen order, which is where field errors can be displayed.
const RENDERED = [
  "fund_id",
  "name",
  "symbol",
  "sip_id",
  "nav",
  "units",
  "amount",
  "charges",
  "date",
  "account_id",
  "note",
] as const;

type Form = FundTradeForm & { name: string; symbol: string };
type Key = Exclude<keyof Form, "mode">;

type Loaded = { funds: Fund[]; holdings: FundHolding[]; banks: Account[]; sips: Sip[]; trade: FundTrade | null };
type Defaults = { mode: FundTradeMode; fundId?: string; sipId?: string; date?: string; accountId?: string };

function parseMode(value: string | undefined): FundTradeMode {
  return value === "sip" || value === "sell" || value === "opening" ? value : "buy";
}

function titleFor(mode: FundTradeMode, editing: boolean): string {
  if (editing) return "Edit fund transaction";
  return mode === "sip" ? "Record SIP" : mode === "buy" ? "Buy fund units" : mode === "sell" ? "Redeem units" : "Add existing units";
}

export default function FundTradeFormScreen() {
  const params = useLocalSearchParams<{
    id?: string;
    mode?: string;
    fundId?: string;
    sipId?: string;
    date?: string;
    accountId?: string;
  }>();
  const { id, fundId } = params;
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
      fundId !== undefined ? `/investments/fund-trades?fund_id=${encodeURIComponent(fundId)}` : "/investments/fund-trades";
    Promise.all([
      apiFetch<{ funds: Fund[] }>("/investments/funds", auth),
      apiFetch<{ funds: { holdings: FundHolding[] } }>("/investments/portfolio", auth),
      apiFetch<AccountList>("/accounts", auth),
      apiFetch<{ sips: Sip[] }>("/investments/sips", auth),
      editing ? apiFetch<{ trades: FundTrade[] }>(tradesPath, auth) : Promise.resolve(null),
    ])
      .then(([funds, portfolio, accounts, sips, trades]) => {
        if (!current) return;
        const trade = trades?.trades.find((t) => String(t.id) === id) ?? null;
        if (editing && trade === null) {
          setLoadError("This transaction was not found.");
          return;
        }
        setLoaded({
          funds: funds.funds,
          holdings: portfolio.funds.holdings,
          // Only active banks pay for funds: the accounts list leaves archived ones out.
          banks: accounts.accounts.filter((a) => a.type === "bank"),
          sips: sips.sips,
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
  }, [editing, id, fundId, token, logOut, attempt]);

  const mode = parseMode(params.mode);
  const fallbackTitle = titleFor(mode, editing);

  if (loaded === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title={fallbackTitle} />
        </Appbar.Header>
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
      </View>
    );
  }

  if (loaded.banks.length === 0 && !editing) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title={fallbackTitle} />
        </Appbar.Header>
        <View style={styles.center}>
          <Text variant="titleMedium">Add a bank account first</Text>
          <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
            Mutual funds are bought from a bank account, and redemptions are paid back into one.
          </Text>
          <Button mode="contained" onPress={() => router.navigate("/accounts")}>
            Go to accounts
          </Button>
        </View>
      </View>
    );
  }

  return (
    <FormBody
      {...loaded}
      defaults={{ mode, fundId, sipId: params.sipId, date: params.date, accountId: params.accountId }}
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

// The fund's one active SIP, if it has exactly one.
function onlySip(sips: Sip[], fundId: string): Sip | null {
  const active = sips.filter((s) => String(s.fund_id) === fundId && s.active);
  return active.length === 1 ? active[0] : null;
}

// Choosing a SIP brings its bank account, amount and stamp duty, and its oldest due date.
function sipFields(sip: Sip, banks: Account[]): Partial<Form> {
  const fields = sipTradeForm(sip, sip.due_date ?? todayIndia());
  return {
    sip_id: fields.sip_id,
    account_id: banks.some((b) => String(b.id) === fields.account_id) ? fields.account_id : "",
    amount: fields.amount,
    charges: fields.charges,
    date: fields.date,
  };
}

function isPurchase(mode: FundTradeMode): boolean {
  return mode === "buy" || mode === "sip";
}

// Stamp duty and units follow the amount and NAV, until the owner types them by hand.
function withSuggestions(form: Form, unitsByHand: boolean, chargesByHand: boolean): Form {
  if (!isPurchase(form.mode)) return form;
  const next = { ...form };
  if (!chargesByHand) next.charges = stampDuty(next.amount) ?? "";
  if (!unitsByHand) next.units = suggestedUnits(next.amount, next.charges, next.nav) ?? "";
  return next;
}

function startForm({ funds, holdings, banks, sips, trade, defaults }: Loaded & { defaults: Defaults }): Form {
  if (trade) return { ...fundTradeFormFrom(trade), name: "", symbol: "" };
  const today = todayIndia();
  const bankOk = (accountId: string) => banks.some((b) => String(b.id) === accountId);

  // From a due-SIP card: everything but the NAV is filled in, for the month asked for.
  const sip = defaults.mode === "sip" ? sips.find((s) => String(s.id) === defaults.sipId) : undefined;
  if (sip) {
    const date =
      defaults.date !== undefined && realDate(defaults.date) && defaults.date <= today ? defaults.date : (sip.due_date ?? today);
    const form = sipTradeForm(sip, date);
    return { ...form, account_id: bankOk(form.account_id) ? form.account_id : "", name: "", symbol: "" };
  }

  let form: Form = { ...blankFundTradeForm(defaults.mode, today), name: "", symbol: "" };
  // A redemption can only be of a fund held somewhere.
  const fundOk =
    defaults.fundId !== undefined &&
    funds.some((f) => String(f.id) === defaults.fundId) &&
    (defaults.mode !== "sell" || holdings.some((h) => String(h.fund_id) === defaults.fundId));
  if (fundOk) form.fund_id = defaults.fundId ?? "";
  else if (funds.length === 0 && defaults.mode !== "sell") form.fund_id = NEW_FUND;
  const accountId = defaults.accountId ?? (banks.length === 1 ? String(banks[0].id) : "");
  if (bankOk(accountId)) form.account_id = accountId;
  if (form.mode === "sip") {
    const only = onlySip(sips, form.fund_id);
    if (only) form = { ...form, ...sipFields(only, banks) };
  }
  return withSuggestions(form, false, false);
}

function FormBody(props: Loaded & { defaults: Defaults }) {
  const { banks, holdings, sips, trade } = props;
  const editing = trade !== null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<Form>(() => startForm(props));
  const [funds, setFunds] = useState<Fund[]>(props.funds);
  // Units and stamp duty follow the amount and NAV until the owner types them by hand.
  const [unitsByHand, setUnitsByHand] = useState(editing);
  const [chargesByHand, setChargesByHand] = useState(editing);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [missing, setMissing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Opened from a due SIP, the NAV is the only thing left to type, so it gets the keyboard at once.
  const [focusNav] = useState(() => !editing && form.mode === "sip" && form.sip_id !== "");
  const savingRef = useRef(false);
  const deletingRef = useRef(false);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const inputs = useRef<Record<string, TextInputInstance | null>>({});
  const positions = useRef<Record<string, number>>({});
  const focusedKey = useRef<string | null>(null);
  const needFocus = useRef(false);
  const mounted = useRef(true);

  const mode = form.mode;
  const purchase = isPurchase(mode);
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

  // Applies a change, then works out stamp duty and units again where they aren't typed by hand.
  const update = (change: Partial<Form>, hand: { units?: boolean; charges?: boolean } = {}) => {
    const unitsHand = hand.units ?? unitsByHand;
    const chargesHand = hand.charges ?? chargesByHand;
    setForm((f) => withSuggestions({ ...f, ...change }, unitsHand, chargesHand));
  };

  const set = (key: Key, value: string) => {
    if (key === "units") {
      setUnitsByHand(true);
      update({ units: value }, { units: true });
    } else if (key === "charges") {
      setChargesByHand(true);
      update({ charges: value }, { charges: true });
    } else {
      update({ [key]: value });
    }
  };

  const changeMode = (next: FundTradeMode) => {
    if (next === mode) return;
    setErrors({});
    setGeneral([]);
    // A redemption can only be of a fund held somewhere, so drop one that isn't (or a new fund).
    const fundId = next === "sell" && !holdings.some((h) => String(h.fund_id) === form.fund_id) ? "" : form.fund_id;
    const change: Partial<Form> = { mode: next, fund_id: fundId, sip_id: next === "sip" ? form.sip_id : "" };
    if (!isPurchase(next)) {
      // Worked-out units and stamp duty belong to a purchase. What was typed by hand stays.
      if (!unitsByHand) change.units = "";
      if (!chargesByHand || next === "opening") change.charges = "";
    }
    const only = next === "sip" && form.sip_id === "" ? onlySip(sips, fundId) : null;
    if (only) {
      setChargesByHand(false);
      update({ ...change, ...sipFields(only, banks) }, { charges: false });
    } else {
      update(change);
    }
  };

  const chooseFund = (value: string) => {
    clearError("fund_id");
    const only = mode === "sip" ? onlySip(sips, value) : null;
    if (only) {
      setChargesByHand(false);
      update({ fund_id: value, ...sipFields(only, banks) }, { charges: false });
    } else {
      update({ fund_id: value, sip_id: "" });
    }
  };

  const chooseSip = (sip: Sip) => {
    clearError("sip_id");
    // Editing keeps what was recorded; only the link changes.
    if (editing) {
      update({ sip_id: String(sip.id) });
      return;
    }
    setChargesByHand(false);
    update(sipFields(sip, banks), { charges: false });
  };

  async function save() {
    if (savingRef.current || deletingRef.current) return;
    Keyboard.dismiss();

    // Checked before anything is sent, so a new fund isn't created for a transaction bound to be refused.
    const local = fundTradeErrors(form, todayIndia());
    if (form.fund_id === NEW_FUND && form.name.trim() === "") local.name = "Enter a name.";
    if (mode === "sip" && form.sip_id === "" && fundSips.length > 0) local.sip_id = "Choose the SIP this instalment is for.";
    if (Object.keys(local).length > 0) {
      needFocus.current = true;
      setGeneral([]);
      setErrors(local);
      return;
    }

    let payload: Record<string, unknown> | null = null;
    if (trade) {
      payload = changedFundTrade(form, trade);
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
      let current: FundTradeForm = form;
      if (!trade && form.fund_id === NEW_FUND) {
        let created: Fund;
        try {
          const symbol = form.symbol.trim();
          created = await apiFetch<Fund>("/investments/funds", {
            method: "POST",
            ...auth,
            body: { name: form.name, symbol: symbol === "" ? null : symbol },
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
        // The fund exists now. If the transaction below fails, it stays chosen so a retry doesn't add it twice.
        setFunds((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
        setForm((f) => ({ ...f, fund_id: String(created.id), name: "", symbol: "" }));
        current = { ...form, fund_id: String(created.id) };
      }

      if (trade && payload) {
        await apiFetch<FundTrade>(`/investments/fund-trades/${trade.id}`, { method: "PATCH", ...auth, body: payload });
      } else {
        await apiFetch<FundTrade>("/investments/fund-trades", {
          method: "POST",
          ...auth,
          body: fundTradePayload(current, "create"),
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
        // The transaction, fund or account is gone, so this form can't be saved.
        setMissing(errorMessage({ detail: err.detail }));
      } else {
        // A 409 (a later redemption left short, say) can be fixed here, so the form stays open.
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
      await apiFetch(`/investments/fund-trades/${trade.id}`, { method: "DELETE", token: token ?? undefined });
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
    <Chip
      key={key}
      selected={selected}
      showSelectedCheck
      disabled={busy}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: busy }}
    >
      {label}
    </Chip>
  );

  const heading = (label: string) => (
    <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
      {label}
    </Text>
  );

  // A redemption can only be of a fund held somewhere (or the one being edited).
  const heldIds = new Set(holdings.map((h) => h.fund_id));
  const choosable = funds.filter((f) => mode !== "sell" || heldIds.has(f.id) || f.id === trade?.fund_id);
  const chosen = funds.find((f) => String(f.id) === form.fund_id);
  const canAddFund = !editing && mode !== "sell";
  const fundSips = sips.filter((s) => String(s.fund_id) === form.fund_id && (s.active || String(s.id) === form.sip_id));
  const held = holdings.find((h) => String(h.fund_id) === form.fund_id && String(h.account_id) === form.account_id);
  const bank = banks.find((b) => String(b.id) === form.account_id);
  const amount = cleanMoney(form.amount);
  const amountShown = MONEY.test(amount) && Number(amount) > 0 ? formatRupees(amount) : null;
  const mismatch = purchase && !errors.units && unitsMismatch(form);
  const today = todayIndia();
  const yesterday = previousDay(today);
  const title = titleFor(mode, editing);
  const sipLabel = (sip: Sip) =>
    `${formatRupees(sip.amount.replace(/\.00$/, ""))} on day ${sip.day} · ${sip.account_name}${sip.active ? "" : " (stopped)"}`;

  // Editing never moves a transaction to another fund: for a SIP instalment that would silently drop its SIP.
  const fundPicker =
    form.fund_id === NEW_FUND ? (
      <View style={styles.picked}>
        <Text variant="bodyLarge" style={styles.grow}>
          New fund
        </Text>
        {funds.length > 0 ? (
          <Button compact disabled={busy} onPress={() => chooseFund("")}>
            Choose another
          </Button>
        ) : null}
      </View>
    ) : chosen ? (
      <View style={styles.picked}>
        <View style={styles.grow}>
          <Text variant="titleMedium">{chosen.name}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {chosen.symbol}
          </Text>
        </View>
        {editing ? null : (
          <Button compact disabled={busy} accessibilityLabel={`Change fund, ${chosen.name} chosen`} onPress={() => chooseFund("")}>
            Change
          </Button>
        )}
      </View>
    ) : (
      <Surface elevation={0} style={[styles.results, { borderColor: errors.fund_id ? colors.error : colors.outlineVariant }]}>
        {choosable.map((f) => (
          <List.Item
            key={f.id}
            title={f.name}
            titleNumberOfLines={2}
            description={f.symbol}
            disabled={busy}
            onPress={() => chooseFund(String(f.id))}
            accessibilityRole="button"
            accessibilityLabel={`Choose ${f.name}`}
          />
        ))}
        {mode === "sell" && choosable.length === 0 ? (
          <Text variant="bodyMedium" style={[styles.more, { color: colors.onSurfaceVariant }]}>
            You don&apos;t hold any fund units to redeem.
          </Text>
        ) : null}
        {canAddFund ? (
          <List.Item
            title="Add a fund"
            left={(p) => <List.Icon {...p} icon="plus" />}
            disabled={busy}
            onPress={() => chooseFund(NEW_FUND)}
            accessibilityRole="button"
          />
        ) : null}
      </Surface>
    );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} disabled={saving || deleting} />
        <Appbar.Content title={title} />
        {editing ? (
          <Appbar.Action icon="delete-outline" accessibilityLabel="Delete transaction" disabled={busy} onPress={() => setConfirming(true)} />
        ) : null}
      </Appbar.Header>

      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
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

          {editing ? (
            <View>
              {heading("Type")}
              <Text variant="bodyLarge">{MODES.find((m) => m.value === mode)?.label}</Text>
            </View>
          ) : focusNav ? null : (
            <View>
              {heading("Type")}
              <View style={styles.chips} accessibilityRole="radiogroup">
                {MODES.map((option) => choice(option.label, mode === option.value, () => changeMode(option.value)))}
              </View>
            </View>
          )}

          {field(
            "fund_id",
            <>
              {heading("Fund")}
              <View style={styles.gap}>{fundPicker}</View>
            </>,
          )}

          {form.fund_id === NEW_FUND ? (
            <>
              {field("name", input("name", "Fund name, like Parag Parikh Flexi Cap", { maxLength: 60 }))}
              {field(
                "symbol",
                input("symbol", "Short name (optional)", { maxLength: 20, autoCapitalize: "characters" }),
                <HelperText type="info" visible>
                  Shown where space is short. Left blank, one is made from the name.
                </HelperText>,
              )}
            </>
          ) : null}

          {mode === "sip" && form.fund_id !== "" && form.fund_id !== NEW_FUND
            ? field(
                "sip_id",
                <>
                  {heading("SIP")}
                  {fundSips.length > 0 ? (
                    <View style={styles.chips} accessibilityRole="radiogroup">
                      {fundSips.map((s) => choice(sipLabel(s), form.sip_id === String(s.id), () => chooseSip(s), String(s.id)))}
                    </View>
                  ) : (
                    <Text variant="bodyMedium" style={[styles.gap, { color: colors.onSurfaceVariant }]}>
                      This fund has no SIP, so this is recorded as a plain purchase. Add the SIP from the fund&apos;s screen.
                    </Text>
                  )}
                </>,
              )
            : null}

          {mode !== "opening"
            ? field(
                "nav",
                input("nav", "NAV (₹)", {
                  keyboardType: "decimal-pad",
                  maxLength: 16,
                  placeholder: "84.3793",
                  autoFocus: focusNav,
                  returnKeyType: "done",
                }),
              )
            : null}

          {field(
            "units",
            input("units", "Units", { keyboardType: "decimal-pad", maxLength: 20 }),
            <>
              {purchase && !unitsByHand && form.units !== "" ? (
                <HelperText type="info" visible accessibilityLiveRegion="polite">
                  Worked out from the amount, stamp duty and NAV. Check it against your statement.
                </HelperText>
              ) : null}
              {mismatch ? (
                <HelperText type="info" visible accessibilityLiveRegion="polite" style={{ color: colors.tertiary }}>
                  {MISMATCH}
                </HelperText>
              ) : null}
            </>,
          )}

          {field(
            "amount",
            input("amount", mode === "sell" ? "Amount received (₹)" : mode === "opening" ? "Total cost (₹)" : "Amount (₹)", {
              keyboardType: "decimal-pad",
              maxLength: MONEY_MAX_LENGTH,
            }),
            mode === "opening" ? (
              <HelperText type="info" visible>
                What you paid for these units in all, from your statement.
              </HelperText>
            ) : null,
          )}

          {mode !== "opening"
            ? field(
                "charges",
                input("charges", purchase ? "Stamp duty (₹)" : "Charges (₹, optional)", {
                  keyboardType: "decimal-pad",
                  maxLength: MONEY_MAX_LENGTH,
                }),
                <HelperText type="info" visible>
                  {purchase ? "0.005% of the amount, worked out for you." : "Exit load, STT and any TDS together."}
                </HelperText>,
              )
            : null}

          {field(
            "date",
            <>
              {input("date", mode === "opening" ? "Bought around (YYYY-MM-DD)" : "Date (YYYY-MM-DD)", { maxLength: 10 })}
              <View style={styles.chips}>
                {choice("Today", form.date === today, () => set("date", today))}
                {choice("Yesterday", form.date === yesterday, () => set("date", yesterday))}
              </View>
            </>,
          )}

          {field(
            "account_id",
            <>
              {heading("Bank account")}
              <View style={styles.chips} accessibilityRole="radiogroup">
                {banks.map((b) => choice(b.name, form.account_id === String(b.id), () => set("account_id", String(b.id)), String(b.id)))}
              </View>
            </>,
            mode === "sell" && form.fund_id && form.fund_id !== NEW_FUND && form.account_id ? (
              <HelperText type="info" visible accessibilityLiveRegion="polite">
                {held ? `You hold ${formatUnits(held.units)} units here.` : "You hold none of this fund here."}
              </HelperText>
            ) : null,
          )}

          {field("note", input("note", "Note (optional)", { maxLength: 200 }))}

          <Surface elevation={0} style={[styles.total, { backgroundColor: colors.surfaceVariant }]}>
            <Text variant="bodyLarge" accessibilityLiveRegion="polite" style={{ color: colors.onSurfaceVariant }}>
              {mode === "opening" ? (
                "Your bank balance won't change."
              ) : amountShown === null ? (
                purchase ? (
                  "Enter the amount and NAV, and the units are worked out."
                ) : (
                  "Enter the amount you received."
                )
              ) : (
                <>
                  <Text style={[styles.strong, { color: colors.onSurface }]}>{amountShown}</Text>
                  {purchase ? " leaves " : " goes into "}
                  {bank ? bank.name : "your bank account"}.
                </>
              )}
            </Text>
          </Surface>

          <Button
            mode="contained"
            onPress={() => void save()}
            loading={saving}
            disabled={busy}
            contentStyle={styles.saveContent}
            style={styles.save}
          >
            {saving
              ? "Saving..."
              : editing
                ? "Save changes"
                : mode === "sip"
                  ? "Record SIP"
                  : mode === "buy"
                    ? "Buy"
                    : mode === "sell"
                      ? "Redeem"
                      : "Add units"}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={confirming} onDismiss={() => (deleting ? undefined : setConfirming(false))}>
          <Dialog.Title>{trade ? fundTradeDeleteText(trade).title : "Delete this transaction?"}</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{trade ? fundTradeDeleteText(trade).body : ""}</Text>
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  gap: { marginTop: 8 },
  picked: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  results: { borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  more: { paddingHorizontal: 16, paddingVertical: 8 },
  total: { borderRadius: 12, padding: 12 },
  strong: { fontWeight: "600" },
  save: { marginTop: 8 },
  saveContent: { height: 48 },
});
