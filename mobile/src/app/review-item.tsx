import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text as NativeText, View } from "react-native";
import { Checkbox, HelperText, RadioButton, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader, Segmented, TONE_SQUARE } from "@/components/chunky";
import { CategoryChips } from "@/components/category-chips";
import { Banner, LoadingScreen, useBlockBack } from "@/components/form-parts";
import { type Account, type AccountList, errorMessage, maskLast4, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { CATEGORIES_PATH, EMPTY_TREE, type CategoryTree, pickerGroups, sameName } from "@/lib/categories";
import {
  type Action,
  type Candidate,
  REVIEW_EMOJI,
  type ReviewItem,
  accountChoices,
  actionsFor,
  candidatesOf,
  categoryBody,
  categoryType,
  expectedBody,
  expectedChoices,
  marketPrefill,
  needsNav,
  rememberLabel,
  reviewDetails,
  reviewFigure,
  reviewTitle,
  tradeBody,
  whyLine,
} from "@/lib/review";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS } from "@/lib/theme";

// Every field a 422 can name that this screen shows a control for; anything else goes in the banner.
const FIELDS = [
  "category",
  "account_id",
  "transaction_id",
  "id",
  "units",
  "nav",
  "stock_id",
  "symbol",
  "name",
  "price",
  "charges",
  "side",
  "quantity",
] as const;

type Loaded = { item: ReviewItem | null; accounts: Account[]; categories: CategoryTree };

export default function ReviewItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token, logOut } = useSession();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Shown above the next answer: a retry that still couldn't record, say.
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const auth = { token: token ?? undefined };
    try {
      const [list, accounts, categories] = await Promise.all([
        apiFetch<{ items: ReviewItem[] }>("/sms/review", auth),
        apiFetch<AccountList>("/accounts", auth),
        // Only suggestions: without them a category can still be typed.
        apiFetch<CategoryTree>(CATEGORIES_PATH, auth).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) throw err;
          return EMPTY_TREE;
        }),
      ]);
      setLoaded({ item: list.items.find((i) => String(i.id) === id) ?? null, accounts: accounts.accounts, categories });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setLoadError("We couldn't load this message.");
    }
  }, [id, token, logOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (loaded === null) return <LoadingScreen title="To review" error={loadError} onRetry={() => {
          setLoadError(null);
          void load();
        }} />;
  if (loaded.item === null) return <Gone text="This message was already answered." />;

  return (
    <Answer
      // A fresh form for each state the item is in.
      key={`${loaded.item.id}-${loaded.item.reason}`}
      item={loaded.item}
      accounts={loaded.accounts}
      categories={loaded.categories}
      note={note}
      onAnswered={(action, next) => {
        if (next === null) {
          router.back();
          return;
        }
        setNote(
          action === "retry" && next.reason === "balance"
            ? (next.message ?? "It still couldn't be recorded.")
            : next.reason === "sip_units"
              ? "Recorded. Now check the SIP units."
              : null,
        );
        setLoaded({ ...loaded, item: next });
      }}
    />
  );
}

function Gone({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="To review" back />
      <View style={styles.center}>
        <Text variant="bodyLarge" style={styles.centerText}>
          {text}
        </Text>
        <ChunkyButton label="Back to the list" onPress={() => router.back()} />
      </View>
    </View>
  );
}

type AnswerProps = {
  item: ReviewItem;
  accounts: Account[]; // active
  categories: CategoryTree;
  note: string | null;
  onAnswered: (action: Action, next: ReviewItem | null) => void;
};

function Answer({ item, accounts, categories, note, onAnswered }: AnswerProps) {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const actions = actionsFor(item);
  const has = (action: Action) => actions.includes(action);
  const transactions = candidatesOf(item, "transaction");
  const expected = expectedChoices(item);
  const stocks = candidatesOf(item, "stock");
  const markets = candidatesOf(item, "market");
  const brokers = accounts.filter((a) => a.type === "broker");
  const firstMarket = markets[0] ? marketPrefill(markets[0].label) : { symbol: "", name: "" };

  const [busy, setBusy] = useState<Action | null>(null);
  const busyRef = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [stale, setStale] = useState<string | null>(null);
  // A draft opens with its payee's usual category (or account) already picked.
  const [category, setCategory] = useState(item.suggested_category ?? "");
  const [remember, setRemember] = useState(true);
  const [accountId, setAccountId] = useState(
    item.suggested_account_id !== null ? String(item.suggested_account_id) : "",
  );
  const [same, setSame] = useState(transactions.length === 1 ? String(transactions[0].id) : "");
  const [transfer, setTransfer] = useState(transactions.length === 1 ? String(transactions[0].id) : "");
  const [expectedKey, setExpectedKey] = useState(expected.length === 1 ? `${expected[0].kind}:${expected[0].id}` : "");
  const [units, setUnits] = useState("");
  const [nav, setNav] = useState("");
  const [stock, setStock] = useState(stocks[0] ? `stock:${stocks[0].id}` : markets[0] ? `market:${markets[0].id}` : "new");
  const [symbol, setSymbol] = useState(stocks.length === 0 ? firstMarket.symbol : "");
  const [name, setName] = useState(stocks.length === 0 ? firstMarket.name : "");
  const [brokerId, setBrokerId] = useState(brokers.length === 1 ? String(brokers[0].id) : "");
  const [price, setPrice] = useState(item.suggested_price ?? "");
  const [charges, setCharges] = useState("");
  const [side, setSide] = useState<"buy" | "sell" | null>(null);
  const [needsSide, setNeedsSide] = useState(false);

  useBlockBack(useCallback(() => busyRef.current, []));

  async function answer(action: Action, body: Record<string, unknown>) {
    if (busyRef.current) return;
    // The server wants a whole id; say so plainly rather than show its type error.
    const missing = (["account_id", "transaction_id", "id"] as const).find((key) => key in body && body[key] === null);
    if (missing) {
      setErrors({
        [missing]: missing === "account_id" ? (action === "trade" ? "Choose a broker." : "Choose an account.") : "Choose one.",
      });
      setGeneral([]);
      return;
    }
    busyRef.current = true;
    setBusy(action);
    setErrors({});
    setGeneral([]);
    try {
      const next = await apiFetch<ReviewItem | null>(`/sms/review/${item.id}`, {
        method: "POST",
        token: token ?? undefined,
        body,
      });
      busyRef.current = false;
      // Gone from the list: the screen closes, so the buttons stay busy until it does.
      if (next !== null) setBusy(null);
      onAnswered(action, next);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else if (err instanceof ApiError && err.status === 422) {
        const split = splitErrors(err.detail, FIELDS);
        if ("side" in split.fields) setNeedsSide(true);
        setErrors(split.fields);
        setGeneral(split.general);
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        setStale(errorMessage({ detail: err.detail }));
      } else {
        setGeneral([err instanceof ApiError ? errorMessage({ detail: err.detail }) : "Couldn't save. Check your connection and try again."]);
      }
    }
    busyRef.current = false;
    setBusy(null);
  }

  const disabled = busy !== null;
  const errorText = (field: string) =>
    errors[field] ? (
      <HelperText type="error" visible>
        {errors[field]}
      </HelperText>
    ) : null;
  const numberInput = (field: string, label: string, value: string, set: (v: string) => void, extra: Partial<React.ComponentProps<typeof TextInput>> = {}) => (
    <View>
      <TextInput
        mode="outlined"
        label={label}
        value={value}
        onChangeText={set}
        disabled={disabled}
        error={Boolean(errors[field])}
        keyboardType="decimal-pad"
        maxLength={20}
        {...extra}
      />
      {errorText(field)}
    </View>
  );
  const rememberBox = (label: string) => (
    <Checkbox.Item
      mode="android"
      position="leading"
      disabled={disabled}
      status={remember ? "checked" : "unchecked"}
      onPress={() => setRemember(!remember)}
      label={label}
      labelVariant="bodyMedium"
      style={styles.check}
    />
  );
  // A radio list in chunky option cards, for accounts and candidates.
  const radioList = (options: { value: string; label: string }[], value: string, set: (v: string) => void) => (
    <RadioButton.Group value={value} onValueChange={(v) => !disabled && set(v)}>
      <View style={styles.options}>
        {options.map((o) => (
          <ChunkyBox key={o.value} radius={INPUT_RADIUS} offset={3} style={value === o.value ? { backgroundColor: BRAND.yellow } : undefined}>
            <RadioButton.Item value={o.value} label={o.label} disabled={disabled} mode="android" labelVariant="bodyLarge" style={styles.option} />
          </ChunkyBox>
        ))}
      </View>
    </RadioButton.Group>
  );
  const candidateOptions = (list: Candidate[]) => list.map((c) => ({ value: String(c.id), label: c.label }));
  const section = (title: string, children: ReactNode, hint?: string) => (
    <ChunkyBox style={styles.section}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {hint ? (
        <Text variant="bodySmall" style={styles.muted}>
          {hint}
        </Text>
      ) : null}
      {children}
    </ChunkyBox>
  );
  const button = (action: Action, label: string, variant: "green" | "alt" = "green") => (
    <ChunkyButton
      variant={variant}
      label={busy === action ? "Saving..." : label}
      onPress={() => void submit(action)}
      loading={busy === action}
      disabled={disabled && busy !== action}
      style={styles.action}
    />
  );

  const type = categoryType(item);
  const categoryPicker = (optional: boolean) => (
    <>
      <View>
        <TextInput
          mode="outlined"
          label={optional ? "Category (optional)" : "Category"}
          value={category}
          onChangeText={setCategory}
          disabled={disabled}
          error={Boolean(errors.category)}
          maxLength={40}
        />
        {errorText("category")}
      </View>
      <CategoryChips
        groups={pickerGroups(categories[type])}
        selected={(name) => sameName(category, name)}
        onPick={setCategory}
        disabled={disabled}
      />
      {item.payee !== null ? rememberBox(rememberLabel(item.payee, category)) : null}
    </>
  );

  const accountOptions =
    item.reason === "card_payment"
      ? candidateOptions(candidatesOf(item, "account"))
      : accountChoices(item, accounts).map((a) => ({ value: String(a.id), label: a.name }));
  const stockOptions = [
    ...stocks.map((c) => ({ value: `stock:${c.id}`, label: c.label })),
    ...markets.map((c) => ({ value: `market:${c.id}`, label: `New: ${c.label}` })),
    { value: "new", label: "Another new stock" },
  ];
  function chooseStock(value: string) {
    setStock(value);
    const market = markets.find((c) => `market:${c.id}` === value);
    if (market) {
      const prefill = marketPrefill(market.label);
      setSymbol(prefill.symbol);
      setName(prefill.name);
    } else if (value === "new") {
      setSymbol("");
      setName("");
    }
  }
  const newStock = !stock.startsWith("stock:");
  const idOf = (value: string) => (value === "" ? null : Number(value));

  // The body each answer posts, from what is chosen on screen.
  function bodyFor(action: Action): Record<string, unknown> {
    switch (action) {
      case "same":
        return { action, transaction_id: idOf(same) };
      case "transfer":
        return { action, transaction_id: idOf(transfer) };
      case "expected": {
        const chosen = expected.find((c) => `${c.kind}:${c.id}` === expectedKey);
        if (chosen !== undefined) return expectedBody(item, chosen, remember, nav);
        return { action, kind: null, id: null, remember: false };
      }
      case "category":
        return categoryBody(item, category, remember);
      case "account":
        return { action, account_id: idOf(accountId), remember: item.reason === "account" && item.last4 !== null && remember };
      case "units":
        return { action, units: units.trim() || null, nav: nav.trim() || null };
      case "trade":
        return tradeBody({
          stock: newStock ? null : { kind: "stock", id: Number(stock.slice(6)) },
          brokerId: idOf(brokerId),
          price,
          charges,
          symbol,
          name,
          side,
        });
      default:
        return { action };
    }
  }

  function submit(action: Action) {
    return answer(action, bodyFor(action));
  }

  const look = REVIEW_EMOJI[item.reason ?? ""] ?? { emoji: "📩", tone: "card" as const };
  const title = reviewTitle(item);
  const figure = reviewFigure(item);
  const recorded = item.transaction_id !== null || item.trade_id !== null;

  if (stale !== null) {
    return <Gone text={stale} />;
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={title} back backDisabled={disabled} />
      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
          <ChunkyBox style={styles.message}>
            <View style={styles.messageTop}>
              <View style={[styles.square, { backgroundColor: TONE_SQUARE[look.tone] }]}>
                <NativeText style={styles.emoji} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  {look.emoji}
                </NativeText>
              </View>
              <View style={styles.messageMain}>
                {figure ? (
                  <Text variant="headlineSmall" style={styles.figure}>
                    {figure}
                  </Text>
                ) : null}
                <Text variant="bodyMedium" style={styles.muted}>
                  {reviewDetails(item)}
                </Text>
              </View>
            </View>
            {item.message ? (
              <Text variant="bodyMedium" style={styles.ink}>
                {item.message}
              </Text>
            ) : null}
            {item.why ? (
              <Text
                variant="labelLarge"
                style={item.confident ? styles.sure : styles.muted}
                accessibilityLabel={`${item.confident ? "Ready to approve" : "Needs a look"}: ${item.why}`}
              >
                {whyLine(item)}
              </Text>
            ) : null}
            <Text variant="bodySmall" style={styles.muted}>
              {recorded ? "Already in your records." : "Not recorded yet."}
            </Text>
          </ChunkyBox>

          {note !== null ? <Banner messages={[note]} tone="info" /> : null}
          {general.length > 0 ? <Banner messages={general} /> : null}

          {has("same")
            ? section(
                item.reason === "expected" ? "Already recorded as" : "Same as one of these?",
                <>
                  {radioList(candidateOptions(transactions), same, setSame)}
                  {errorText("transaction_id")}
                  {button("same", "Yes, the same")}
                </>,
                item.reason === "expected" ? "This payment may be recorded already." : "You may have added it by hand already.",
              )
            : null}
          {has("new") ? section("It's new", button("new", "No, it's new", "alt")) : null}

          {has("transfer")
            ? section(
                item.reason === "card_payment" ? "Paid by this debit?" : "A transfer with",
                <>
                  {radioList(candidateOptions(transactions), transfer, setTransfer)}
                  {errorText("transaction_id")}
                  {button("transfer", item.reason === "card_payment" ? "Paid by this one" : "It's a transfer")}
                </>,
              )
            : null}

          {has("expected")
            ? section(
                "Is it one of these?",
                <>
                  {radioList(
                    expected.map((c) => ({ value: `${c.kind}:${c.id}`, label: c.label })),
                    expectedKey,
                    setExpectedKey,
                  )}
                  {errorText("id")}
                  {needsNav(item) ? numberInput("nav", "SIP NAV on the day", nav, setNav, { placeholder: "50.1002" }) : null}
                  {item.payee !== null && expected.some((c) => c.kind === "template")
                    ? rememberBox(`Always match ${item.payee} to that reminder`)
                    : null}
                  {button("expected", "Yes, this one")}
                </>,
                needsNav(item) ? "No NAV is known for the SIP's day. Copy it from your fund statement." : undefined,
              )
            : null}

          {has("category")
            ? section(
                item.reason === "maybe_transfer" ? "Not a transfer" : item.reason === "expected" ? "None of these" : "Category",
                <>
                  {categoryPicker(item.reason === "maybe_transfer")}
                  {button(
                    "category",
                    item.reason === "maybe_transfer" ? "Not a transfer" : item.reason === "expected" ? "Save as spending" : "Save",
                    item.reason === "category" ? "green" : "alt",
                  )}
                </>,
              )
            : null}

          {has("account")
            ? section(
                item.reason === "card_payment" ? "Paid from" : "Which account?",
                <>
                  {accountOptions.length === 0 ? (
                    <Text variant="bodyMedium" style={styles.muted}>
                      No account fits. Add one in Accounts first.
                    </Text>
                  ) : (
                    radioList(accountOptions, accountId, setAccountId)
                  )}
                  {errorText("account_id")}
                  {item.reason === "account" && item.last4 !== null ? rememberBox(`Remember ${maskLast4(item.last4)} is this account`) : null}
                  {button("account", item.reason === "card_payment" ? "Paid from this account" : "Save")}
                </>,
              )
            : null}

          {has("units")
            ? section(
                "SIP units",
                <>
                  <View style={styles.pair}>
                    <View style={styles.half}>{numberInput("units", "Units", units, setUnits, { placeholder: "99.800" })}</View>
                    <View style={styles.half}>{numberInput("nav", "NAV", nav, setNav, { placeholder: "50.1002" })}</View>
                  </View>
                  {button("units", "Save units")}
                  {button("units_ok", "The estimate is right", "alt")}
                </>,
                "The units were estimated from the amount. Copy them from your fund statement.",
              )
            : null}

          {has("trade")
            ? section(
                "Share trade",
                <>
                  <Text variant="labelLarge" style={styles.ink}>
                    Stock
                  </Text>
                  {radioList(stockOptions, stock, chooseStock)}
                  {errorText("stock_id")}
                  {newStock ? (
                    <>
                      <View>
                        <TextInput mode="outlined" label="Symbol" value={symbol} onChangeText={setSymbol} disabled={disabled} error={Boolean(errors.symbol)} autoCapitalize="characters" maxLength={20} />
                        {errorText("symbol")}
                      </View>
                      <View>
                        <TextInput mode="outlined" label="Name" value={name} onChangeText={setName} disabled={disabled} error={Boolean(errors.name)} maxLength={100} />
                        {errorText("name")}
                      </View>
                    </>
                  ) : null}
                  <Text variant="labelLarge" style={styles.ink}>
                    Broker
                  </Text>
                  {brokers.length === 0 ? (
                    <Text variant="bodyMedium" style={styles.muted}>
                      Add a broker account first.
                    </Text>
                  ) : (
                    radioList(
                      brokers.map((a) => ({ value: String(a.id), label: a.name })),
                      brokerId,
                      setBrokerId,
                    )
                  )}
                  {errorText("account_id")}
                  {errorText("quantity")}
                  <View style={styles.pair}>
                    <View style={styles.half}>{numberInput("price", "Price per share (₹)", price, setPrice)}</View>
                    <View style={styles.half}>{numberInput("charges", "Charges (optional)", charges, setCharges)}</View>
                  </View>
                  {needsSide ? (
                    <View style={styles.sideBox}>
                      <Segmented
                        label="Bought or sold?"
                        // Nothing is selected until the owner picks one.
                        value={side ?? ("" as "buy")}
                        onChange={(v) => setSide(v)}
                        options={[
                          { value: "buy", label: "Bought" },
                          { value: "sell", label: "Sold" },
                        ]}
                      />
                      {errorText("side")}
                    </View>
                  ) : null}
                  {button("trade", "Save trade")}
                </>,
              )
            : null}

          {has("retry")
            ? section(
                "Try again",
                button("retry", "Try again"),
                "It couldn't be recorded, usually because the balance would go below zero. Fix the account, then try again.",
              )
            : null}

          <ChunkyButton
            variant="alt"
            label={busy === "dismiss" ? "Dismissing..." : "Dismiss"}
            accessibilityLabel={`Dismiss ${title}`}
            onPress={() => void submit("dismiss")}
            loading={busy === "dismiss"}
            disabled={disabled && busy !== "dismiss"}
          />
          <Text variant="bodySmall" style={[styles.muted, styles.centerText]}>
            {recorded ? "Dismiss keeps it as it is in your records." : "Dismiss ignores this message."}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 14 },
  message: { padding: 14, gap: 8 },
  messageTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  messageMain: { flex: 1, minWidth: 0 },
  square: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: { fontSize: 22, lineHeight: 28 },
  figure: { color: BRAND.ink, fontVariant: ["tabular-nums"] },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
  sure: { color: BRAND.greenStrong, fontWeight: "800" },
  section: { padding: 14, gap: 10 },
  sectionTitle: { color: BRAND.ink, letterSpacing: 0.6, textTransform: "uppercase" },
  options: { gap: 6 },
  option: { paddingVertical: 4 },
  check: { paddingHorizontal: 0 },
  pair: { flexDirection: "row", gap: 10 },
  half: { flex: 1, minWidth: 0 },
  sideBox: { gap: 4 },
  action: { alignSelf: "stretch" },
});
