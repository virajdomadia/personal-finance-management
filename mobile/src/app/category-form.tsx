import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, Icon, Portal, RadioButton, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader, Segmented } from "@/components/chunky";
import { CategoryIcon } from "@/components/category-icon";
import { Banner, Choice, Heading, LoadingScreen, useBlockBack, useFieldScroll } from "@/components/form-parts";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  CATEGORIES_PATH,
  CATEGORY_KINDS,
  CATEGORY_PALETTE,
  type Category,
  type CategoryForm,
  type CategoryKind,
  type CategoryTree,
  type MergeResult,
  categoryErrors,
  categoryFormBlank,
  categoryFormFrom,
  categoryPayload,
  colourOf,
  inkOn,
  mergeTargets,
  mergedText,
  parentOptions,
  usageText,
} from "@/lib/categories";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const RENDERED = ["kind", "name", "icon", "colour", "parent_id"];

type Loaded = { tree: CategoryTree; category: Category | null; kind: CategoryKind };

export default function CategoryFormScreen() {
  const { id, kind } = useLocalSearchParams<{ id?: string; kind?: string }>();
  const { token, logOut } = useSession();
  const editing = id !== undefined;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    apiFetch<CategoryTree>(CATEGORIES_PATH, { token: token ?? undefined })
      .then((tree) => {
        if (!current) return;
        const category = editing ? ([...tree.expense, ...tree.income].find((c) => String(c.id) === id) ?? null) : null;
        if (editing && category === null) {
          setLoadError("This category was not found. It may have been merged into another.");
          return;
        }
        setLoaded({ tree, category, kind: category?.kind ?? (kind === "income" ? "income" : "expense") });
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return;
        }
        setLoadError(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
      });
    return () => {
      current = false;
    };
  }, [editing, id, kind, token, logOut, attempt]);

  if (loaded === null) {
    return (
      <LoadingScreen
        title={editing ? "Edit category" : "New category"}
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

type MergeStep = "pick" | "confirm" | "done" | null;

function FormBody({ tree, category, kind: startKind }: Loaded) {
  const editing = category !== null;
  const fixed = category?.fixed ?? false;
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<CategoryForm>(() => (category ? categoryFormFrom(category) : categoryFormBlank(startKind)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string[]>([]);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "archive" | "merge" | null>(null);
  const [mergeStep, setMergeStep] = useState<MergeStep>(null);
  const [target, setTarget] = useState<Category | null>(null);
  const [merged, setMerged] = useState<MergeResult | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const { scrollRef, scrollTo, field } = useFieldScroll();
  const locked = busy !== null || conflict !== null;

  useBlockBack(useCallback(() => busyRef.current, []));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The dialogs render above the app's lock cover, so they must not stay open when the app leaves.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busyRef.current) setMergeStep((step) => (step === "done" ? step : null));
    });
    return () => subscription.remove();
  }, []);

  const list = tree[form.kind];
  const parents = parentOptions(list, category, form.kind);
  const hasChildren = category !== null && list.some((c) => c.parent_id === category.id);
  const targets = category ? mergeTargets(list, category) : [];
  const palette = form.colour !== null && !CATEGORY_PALETTE.includes(form.colour) ? [form.colour, ...CATEGORY_PALETTE] : CATEGORY_PALETTE;

  const showErrors = (fields: Record<string, string>, messages: string[]) => {
    setErrors(fields);
    setGeneral(messages);
    scrollTo(RENDERED.find((key) => fields[key]));
  };

  // Runs one request at a time; failures land on the form in the server's words.
  async function run(kind: "save" | "archive" | "merge", request: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    setErrors({});
    setGeneral([]);
    let done = false;
    try {
      await request();
      done = true;
    } catch (err) {
      setMergeStep(null);
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 404) {
        setConflict(errorMessage({ detail: err.detail }));
        scrollTo();
      } else if (err instanceof ApiError && err.status === 422) {
        const result = splitErrors(err.detail, RENDERED);
        showErrors(result.fields, result.general);
      } else {
        showErrors({}, [errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      if (!done) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }

  const save = () => {
    const payload = categoryPayload(form, category);
    if (editing && Object.keys(payload).length === 0) {
      router.back();
      return;
    }
    const found = fixed ? {} : categoryErrors(form);
    if (Object.keys(found).length > 0) {
      showErrors(found, []);
      return;
    }
    void run("save", async () => {
      const auth = { token: token ?? undefined, body: payload };
      if (category) await apiFetch(`${CATEGORIES_PATH}/${category.id}`, { method: "PATCH", ...auth });
      else await apiFetch(CATEGORIES_PATH, { method: "POST", ...auth });
      if (mounted.current) router.back();
    });
  };

  const toggleArchive = () => {
    if (!category) return;
    void run("archive", async () => {
      await apiFetch(`${CATEGORIES_PATH}/${category.id}`, {
        method: "PATCH",
        token: token ?? undefined,
        body: { archived: !category.archived },
      });
      if (mounted.current) router.back();
    });
  };

  const merge = () => {
    if (!category || !target) return;
    void run("merge", async () => {
      const result = await apiFetch<MergeResult>(`${CATEGORIES_PATH}/${category.id}/merge`, {
        method: "POST",
        token: token ?? undefined,
        body: { into_id: target.id },
      });
      if (!mounted.current) return;
      // The category is gone now; the result says what moved, and OK leaves.
      setMerged(result);
      setMergeStep("done");
    });
  };

  const set = <K extends keyof CategoryForm>(key: K, value: CategoryForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const changeKind = (next: CategoryKind) => {
    if (next === form.kind) return;
    setErrors({});
    setForm((f) => ({ ...f, kind: next, parent_id: null }));
  };

  const mergeText = category && target
    ? `Everything in ${category.name} (${usageText(category.transaction_count).toLowerCase()}), with its reminders and payee rules, moves to ${target.name}${hasChildren ? `, and its subcategories go inside ${target.name}` : ""}. ${category.name} goes away. This can't be undone.`
    : "";

  const title = editing ? "Edit category" : "New category";

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={title} back backDisabled={busy !== null} />

      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {conflict !== null ? (
            <ChunkyBox radius={14} offset={3} style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
              <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                {conflict}
              </Text>
              <ChunkyButton label="Back to categories" onPress={() => router.back()} />
            </ChunkyBox>
          ) : null}
          <Banner messages={general} />

          <View style={styles.preview}>
            <CategoryIcon icon={form.icon} colour={form.colour} size={52} />
            <View style={styles.previewText}>
              <Text variant="titleLarge" style={styles.ink}>
                {form.name.trim() || "New category"}
              </Text>
              {category ? (
                <Text variant="bodySmall" style={styles.muted}>
                  {usageText(category.transaction_count)}
                  {category.archived ? " · archived" : ""}
                </Text>
              ) : null}
            </View>
          </View>

          {editing
            ? null
            : field(
                "kind",
                <>
                  <Heading label="Kind" />
                  <View style={styles.gap}>
                    <Segmented label="Kind" value={form.kind} onChange={changeKind} options={CATEGORY_KINDS} />
                  </View>
                </>,
                errors.kind,
              )}

          {fixed ? (
            <Text variant="bodyMedium" style={styles.muted}>
              {category?.name} is used by the app itself, so it keeps its name and can&apos;t be archived or merged.
            </Text>
          ) : (
            field(
              "name",
              <TextInput
                mode="outlined"
                label="Name"
                value={form.name}
                onChangeText={(text) => set("name", text)}
                error={Boolean(errors.name)}
                disabled={locked}
                maxLength={40}
                autoComplete="off"
                importantForAutofill="no"
              />,
              errors.name,
            )
          )}

          {field(
            "icon",
            <>
              <Heading label="Icon" />
              <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel="Icon">
                {tree.icons.map((key) => {
                  const on = form.icon === key;
                  return (
                    <Pressable
                      key={key}
                      onPress={() => set("icon", key)}
                      disabled={locked}
                      accessibilityRole="radio"
                      accessibilityLabel={key}
                      accessibilityState={{ selected: on, checked: on, disabled: locked }}
                      style={[styles.iconCell, on ? styles.cellOn : null]}
                    >
                      <CategoryIcon icon={key} colour={on ? form.colour : BRAND.card} size={40} />
                    </Pressable>
                  );
                })}
              </View>
            </>,
            errors.icon,
          )}

          {field(
            "colour",
            <>
              <Heading label="Colour" />
              <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel="Colour">
                {palette.map((hex) => {
                  const on = form.colour === hex;
                  return (
                    <Pressable
                      key={hex}
                      onPress={() => set("colour", hex)}
                      disabled={locked}
                      accessibilityRole="radio"
                      accessibilityLabel={`Colour ${hex}`}
                      accessibilityState={{ selected: on, checked: on, disabled: locked }}
                      style={[styles.swatchCell, on ? styles.cellOn : null]}
                    >
                      <View style={[styles.swatch, { backgroundColor: colourOf(hex) }]}>
                        {on ? <Icon source="check-bold" size={18} color={inkOn(hex) ? BRAND.ink : "#FFFFFF"} /> : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </>,
            errors.colour,
          )}

          {field(
            "parent_id",
            <>
              <Heading label="Inside" />
              {hasChildren ? (
                <Text variant="bodySmall" style={[styles.muted, styles.gap]}>
                  It has subcategories of its own, so it stays at the top level.
                </Text>
              ) : (
                <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Inside">
                  <Choice label="None (top level)" selected={form.parent_id === null} disabled={locked} onPress={() => set("parent_id", null)} />
                  {parents.map((p) => (
                    <Choice key={p.id} label={p.name} selected={form.parent_id === p.id} disabled={locked} onPress={() => set("parent_id", p.id)} />
                  ))}
                </View>
              )}
            </>,
            errors.parent_id,
          )}

          <ChunkyButton
            variant="green"
            label={busy === "save" ? "Saving..." : editing ? "Save ✓" : "Add ✓"}
            accessibilityLabel={busy === "save" ? "Saving" : editing ? "Save changes" : "Add category"}
            onPress={save}
            loading={busy === "save"}
            disabled={locked && busy !== "save"}
            style={styles.save}
          />

          {category && !fixed ? (
            <View style={styles.actions}>
              {category.archived ? null : (
                <ChunkyButton
                  variant="alt"
                  icon="call-merge"
                  label="Merge into…"
                  onPress={() => {
                    setTarget(null);
                    setMergeStep("pick");
                  }}
                  disabled={locked || targets.length === 0}
                />
              )}
              <ChunkyButton
                variant={category.archived ? "alt" : "pink"}
                icon={category.archived ? "archive-arrow-up-outline" : "archive-outline"}
                label={busy === "archive" ? "Working..." : category.archived ? "Restore" : "Archive"}
                onPress={toggleArchive}
                loading={busy === "archive"}
                disabled={locked && busy !== "archive"}
              />
              <Text variant="bodySmall" style={styles.muted}>
                {category.archived
                  ? "Restoring offers it again when you pick a category."
                  : "Archiving keeps its transactions but stops offering it when you pick a category."}
              </Text>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={mergeStep === "pick"} onDismiss={() => setMergeStep(null)}>
          <Dialog.Title>Merge {category?.name} into…</Dialog.Title>
          <Dialog.ScrollArea style={styles.dialogList}>
            <ScrollView>
              <RadioButton.Group value={target === null ? "" : String(target.id)} onValueChange={(v) => setTarget(targets.find((c) => String(c.id) === v) ?? null)}>
                {targets.map((c) => (
                  <RadioButton.Item key={c.id} value={String(c.id)} label={c.parent_id === null ? c.name : `  ${c.name}`} />
                ))}
              </RadioButton.Group>
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setMergeStep(null)}>Cancel</Button>
            <Button onPress={() => setMergeStep("confirm")} disabled={target === null}>
              Next
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={mergeStep === "confirm"} onDismiss={() => (busy === "merge" ? undefined : setMergeStep(null))}>
          <Dialog.Title>Merge into {target?.name}?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {mergeText}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setMergeStep("pick")} disabled={busy === "merge"}>
              Back
            </Button>
            <Button onPress={merge} loading={busy === "merge"} disabled={busy === "merge"}>
              Merge
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={mergeStep === "done"} dismissable={false}>
          <Dialog.Title>Merged</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{merged ? mergedText(merged) : ""}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => router.back()}>OK</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 14 },
  banner: { padding: 12, gap: 8 },
  preview: { flexDirection: "row", alignItems: "center", gap: 12 },
  previewText: { flex: 1, minWidth: 0 },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
  gap: { marginTop: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  iconCell: { padding: 3, borderRadius: 14, borderWidth: 2.5, borderColor: "transparent" },
  swatchCell: { padding: 3, borderRadius: 999, borderWidth: 2.5, borderColor: "transparent" },
  cellOn: { borderColor: BRAND.ink, backgroundColor: BRAND.yellow },
  swatch: { width: 38, height: 38, borderRadius: 19, borderWidth: 2.5, borderColor: BRAND.ink, alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  save: { marginTop: 8 },
  actions: { gap: 10, marginTop: 8 },
  dialogList: { maxHeight: 360, paddingHorizontal: 0 },
});
