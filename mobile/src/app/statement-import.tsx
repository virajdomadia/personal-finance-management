import { router, useFocusEffect } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Button, Checkbox, Dialog, HelperText, Icon, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CategoryChips } from "@/components/category-chips";
import { ChunkyBox, ChunkyButton, Chip, HeaderAction, ScreenHeader, Tag } from "@/components/chunky";
import { Banner, Heading, LoadingScreen } from "@/components/form-parts";
import { type Account, type AccountList, TYPE_LABELS, errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch, apiUpload } from "@/lib/api";
import { CATEGORIES_PATH, type CategoryTree, EMPTY_TREE, pickerGroups } from "@/lib/categories";
import { formatDate } from "@/lib/dates";
import { pickErrorMessage, pickFile } from "@/lib/file-pick";
import { useSession } from "@/lib/session";
import {
  EXTENSIONS,
  PASSWORD_HEADER,
  PICKER_TYPES,
  type Row,
  type RowFilter,
  SAVE_PATH,
  type SaveResult,
  type StatementPreview,
  WRONG_FILE,
  canKeep,
  canSave,
  categoryNames,
  categoryOptions,
  changeType,
  counts,
  errorsByLine,
  fileType,
  filterOptions,
  importButton,
  initialRows,
  missingTransfers,
  missingTransfersText,
  offersRemember,
  otherAccounts,
  passwordProblem,
  previewFailure,
  previewPath,
  rowSummary,
  saveErrorsBanner,
  savePayload,
  savedMessage,
  selectAllNew,
  selectNone,
  signedAmount,
  beforeStartNote,
  statementAccounts,
  summaryText,
  transferLabel,
  typeOptions,
  visibleRows,
} from "@/lib/statement-import";
import { BRAND } from "@/lib/theme";

type Busy = "pick" | "preview" | "save" | null;
type Picked = { name: string; mimeType: string | null };
type Loaded = { accounts: Account[]; categories: CategoryTree };
type PasswordAsk = { wrong: boolean; message: string };

const NO_ERRORS = new Map<number, string[]>();

// Import a statement: choose the account and the file (and its password, for a locked PDF), then
// check every line the server read, fix types and categories, and save the ticked ones in one go.
export default function StatementImportScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [accountId, setAccountId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const bytes = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const [ask, setAsk] = useState<PasswordAsk | null>(null);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [busy, setBusy] = useState<Busy>(null);
  const busyRef = useRef(false);
  const [errors, setErrors] = useState<string[]>([]);

  const [step, setStep] = useState<"choose" | "review">("choose");
  const [previewAccount, setPreviewAccount] = useState<number | null>(null);
  const [startNote, setStartNote] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<RowFilter>("all");
  const [editing, setEditing] = useState<number | null>(null); // a line number
  const [lineErrors, setLineErrors] = useState<Map<number, string[]>>(NO_ERRORS);
  const [saved, setSaved] = useState<string | null>(null);
  const listRef = useRef<FlatList<Row>>(null);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    Promise.all([
      apiFetch<AccountList>("/accounts", auth),
      // Only the choices for a category: without them a line can still be saved uncategorised.
      apiFetch<CategoryTree>(CATEGORIES_PATH, auth).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) throw err;
        return EMPTY_TREE;
      }),
    ])
      .then(([accounts, categories]) => {
        if (!current) return;
        setLoaded({ accounts: accounts.accounts, categories });
        const choices = statementAccounts(accounts.accounts);
        if (choices.length === 1) setAccountId((id) => id ?? choices[0].id);
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
  }, [token, logOut, attempt]);

  // Back from the review goes to the first step, keeping the file; never mid-save.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (busyRef.current) return true;
        if (step === "review") {
          setEditing(null);
          setStep("choose");
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [step]),
  );

  const accounts = useMemo(() => loaded?.accounts ?? [], [loaded]);
  const names = useMemo(() => new Map(accounts.map((a) => [String(a.id), a.name])), [accounts]);
  const accountName = useCallback((id: string) => names.get(id) ?? null, [names]);
  const shown = useMemo(() => visibleRows(rows, filter), [rows, filter]);
  const filters = useMemo(() => filterOptions(rows), [rows]);
  const tally = useMemo(() => counts(rows), [rows]);
  const missing = useMemo(() => missingTransfers(rows), [rows]);

  const updateRow = useCallback((line: number, change: (row: Row) => Row) => {
    setRows((list) => list.map((r) => (r.line.line === line ? change(r) : r)));
  }, []);
  const toggle = useCallback(
    (line: number) => updateRow(line, (r) => (canKeep(r.line) ? { ...r, include: !r.include } : r)),
    [updateRow],
  );
  const open = useCallback((line: number) => setEditing(line), []);

  if (loaded === null) {
    return (
      <LoadingScreen
        title="Import a statement"
        error={loadError}
        onRetry={() => {
          setLoadError(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }

  const choices = statementAccounts(accounts);
  const working = busy !== null;

  const begin = (what: Exclude<Busy, null>): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(what);
    setErrors([]);
    return true;
  };
  const finish = () => {
    busyRef.current = false;
    setBusy(null);
  };

  const chooseFile = async () => {
    if (!begin("pick")) return;
    try {
      const file = await pickFile(PICKER_TYPES, EXTENSIONS, WRONG_FILE);
      if (file === null) return;
      bytes.current = file.bytes;
      setPicked({ name: file.name, mimeType: file.mimeType });
      setAsk(null);
      setPassword("");
      setPasswordError(null);
    } catch (err) {
      setErrors([pickErrorMessage(err)]);
    } finally {
      finish();
    }
  };

  const readStatement = async () => {
    if (accountId === null || picked === null || bytes.current === null) return;
    if (ask !== null) {
      const problem = passwordProblem(password);
      setPasswordError(problem);
      if (problem) return;
    }
    if (!begin("preview")) return;
    try {
      const preview = await apiUpload<StatementPreview>(previewPath(accountId), {
        token: token ?? undefined,
        bytes: bytes.current,
        contentType: fileType(picked.mimeType),
        headers: ask !== null && password ? { [PASSWORD_HEADER]: password } : {},
      });
      setRows(initialRows(preview));
      setPreviewAccount(preview.account_id);
      setStartNote(beforeStartNote(preview));
      setFilter("all");
      setLineErrors(NO_ERRORS);
      setEditing(null);
      setStep("review");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      const failure =
        err instanceof ApiError ? previewFailure(err.status, err.body ?? { detail: err.detail }) : previewFailure(500, undefined);
      if (failure.kind === "password") {
        setAsk({ wrong: failure.wrong, message: failure.message });
        setPasswordError(failure.wrong ? failure.message : null);
      } else {
        setErrors([failure.message]);
      }
    } finally {
      finish();
    }
  };

  const save = async () => {
    if (previewAccount === null || !canSave(rows)) return;
    if (!begin("save")) return;
    setLineErrors(NO_ERRORS);
    try {
      const result = await apiFetch<SaveResult>(SAVE_PATH, {
        method: "POST",
        token: token ?? undefined,
        body: savePayload(previewAccount, rows),
      });
      if (result.errors.length > 0) {
        // Nothing was saved: each line's problem goes on its card.
        setLineErrors(errorsByLine(result));
        setErrors([saveErrorsBanner(result)]);
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
        return;
      }
      setSaved(savedMessage(result));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      const message = err instanceof ApiError && typeof err.detail === "string" ? err.detail : errorMessage(err);
      setErrors([message]);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } finally {
      finish();
    }
  };

  const savedDialog = (
    <Portal>
      <Dialog visible={saved !== null} dismissable={false}>
        <Dialog.Title>Statement imported</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodyMedium" accessibilityLiveRegion="polite">
            {saved}
          </Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button
            onPress={() => {
              setSaved(null);
              router.back();
            }}
          >
            Done
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );

  if (step === "choose") {
    const canRead = accountId !== null && picked !== null && !working;
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Import a statement" back backDisabled={working} />
        <KeyboardAvoidingView style={styles.screen} behavior="padding">
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
          >
            <Text variant="bodyMedium" style={styles.muted}>
              Download the statement from your bank or card&apos;s website or app (CSV, Excel or PDF) and choose it here. You&apos;ll
              check every line before anything is saved, and lines already saved are left out.
            </Text>
            <Banner messages={errors} />

            <View>
              <Heading label="Account" />
              {choices.length === 0 ? (
                <Text variant="bodyMedium" style={[styles.muted, styles.gapTop]}>
                  Add a bank, credit card, cash, wallet or broker account first.
                </Text>
              ) : (
                <View style={styles.chips} accessibilityRole="radiogroup">
                  {choices.map((a) => (
                    <Chip
                      key={a.id}
                      label={a.name}
                      selected={accountId === a.id}
                      disabled={working}
                      accessibilityRole="radio"
                      accessibilityLabel={`${a.name}, ${TYPE_LABELS[a.type]}`}
                      onPress={() => setAccountId(a.id)}
                    />
                  ))}
                </View>
              )}
            </View>

            <View style={styles.gap}>
              <Heading label="Statement file" />
              {picked ? (
                <Text variant="bodyMedium" numberOfLines={2} style={styles.ink}>
                  {picked.name}
                </Text>
              ) : (
                <Text variant="bodyMedium" style={styles.muted}>
                  A .csv, .xls, .xlsx or .pdf file, up to 4 MB.
                </Text>
              )}
              <ChunkyButton
                label={picked ? "Choose another file" : "Choose a file"}
                icon="file-upload-outline"
                variant="alt"
                onPress={() => void chooseFile()}
                loading={busy === "pick"}
                disabled={working}
              />
            </View>

            {ask !== null ? (
              <View>
                <Text variant="bodyMedium" style={styles.ink}>
                  {ask.wrong ? "This file is locked with a password." : ask.message}
                </Text>
                <TextInput
                  mode="outlined"
                  label="File password"
                  value={password}
                  onChangeText={(text) => {
                    setPassword(text);
                    setPasswordError(null);
                  }}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  importantForAutofill="no"
                  maxLength={200}
                  disabled={working}
                  error={passwordError !== null}
                  onSubmitEditing={() => void readStatement()}
                  style={styles.gapTop}
                />
                <HelperText type={passwordError ? "error" : "info"} visible>
                  {passwordError ?? "Often your date of birth or customer ID"}
                </HelperText>
              </View>
            ) : null}

            <ChunkyButton
              label={busy === "preview" ? "Reading..." : "Read the statement"}
              onPress={() => void readStatement()}
              loading={busy === "preview"}
              disabled={!canRead}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  const accountLabel = names.get(String(previewAccount)) ?? "the account";
  const editingRow = editing === null ? null : (rows.find((r) => r.line.line === editing) ?? null);
  const blocked = missingTransfersText(missing);

  const listHeader = (
    <View style={styles.listHeader}>
      <Text variant="bodyMedium" style={styles.muted} numberOfLines={2}>
        {picked?.name} into {accountLabel}. Tap a line to change its type, category or transfer.
      </Text>
      {startNote ? (
        <Text variant="bodyMedium" style={styles.muted}>
          {startNote}
        </Text>
      ) : null}
      <Banner messages={errors} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow} keyboardShouldPersistTaps="handled">
        {filters.map((f) => (
          <Chip key={f.value} label={f.label} selected={filter === f.value} accessibilityRole="radio" onPress={() => setFilter(f.value)} />
        ))}
      </ScrollView>
      <View style={styles.selectRow}>
        <ChunkyButton compact variant="alt" label="Select all new" disabled={working} onPress={() => setRows(selectAllNew)} />
        <ChunkyButton compact variant="alt" label="Select none" disabled={working} onPress={() => setRows(selectNone)} />
      </View>
      {shown.length === 0 ? (
        <Text variant="bodyMedium" style={[styles.muted, styles.empty]}>
          No lines here.
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Check the lines"
        back
        backDisabled={working}
        right={
          <HeaderAction
            icon="file-replace-outline"
            label="Choose another file"
            disabled={working}
            onPress={() => {
              setEditing(null);
              setStep("choose");
            }}
          />
        }
      />
      <FlatList
        ref={listRef}
        data={shown}
        keyExtractor={(r) => String(r.line.line)}
        renderItem={({ item }) => (
          <LineCard
            row={item}
            summary={rowSummary(item, accountName)}
            errors={lineErrors.get(item.line.line)}
            disabled={working}
            onToggle={toggle}
            onOpen={open}
          />
        )}
        ListHeaderComponent={listHeader}
        contentContainerStyle={{ paddingBottom: 16 }}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={11}
        removeClippedSubviews
      />
      <View style={[styles.bar, { paddingBottom: insets.bottom + 12 }]}>
        <Text variant="labelLarge" accessibilityLiveRegion="polite" style={styles.ink}>
          {summaryText(tally)}
        </Text>
        {blocked ? (
          <Text variant="bodySmall" style={styles.error}>
            {blocked}
          </Text>
        ) : null}
        <ChunkyButton
          label={busy === "save" ? "Importing..." : importButton(tally)}
          onPress={() => void save()}
          loading={busy === "save"}
          disabled={!canSave(rows) || (working && busy !== "save")}
        />
      </View>

      {editingRow && previewAccount !== null ? (
        <LineEditor
          row={editingRow}
          accounts={otherAccounts(accounts, previewAccount)}
          categories={loaded.categories}
          onChange={(change) => updateRow(editingRow.line.line, change)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {savedDialog}
    </View>
  );
}

type CardProps = {
  row: Row;
  summary: string;
  errors: string[] | undefined; // from a save that was refused
  disabled: boolean;
  onToggle: (line: number) => void;
  onOpen: (line: number) => void;
};

// One line of the statement. The box ticks it in or out; the rest opens the editor.
const LineCard = memo(function LineCard({ row, summary, errors, disabled, onToggle, onOpen }: CardProps) {
  const { line } = row;
  const keep = canKeep(line);
  const amount = signedAmount(line);
  const problems = [...line.errors, ...(errors ?? [])];
  const title = line.payee || line.narration;
  return (
    <View style={styles.cardWrap}>
      <ChunkyBox radius={14} offset={3} style={[styles.card, !row.include ? styles.cardOff : null]}>
        <View style={styles.cardRow}>
          <Checkbox.Android
            status={row.include && keep ? "checked" : "unchecked"}
            disabled={!keep || disabled}
            onPress={() => onToggle(line.line)}
            color={BRAND.ink}
            accessibilityLabel={`Import ${title}, ${amount}`}
          />
          <Pressable
            onPress={() => onOpen(line.line)}
            disabled={!keep || disabled}
            accessibilityRole="button"
            accessibilityLabel={`${formatDate(line.date)}, ${title}, ${amount}, ${keep ? summary : "can't be imported"}`}
            accessibilityHint={keep ? "Changes its type, category or transfer" : undefined}
            style={styles.cardBody}
          >
            <View style={styles.cardTop}>
              <Text variant="labelMedium" style={styles.muted}>
                {formatDate(line.date)}
              </Text>
              <Text
                variant="titleSmall"
                style={[styles.amount, { color: line.direction === "out" ? BRAND.loss : BRAND.gain }]}
              >
                {amount}
              </Text>
            </View>
            {line.payee ? (
              <Text variant="titleSmall" numberOfLines={1} style={styles.ink}>
                {line.payee}
              </Text>
            ) : null}
            <Text variant="bodySmall" numberOfLines={2} style={styles.muted}>
              {line.narration}
            </Text>
            {keep ? (
              <View style={styles.summaryRow}>
                <Icon source="pencil-outline" size={14} color={BRAND.zinc600} />
                <Text variant="labelMedium" numberOfLines={1} style={[styles.ink, styles.flex]}>
                  {summary}
                </Text>
                {line.duplicate ? <Tag label="Already saved" tone="due" /> : null}
              </View>
            ) : (
              <Text variant="labelMedium" style={styles.error}>
                Can&apos;t be imported
              </Text>
            )}
            {problems.map((e, i) => (
              <Text key={i} variant="bodySmall" style={styles.error}>
                {e}
              </Text>
            ))}
          </Pressable>
        </View>
      </ChunkyBox>
    </View>
  );
});

type EditorProps = {
  row: Row;
  accounts: Account[]; // the other side of a transfer
  categories: CategoryTree;
  onChange: (change: (row: Row) => Row) => void;
  onClose: () => void;
};

// A line's type, category or other account, and whether to remember it for the payee. Changes apply
// as they're made; Done closes it.
function LineEditor({ row, accounts, categories, onChange, onClose }: EditorProps) {
  const { height } = useWindowDimensions();
  const { line } = row;
  const kind = row.type === "transfer" ? null : row.type;
  const names = useMemo(() => categoryNames(categories), [categories]);
  const groups = useMemo(() => (kind ? pickerGroups(categories[kind]) : []), [categories, kind]);
  const extras = kind ? categoryOptions(row, names).filter((n) => !names[kind].includes(n)) : [];
  const remember = offersRemember(row);

  return (
    <Portal>
      <Dialog visible onDismiss={onClose}>
        <Dialog.Title numberOfLines={2}>{line.payee || "Edit line"}</Dialog.Title>
        <Dialog.ScrollArea style={{ maxHeight: height * 0.6, paddingHorizontal: 0 }}>
          <ScrollView contentContainerStyle={styles.editor} keyboardShouldPersistTaps="handled">
            <Text variant="bodyMedium" style={styles.muted}>
              {formatDate(line.date)} · <Text style={{ color: line.direction === "out" ? BRAND.loss : BRAND.gain }}>{signedAmount(line)}</Text>
            </Text>
            <Text variant="bodySmall" numberOfLines={3} style={styles.muted}>
              {line.narration}
            </Text>

            <View>
              <Heading label="Type" />
              <View style={styles.chips} accessibilityRole="radiogroup">
                {typeOptions(line.direction).map((o) => (
                  <Chip
                    key={o.value}
                    label={o.label}
                    selected={row.type === o.value}
                    accessibilityRole="radio"
                    onPress={() => onChange((r) => (r.type === o.value ? r : changeType(r, o.value)))}
                  />
                ))}
              </View>
            </View>

            {row.type === "transfer" ? (
              <View>
                <Heading label={transferLabel(line.direction)} />
                {accounts.length === 0 ? (
                  <Text variant="bodyMedium" style={[styles.muted, styles.gapTop]}>
                    You have no other account to transfer with.
                  </Text>
                ) : (
                  <View style={styles.chips} accessibilityRole="radiogroup">
                    {accounts.map((a) => (
                      <Chip
                        key={a.id}
                        label={a.name}
                        selected={row.other === String(a.id)}
                        accessibilityRole="radio"
                        onPress={() => onChange((r) => ({ ...r, other: String(a.id) }))}
                      />
                    ))}
                  </View>
                )}
              </View>
            ) : (
              <View>
                <Heading label="Category" />
                <CategoryChips
                  groups={groups}
                  selected={(name) => row.category === name}
                  onPick={(name) => onChange((r) => ({ ...r, category: name }))}
                  before={
                    <View key="before" style={styles.inlineChips}>
                      <Chip
                        label="No category"
                        selected={row.category === ""}
                        accessibilityRole="radio"
                        onPress={() => onChange((r) => ({ ...r, category: "" }))}
                      />
                      {extras.map((name) => (
                        <Chip
                          key={name}
                          label={name}
                          selected={row.category === name}
                          accessibilityRole="radio"
                          onPress={() => onChange((r) => ({ ...r, category: name }))}
                        />
                      ))}
                    </View>
                  }
                />
              </View>
            )}

            {remember ? (
              <Checkbox.Item
                mode="android"
                position="leading"
                status={row.remember ? "checked" : "unchecked"}
                onPress={() => onChange((r) => ({ ...r, remember: !r.remember }))}
                label={`Remember for this payee (${line.payee})`}
                labelVariant="bodyMedium"
                color={BRAND.ink}
                style={styles.remember}
              />
            ) : null}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button onPress={onClose}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  content: { padding: 16, gap: 16 },
  gap: { gap: 8 },
  gapTop: { marginTop: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  inlineChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  muted: { color: BRAND.zinc600 },
  ink: { color: BRAND.ink },
  error: { color: BRAND.loss },
  empty: { textAlign: "center", paddingVertical: 24 },
  listHeader: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, gap: 12 },
  filterRow: { gap: 8, paddingVertical: 4, paddingRight: 16 },
  selectRow: { flexDirection: "row", gap: 8 },
  cardWrap: { paddingHorizontal: 16, paddingBottom: 10 },
  card: { paddingVertical: 8, paddingRight: 12, paddingLeft: 4 },
  cardOff: { backgroundColor: BRAND.zinc100 },
  cardRow: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  cardBody: { flex: 1, minWidth: 0, gap: 2, paddingTop: 6 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  amount: { fontVariant: ["tabular-nums"] },
  editor: { paddingHorizontal: 24, paddingVertical: 12, gap: 16 },
  remember: { paddingHorizontal: 0 },
  bar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 8,
    borderTopWidth: 2.5,
    borderTopColor: BRAND.ink,
    backgroundColor: BRAND.bg,
  },
});
