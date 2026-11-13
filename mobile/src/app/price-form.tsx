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

import { cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { formatCoinPrice } from "@/lib/crypto";
import { formatNav } from "@/lib/funds";
import type { MarketKind } from "@/lib/investments";
import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { DateField } from "@/components/date-field";
import { BRAND } from "@/lib/theme";
import { useSession } from "@/lib/session";
import { formatDate, previousDay, todayIndia } from "@/lib/transactions";

type Key = "price" | "date";
const FIELDS: Key[] = ["price", "date"];

// A stock, fund or coin as this screen needs it: a fund's NAV is its price.
type Holding = { id: number; symbol: string; name: string; price: string | null; date: string | null };

type Kind = {
  path: string; // under /investments
  noun: string;
  priceWord: "price" | "NAV";
  field: "price" | "nav"; // what the server calls the value
  label: string;
  input: Partial<React.ComponentProps<typeof TextInput>>;
  format: (value: string) => string;
  clean: (value: string) => string;
  read: (body: Record<string, unknown>) => Holding[];
};

const holding = (row: Record<string, unknown>, price: string, date: string): Holding => ({
  id: row.id as number,
  symbol: row.symbol as string,
  name: row.name as string,
  price: row[price] as string | null,
  date: row[date] as string | null,
});

const KINDS: Record<MarketKind, Kind> = {
  stock: {
    path: "stocks",
    noun: "stock",
    priceWord: "price",
    field: "price",
    label: "Price per share (₹)",
    input: { maxLength: 24 },
    format: formatRupees,
    clean: cleanMoney,
    read: (body) => (body.stocks as Record<string, unknown>[]).map((r) => holding(r, "price", "price_date")),
  },
  mutual_fund: {
    path: "funds",
    noun: "fund",
    priceWord: "NAV",
    field: "nav",
    label: "NAV (₹)",
    input: { maxLength: 16, placeholder: "84.3793" },
    format: formatNav,
    clean: (value) => value.trim(),
    read: (body) => (body.funds as Record<string, unknown>[]).map((r) => holding(r, "nav", "nav_date")),
  },
  crypto: {
    path: "coins",
    noun: "coin",
    priceWord: "price",
    field: "price",
    label: "Price per coin (₹)",
    input: { maxLength: 16, placeholder: "7504827.5" },
    format: formatCoinPrice,
    clean: (value) => value.trim(),
    read: (body) => (body.coins as Record<string, unknown>[]).map((r) => holding(r, "price", "price_date")),
  },
};

// Update price (a stock or coin) or NAV (a fund): the holding is valued at the latest one. Fund
// purchases and redemptions record their own NAV; a linked holding gets one every night.
// Params: kind (stock | mutual_fund | crypto) and id. The older stockId, fundId and coinId still work.
export default function PriceFormScreen() {
  const params = useLocalSearchParams<{ kind?: string; id?: string; stockId?: string; fundId?: string; coinId?: string }>();
  const kindName: MarketKind =
    params.kind === "mutual_fund" || params.fundId !== undefined
      ? "mutual_fund"
      : params.kind === "crypto" || params.coinId !== undefined
        ? "crypto"
        : "stock";
  const kind = KINDS[kindName];
  const holdingId = params.id ?? params.stockId ?? params.fundId ?? params.coinId;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [stock, setStock] = useState<Holding | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState<Record<Key, string>>(() => ({ price: "", date: todayIndia() }));
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
    apiFetch<Record<string, unknown>>(`/investments/${kind.path}`, { token: token ?? undefined })
      .then((result) => {
        if (!current) return;
        const found = kind.read(result).find((s) => String(s.id) === holdingId);
        if (found) setStock(found);
        else setLoadError(`This ${kind.noun} was not found.`);
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
  }, [kind, holdingId, token, logOut, attempt]);

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
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      const price = kind.clean(form.price);
      const date = form.date.trim();
      await apiFetch(`/investments/${kind.path}/${stock.id}/${kind.field === "nav" ? "navs" : "prices"}`, {
        method: "POST",
        token: token ?? undefined,
        body: { date: date === "" ? null : date, [kind.field]: price === "" ? null : price },
      });
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        // The server calls a fund's NAV `nav`; this form shows it in the price field.
        const detail = Array.isArray(err.detail)
          ? err.detail.map((item: { loc?: unknown[] }) =>
              Array.isArray(item?.loc) && item.loc[item.loc.length - 1] === "nav" ? { ...item, loc: [...item.loc.slice(0, -1), "price"] } : item,
            )
          : err.detail;
        const result = splitErrors(detail, FIELDS);
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

  const title = stock ? `Update ${kind.priceWord} of ${stock.symbol}` : `Update ${kind.priceWord}`;
  const busy = saving || missing !== null;
  const today = todayIndia();
  const yesterday = previousDay(today);

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

            {kindName === "stock" ? null : <Text variant="titleMedium">{stock.name}</Text>}
            <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
              {stock.price !== null && stock.date !== null
                ? `Last recorded ${kind.format(stock.price)} on ${formatDate(stock.date)}.`
                : `No ${kind.priceWord} recorded yet, so holdings are valued at cost.`}
            </Text>

            {input("price", kind.label, { keyboardType: "decimal-pad", autoFocus: true, ...kind.input })}

            <DateField
              label="As of"
              value={form.date}
              onChange={(iso) => setForm((f) => ({ ...f, date: iso }))}
              disabled={busy}
              maxDate={today}
              error={errors.date}
              chips={[
                { label: "Today", value: today },
                { label: "Yesterday", value: yesterday },
              ]}
            />

            <ChunkyButton
            variant="green"
            label={saving ? "Saving..." : `Save ${kind.priceWord}`}
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
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  save: { marginTop: 8 },
});
