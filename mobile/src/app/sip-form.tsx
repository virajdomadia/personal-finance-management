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
import {
  Button,
  Dialog,
  HelperText,
  List,
  Portal,
  Surface,
  Switch,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Account, type AccountList, cleanMoney, errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Fund, type Sip, type SipForm, blankSipForm, sipFormFrom, sipPayload } from "@/lib/funds";
import { realDate } from "@/lib/investments";
import { ChunkyBox, ChunkyButton, Chip, HeaderAction, ScreenHeader } from "@/components/chunky";
import { DateField } from "@/components/date-field";
import { Banner } from "@/components/form-parts";
import { BRAND } from "@/lib/theme";
import { useSession } from "@/lib/session";
import { todayIndia } from "@/lib/transactions";

const NEW_FUND = "new";
const MONEY = /^\d+(?:\.\d{1,2})?$/;
// The fields the form shows, in screen order, which is where field errors can be displayed.
const RENDERED = ["fund_id", "name", "symbol", "account_id", "amount", "day", "start_date"] as const;

type Form = SipForm & { name: string; symbol: string };
type Key = Exclude<keyof Form, "active">;
type Loaded = { funds: Fund[]; banks: Account[]; sip: Sip | null };

export default function SipFormScreen() {
  const { id, fundId } = useLocalSearchParams<{ id?: string; fundId?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const editing = id !== undefined;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    Promise.all([
      apiFetch<{ funds: Fund[] }>("/investments/funds", auth),
      apiFetch<AccountList>("/accounts", auth),
      editing ? apiFetch<{ sips: Sip[] }>("/investments/sips", auth) : Promise.resolve(null),
    ])
      .then(([funds, accounts, sips]) => {
        if (!current) return;
        const sip = sips?.sips.find((s) => String(s.id) === id) ?? null;
        if (editing && sip === null) {
          setLoadError("This SIP was not found.");
          return;
        }
        // Only active banks: the accounts list leaves archived ones out.
        setLoaded({ funds: funds.funds, banks: accounts.accounts.filter((a) => a.type === "bank"), sip });
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
  }, [editing, id, token, logOut, attempt]);

  const fallbackTitle = editing ? "Edit SIP" : "Add SIP";

  if (loaded === null || (loaded.banks.length === 0 && !editing)) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScreenHeader title={fallbackTitle} back />
        <View style={styles.center}>
          {loaded !== null ? (
            <>
              <Text variant="titleMedium">Add a bank account first</Text>
              <Text variant="bodyMedium" style={[styles.centerText, { color: BRAND.zinc600 }]}>
                A SIP is debited from a bank account each month.
              </Text>
              <ChunkyButton label="Go to accounts" onPress={() => router.navigate("/accounts")} />
            </>
          ) : loadError === null ? (
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

  return <FormBody {...loaded} defaultFundId={fundId} />;
}

function startForm({ funds, banks, sip, defaultFundId }: Loaded & { defaultFundId?: string }): Form {
  if (sip) return { ...sipFormFrom(sip), name: "", symbol: "" };
  const form: Form = { ...blankSipForm(todayIndia()), name: "", symbol: "" };
  if (defaultFundId !== undefined && funds.some((f) => String(f.id) === defaultFundId)) form.fund_id = defaultFundId;
  else if (funds.length === 0) form.fund_id = NEW_FUND;
  if (banks.length === 1) form.account_id = String(banks[0].id);
  return form;
}

function localErrors(form: Form, editing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!editing) {
    if (form.fund_id === NEW_FUND) {
      if (form.name.trim() === "") errors.name = "Enter a name.";
    } else if (form.fund_id === "") errors.fund_id = "Choose a fund.";
    const start = form.start_date.trim();
    if (start === "") errors.start_date = "Choose the first instalment's date.";
    else if (!realDate(start)) errors.start_date = "Enter a date like 2026-11-05.";
  }
  if (form.account_id === "") errors.account_id = "Choose a bank account.";
  const amount = cleanMoney(form.amount);
  if (amount === "") errors.amount = "Enter the SIP amount.";
  else if (!MONEY.test(amount)) errors.amount = "Enter an amount, like 3000.";
  else if (Number(amount) <= 0) errors.amount = "Amount must be greater than 0.";
  const day = form.day.trim();
  if (!/^\d{1,2}$/.test(day) || Number(day) < 1 || Number(day) > 31) errors.day = "Choose a day from 1 to 31.";
  return errors;
}

// What an edit sends: only what changed, so a stale form can't overwrite a change made elsewhere.
function changed(form: SipForm, original: Sip): Record<string, unknown> {
  const before = sipPayload(sipFormFrom(original), "edit");
  const after = sipPayload(form, "edit");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) result[key] = after[key];
  }
  return result;
}

// Adds a monthly SIP, or changes its amount, debit day or bank account. A SIP never posts on its own:
// it shows as due each month until the instalment is recorded.
function FormBody(props: Loaded & { defaultFundId?: string }) {
  const { banks, sip } = props;
  const editing = sip !== null;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<Form>(() => startForm(props));
  const [funds, setFunds] = useState<Fund[]>(props.funds);
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
    const first = RENDERED.find((key) => errors[key]);
    if (first) inputs.current[first]?.focus();
  }, [errors, general, saving]);

  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    if (savingRef.current || deletingRef.current) return;
    Keyboard.dismiss();
    const local = localErrors(form, editing);
    if (Object.keys(local).length > 0) {
      needFocus.current = true;
      setGeneral([]);
      setErrors(local);
      return;
    }

    let payload: Record<string, unknown> | null = null;
    if (sip) {
      payload = changed(form, sip);
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
      let current: SipForm = form;
      if (!sip && form.fund_id === NEW_FUND) {
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
        // The fund exists now. If the SIP below fails, it stays chosen so a retry doesn't add it twice.
        setFunds((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
        setForm((f) => ({ ...f, fund_id: String(created.id), name: "", symbol: "" }));
        current = { ...form, fund_id: String(created.id) };
      }

      if (sip && payload) {
        await apiFetch<Sip>(`/investments/sips/${sip.id}`, { method: "PATCH", ...auth, body: payload });
      } else {
        await apiFetch<Sip>("/investments/sips", { method: "POST", ...auth, body: sipPayload(current, "create") });
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
        setMissing(errorMessage({ detail: err.detail }));
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

  // Only a SIP with no instalments can go; one with instalments is stopped instead.
  async function remove() {
    if (!sip || deletingRef.current || savingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    let done = false;
    try {
      await apiFetch(`/investments/sips/${sip.id}`, { method: "DELETE", token: token ?? undefined });
      done = true;
      if (mounted.current) router.back();
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

  const busy = saving || deleting || missing !== null;
  const title = editing ? "Edit SIP" : "Add SIP";
  const chosen = funds.find((f) => String(f.id) === form.fund_id);
  // A stopped SIP's bank may since have been archived: it stays as it is unless another is chosen.
  const archivedBank = editing && form.account_id !== "" && !banks.some((b) => String(b.id) === form.account_id);

  const field = (key: Key, content: React.ReactNode, hint?: React.ReactNode) => (
    <View key={key}>
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
    <TextInput
      ref={(node: TextInputInstance | null) => {
        inputs.current[key] = node;
      }}
      mode="outlined"
      label={label}
      value={form[key]}
      onChangeText={(text) => set(key, text)}
      error={Boolean(errors[key])}
      disabled={busy}
      autoComplete="off"
      importantForAutofill="no"
      autoCorrect={false}
      {...extra}
    />
  );

  const heading = (label: string) => (
    <Text variant="labelLarge" style={{ color: BRAND.zinc600 }}>
      {label}
    </Text>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={title}
        back
        backDisabled={saving || deleting}
        right={
          sip && sip.instalments === 0 ? (
            <HeaderAction icon="delete-outline" label="Delete SIP" disabled={busy} onPress={() => setConfirming(true)} />
          ) : undefined
        }
      />

      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
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

          {field(
            "fund_id",
            <>
              {heading("Fund")}
              <View style={styles.gap}>
                {editing ? (
                  <Text variant="titleMedium">{sip.fund_name}</Text>
                ) : form.fund_id === NEW_FUND ? (
                  <View style={styles.picked}>
                    <Text variant="bodyLarge" style={styles.grow}>
                      New fund
                    </Text>
                    {funds.length > 0 ? (
                      <ChunkyButton compact variant="alt" label="Choose another" disabled={busy} onPress={() => set("fund_id", "")} />
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
                    <ChunkyButton compact variant="alt" label="Change" disabled={busy} accessibilityLabel={`Change fund, ${chosen.name} chosen`} onPress={() => set("fund_id", "")} />
                  </View>
                ) : (
                  <Surface
                    elevation={0}
                    style={[styles.results, { borderColor: errors.fund_id ? BRAND.loss : BRAND.ink }]}
                  >
                    {funds.map((f) => (
                      <List.Item
                        key={f.id}
                        title={f.name}
                        titleNumberOfLines={2}
                        description={f.symbol}
                        disabled={busy}
                        onPress={() => set("fund_id", String(f.id))}
                        accessibilityRole="button"
                        accessibilityLabel={`Choose ${f.name}`}
                      />
                    ))}
                    <List.Item
                      title="Add a fund"
                      left={(p) => <List.Icon {...p} icon="plus" />}
                      disabled={busy}
                      onPress={() => set("fund_id", NEW_FUND)}
                      accessibilityRole="button"
                    />
                  </Surface>
                )}
              </View>
            </>,
          )}

          {!editing && form.fund_id === NEW_FUND ? (
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

          {field("amount", input("amount", "Monthly amount (₹)", { keyboardType: "decimal-pad", maxLength: 24 }))}

          {field(
            "day",
            input("day", "Debit day", { keyboardType: "number-pad", maxLength: 2, placeholder: "5" }),
            <HelperText type="info" visible>
              1 to 31. Short months use their last day.
            </HelperText>,
          )}

          {field(
            "account_id",
            <>
              {heading("Bank account")}
              <View style={styles.chips} accessibilityRole="radiogroup">
                {banks.map((b) => {
                  const selected = form.account_id === String(b.id);
                  return (
                    <Chip key={b.id} label={b.name} selected={selected} disabled={busy} onPress={() => set("account_id", String(b.id))} accessibilityRole="radio" />
                  );
                })}
              </View>
            </>,
            archivedBank ? (
              <HelperText type="info" visible>
                Debited from {sip?.account_name}, which is archived. Choose another to change it.
              </HelperText>
            ) : null,
          )}

          {editing
            ? null
            : field(
                "start_date",
                <DateField
                  label="First instalment"
                  value={form.start_date}
                  onChange={(iso) => set("start_date", iso)}
                  disabled={busy}
                  invalid={Boolean(errors.start_date)}
                />,
                <HelperText type="info" visible>
                  Months from here on show as due until you record them.
                </HelperText>,
              )}

          {editing ? (
            <View style={styles.switchRow}>
              <View style={styles.grow}>
                <Text variant="bodyLarge">Active</Text>
                <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
                  A stopped SIP is never due. Its past instalments stay.
                </Text>
              </View>
              <Switch
                color={BRAND.greenStrong}
                value={form.active}
                disabled={busy}
                onValueChange={(active) => setForm((f) => ({ ...f, active }))}
                accessibilityLabel="Active"
              />
            </View>
          ) : null}

          <ChunkyBox radius={14} offset={3} style={[styles.note, { backgroundColor: BRAND.due }]}>
            <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
              Nothing is recorded on its own. Each month the SIP shows as due, and you record it with that day&apos;s NAV.
            </Text>
          </ChunkyBox>

          <ChunkyButton
            variant="green"
            label={saving ? "Saving..." : editing ? "Save changes" : "Add SIP"}
            onPress={() => void save()}
            loading={saving}
            disabled={busy && !saving}
            style={styles.save}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={confirming} onDismiss={() => (deleting ? undefined : setConfirming(false))}>
          <Dialog.Title>Delete this SIP?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Only a SIP with no instalments recorded can be deleted. This can&apos;t be undone.
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
  banner: { padding: 12, gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  gap: { marginTop: 8 },
  picked: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  results: { borderRadius: 14, borderWidth: 2.5, overflow: "hidden" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  note: { padding: 12 },
  save: { marginTop: 8 },
});
