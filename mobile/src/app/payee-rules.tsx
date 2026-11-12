import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, HelperText, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyButton, Chip, Row, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage, maskLast4, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { categoryEmoji } from "@/lib/fun";
import { type Identifier, type PayeeRule, ruleText } from "@/lib/review";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import type { CategoryList } from "@/lib/transactions";

const FAILED = "We couldn't load your payee rules.";

type Loaded = { rules: PayeeRule[]; identifiers: Identifier[]; categories: CategoryList };
type Deleting = { kind: "rule"; rule: PayeeRule } | { kind: "number"; identifier: Identifier };

// What Gullak learned from To review answers: a payee's category (or transfer account), and card
// and account numbers. Each can be changed or removed here.
export default function PayeeRulesScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<PayeeRule | null>(null);
  const [category, setCategory] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    const auth = { token: token ?? undefined };
    try {
      const [rules, identifiers, categories] = await Promise.all([
        apiFetch<{ rules: PayeeRule[] }>("/payee-rules", auth),
        apiFetch<{ identifiers: Identifier[] }>("/sms/identifiers", auth),
        apiFetch<CategoryList>("/transactions/categories", auth).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) throw err;
          return { income: [], expense: [] };
        }),
      ]);
      if (mine !== latest.current) return;
      setData({ rules: rules.rules, identifiers: identifiers.identifiers, categories });
      setFailed(false);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setFailed(true);
    }
  }, [token, logOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // The dialogs render above the app's lock cover, so they must not stay open when the app leaves.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busy.current) {
        setEditing(null);
        setDeleting(null);
      }
    });
    return () => subscription.remove();
  }, []);

  function startEdit(rule: PayeeRule) {
    setEditing(rule);
    setCategory(rule.category ?? "");
    setFieldError(null);
  }

  async function run(work: () => Promise<unknown>, onFieldError?: (message: string) => void): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setWorking(true);
    setNotice(null);
    try {
      await work();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else if (err instanceof ApiError && err.status === 422 && onFieldError) {
        const { fields, general } = splitErrors(err.detail, ["category", "to_account_id"]);
        onFieldError(fields.category ?? fields.to_account_id ?? general.join(" "));
      } else setNotice(err instanceof ApiError ? errorMessage({ detail: err.detail }) : "Couldn't save. Check your connection and try again.");
      return false;
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }

  async function saveCategory() {
    if (editing === null) return;
    const text = category.trim();
    if (text === "") {
      setFieldError("Choose a category, or delete the rule.");
      return;
    }
    // A rule is a category or a transfer, not both: choosing a category ends the transfer.
    const body = editing.to_account_id !== null ? { category: text, to_account_id: null } : { category: text };
    const done = await run(() => apiFetch(`/payee-rules/${editing.id}`, { method: "PATCH", token: token ?? undefined, body }), setFieldError);
    if (done) {
      setEditing(null);
      void load();
    }
  }

  async function remove(target: Deleting) {
    const path = target.kind === "rule" ? `/payee-rules/${target.rule.id}` : `/sms/identifiers/${target.identifier.id}`;
    await run(() => apiFetch(path, { method: "DELETE", token: token ?? undefined }));
    setDeleting(null);
    void load();
  }

  // Suggestions: both lists, since a rule may be for money in or out.
  const suggestions = data ? [...new Set([...data.categories.expense, ...data.categories.income])] : [];

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Payee rules" back />
      {data === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading payee rules" />
        </View>
      ) : data === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {FAILED}
          </Text>
          <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {failed ? <Banner messages={[`${FAILED} Pull down to try again.`]} /> : null}
          {notice !== null ? <Banner messages={[notice]} /> : null}

          <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
            PAYEES
          </Text>
          {data.rules.length === 0 ? (
            <Text variant="bodyMedium" style={styles.muted}>
              None yet. When you answer &quot;Always use this&quot; in To review, the payee shows up here.
            </Text>
          ) : (
            <View style={styles.list}>
              {data.rules.map((rule) => (
                <Row
                  key={rule.id}
                  emoji={rule.to_account_id !== null ? "🔁" : categoryEmoji(rule.category)}
                  tone={rule.to_account_id !== null ? "blue" : "yellow"}
                  title={rule.display}
                  meta={ruleText(rule)}
                  accessibilityLabel={`${rule.display}, ${ruleText(rule)}`}
                >
                  <View style={styles.actions}>
                    <ChunkyButton
                      compact
                      variant="alt"
                      label={rule.category === null ? "Set category" : "Change category"}
                      disabled={working}
                      onPress={() => startEdit(rule)}
                      accessibilityLabel={`Change category for ${rule.display}`}
                    />
                    <ChunkyButton
                      compact
                      variant="alt"
                      label="Delete"
                      disabled={working}
                      onPress={() => setDeleting({ kind: "rule", rule })}
                      accessibilityLabel={`Delete rule for ${rule.display}`}
                    />
                  </View>
                </Row>
              ))}
            </View>
          )}

          <Text variant="titleSmall" accessibilityRole="header" style={styles.heading}>
            CARD AND ACCOUNT NUMBERS
          </Text>
          {data.identifiers.length === 0 ? (
            <Text variant="bodyMedium" style={styles.muted}>
              None yet. When you tell Gullak which account a number belongs to, it shows up here.
            </Text>
          ) : (
            <View style={styles.list}>
              {data.identifiers.map((identifier) => (
                <Row
                  key={identifier.id}
                  emoji="🔢"
                  tone="card"
                  title={maskLast4(identifier.last4)}
                  meta={identifier.account_name}
                  accessibilityLabel={`Number ending ${identifier.last4}, ${identifier.account_name}`}
                >
                  <View style={styles.actions}>
                    <ChunkyButton
                      compact
                      variant="alt"
                      label="Delete"
                      disabled={working}
                      onPress={() => setDeleting({ kind: "number", identifier })}
                      accessibilityLabel={`Delete number ending ${identifier.last4}`}
                    />
                  </View>
                </Row>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      <Portal>
        <Dialog visible={editing !== null} onDismiss={() => (working ? undefined : setEditing(null))}>
          <Dialog.Title>{editing ? editing.display : "Category"}</Dialog.Title>
          <Dialog.ScrollArea style={styles.dialogArea}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.dialogContent}>
              {editing?.to_account_id !== null && editing ? (
                <Text variant="bodyMedium">
                  Now a transfer to {editing.to_account_name ?? "an account"}. A category makes it spending or income instead.
                </Text>
              ) : null}
              <View>
                <TextInput
                  mode="outlined"
                  label="Category"
                  value={category}
                  onChangeText={(text) => {
                    setCategory(text);
                    setFieldError(null);
                  }}
                  disabled={working}
                  error={fieldError !== null}
                  maxLength={40}
                />
                {fieldError !== null ? (
                  <HelperText type="error" visible>
                    {fieldError}
                  </HelperText>
                ) : null}
              </View>
              <View style={styles.chips}>
                {suggestions.map((c) => (
                  <Chip
                    key={c}
                    label={`${categoryEmoji(c)} ${c}`}
                    accessibilityLabel={c}
                    accessibilityRole="radio"
                    selected={category.trim().toLowerCase() === c.toLowerCase()}
                    disabled={working}
                    onPress={() => {
                      setCategory(c);
                      setFieldError(null);
                    }}
                  />
                ))}
              </View>
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setEditing(null)} disabled={working}>
              Cancel
            </Button>
            <Button onPress={() => void saveCategory()} loading={working} disabled={working}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={deleting !== null} onDismiss={() => (working ? undefined : setDeleting(null))}>
          <Dialog.Title>
            {deleting?.kind === "rule"
              ? `Delete the rule for ${deleting.rule.display}?`
              : deleting?.kind === "number"
                ? `Forget ${maskLast4(deleting.identifier.last4)}?`
                : "Delete?"}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {deleting?.kind === "number"
                ? "Messages with this number will ask which account again. Past transactions stay."
                : "New messages from this payee will ask again. Past transactions keep their category."}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleting(null)} disabled={working}>
              Cancel
            </Button>
            <Button onPress={() => deleting && void remove(deleting)} loading={working} disabled={working}>
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
  content: { padding: 16, gap: 10 },
  heading: { color: BRAND.ink, letterSpacing: 0.6, paddingTop: 6 },
  muted: { color: BRAND.zinc600 },
  list: { gap: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, paddingTop: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  dialogArea: { paddingHorizontal: 0, maxHeight: 420 },
  dialogContent: { paddingHorizontal: 24, paddingVertical: 12, gap: 12 },
});
