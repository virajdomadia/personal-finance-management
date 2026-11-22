import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, HelperText, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { DateField } from "@/components/date-field";
import { Banner } from "@/components/form-parts";
import { errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CardStatement,
  type StatementForm,
  type StatementList,
  billLines,
  blankStatementForm,
  statementForm,
  statementPayload,
} from "@/lib/card-statements";
import { formatDate } from "@/lib/dates";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { todayIndia } from "@/lib/transactions";

const FIELDS = ["statement_date", "total_due", "minimum_due", "due_date"] as const;

// A credit card's statements: where the current bill stands, what was spent since, and the
// statements themselves, which can be entered by hand, corrected or removed.
export default function CardStatementsScreen() {
  const { id, name } = useLocalSearchParams<{ id?: string; name?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [list, setList] = useState<StatementList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // null: no form open; "new": adding; a statement: correcting it.
  const [editing, setEditing] = useState<CardStatement | "new" | null>(null);
  const [form, setForm] = useState<StatementForm>(() => blankStatementForm(todayIndia()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<CardStatement | null>(null);
  const savingRef = useRef(false);

  // Leaving mid-save would drop the answer.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => savingRef.current);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let current = true;
    apiFetch<StatementList>(`/accounts/${id}/statements`, { token: token ?? undefined })
      .then((found) => {
        if (current) setList(found);
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
  }, [id, token, logOut, attempt]);

  const open = (target: CardStatement | "new") => {
    setEditing(target);
    setForm(target === "new" ? blankStatementForm(todayIndia()) : statementForm(target));
    setErrors({});
    setGeneral([]);
  };

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaving(true);
      setErrors({});
      setGeneral([]);
      try {
        await action();
        setEditing(null);
        setDeleting(null);
        setAttempt((n) => n + 1);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
        } else if (err instanceof ApiError && err.status === 422) {
          const result = splitErrors(err.detail, FIELDS);
          setErrors(result.fields);
          setGeneral(result.general);
        } else {
          setDeleting(null);
          setGeneral([errorMessage(err)]);
        }
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [logOut],
  );

  const save = () => {
    const body = statementPayload(form);
    const auth = { token: token ?? undefined, body };
    void run(() =>
      editing === "new" || editing === null
        ? apiFetch(`/accounts/${id}/statements`, { method: "POST", ...auth })
        : apiFetch(`/card-statements/${editing.id}`, { method: "PATCH", ...auth }),
    );
  };

  const title = name ? `${name} statements` : "Statements";
  const header = <ScreenHeader title={title} back backDisabled={saving} />;

  if (list === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        {header}
        <View style={styles.center}>
          {loadError === null ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {loadError}
              </Text>
              <ChunkyButton
                label="Try again"
                onPress={() => {
                  setLoadError(null);
                  setAttempt((n) => n + 1);
                }}
              />
            </>
          )}
        </View>
      </View>
    );
  }

  const current = list.current;
  const today = todayIndia();
  const money = (key: "total_due" | "minimum_due", label: string) => (
    <View>
      <TextInput
        mode="outlined"
        label={label}
        value={form[key]}
        onChangeText={(text) => setForm((f) => ({ ...f, [key]: text }))}
        error={Boolean(errors[key])}
        disabled={saving}
        keyboardType="numeric"
        maxLength={24}
        autoComplete="off"
        importantForAutofill="no"
        autoCorrect={false}
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
      {header}
      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          <Banner messages={general} />

          <ChunkyBox radius={14} offset={3} style={styles.box}>
            {current ? (
              <>
                <Text variant="labelLarge">Statement of {formatDate(current.statement.statement_date)}</Text>
                {billLines(current).map((line, i) => (
                  <Text
                    key={line}
                    variant={i === 0 ? "titleSmall" : "bodyMedium"}
                    style={i === 0 ? (current.overdue ? { color: BRAND.loss } : undefined) : { color: BRAND.zinc600 }}
                  >
                    {line}
                  </Text>
                ))}
              </>
            ) : (
              <Text variant="bodyMedium">No statement yet. Add one when it arrives.</Text>
            )}
            <Text variant="bodyMedium" style={{ color: BRAND.zinc600 }}>
              Spent since {current ? "the statement" : "the start"}: {formatRupees(list.unbilled)}
            </Text>
          </ChunkyBox>

          {editing === null ? (
            <ChunkyButton label="Add statement" icon="plus" onPress={() => open("new")} />
          ) : (
            <ChunkyBox radius={14} offset={3} style={styles.box}>
              <Text variant="titleSmall">{editing === "new" ? "New statement" : "Correct statement"}</Text>
              <DateField
                label="Statement date"
                value={form.statement_date}
                onChange={(iso) => setForm((f) => ({ ...f, statement_date: iso }))}
                disabled={saving}
                maxDate={today}
                error={errors.statement_date}
              />
              {money("total_due", "Total due (₹)")}
              {money("minimum_due", "Minimum due (₹, optional)")}
              <DateField
                label="Due date"
                value={form.due_date}
                onChange={(iso) => setForm((f) => ({ ...f, due_date: iso }))}
                disabled={saving}
                error={errors.due_date}
              />
              <View style={styles.row}>
                <ChunkyButton variant="alt" label="Cancel" onPress={() => setEditing(null)} disabled={saving} />
                <ChunkyButton label={saving ? "Saving..." : "Save"} onPress={save} loading={saving} />
              </View>
            </ChunkyBox>
          )}

          {list.statements.map((s) => (
            <View key={s.id} style={styles.statement}>
              <View style={styles.statementText}>
                <Text variant="bodyLarge">
                  {formatDate(s.statement_date)} · {formatRupees(s.total_due)}
                  {s.source === "sms" ? "  · from SMS" : ""}
                </Text>
                <Text variant="bodySmall" style={{ color: BRAND.zinc600 }}>
                  Due {formatDate(s.due_date)}
                  {s.minimum_due !== null ? ` · minimum ${formatRupees(s.minimum_due)}` : ""}
                </Text>
              </View>
              <View style={styles.row}>
                <ChunkyButton
                  compact
                  variant="alt"
                  label="Edit"
                  accessibilityLabel={`Correct the statement of ${formatDate(s.statement_date)}`}
                  onPress={() => open(s)}
                  disabled={saving}
                />
                <ChunkyButton
                  compact
                  variant="alt"
                  label="Delete"
                  accessibilityLabel={`Delete the statement of ${formatDate(s.statement_date)}`}
                  onPress={() => setDeleting(s)}
                  disabled={saving}
                />
              </View>
            </View>
          ))}
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={deleting !== null} onDismiss={() => (saving ? undefined : setDeleting(null))}>
          <Dialog.Title>Delete this statement?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {deleting ? `The statement of ${formatDate(deleting.statement_date)} is removed. ` : ""}
              This can&apos;t be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleting(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onPress={() => {
                if (deleting) void run(() => apiFetch(`/card-statements/${deleting.id}`, { method: "DELETE", token: token ?? undefined }));
              }}
              loading={saving}
              disabled={saving}
            >
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
  box: { padding: 12, gap: 8 },
  row: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  statement: { gap: 6, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: BRAND.zinc600 },
  statementText: { gap: 2 },
});
