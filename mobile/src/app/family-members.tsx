import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, HelperText, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, EmptyState, Row, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Family, MAX_MEMBERS, NAME_MAX, type Person, confirmMatches, memberNameError, removeWarning } from "@/lib/family";
import { useProfile } from "@/lib/profile";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

type Editing = { kind: "rename" | "remove"; member: Person } | null;

// A failure in the server's words: a field's message, or the request's (a 409, a 404, ...).
function messagesOf(err: unknown, field: string): { field: string | null; general: string[] } {
  if (err instanceof ApiError && err.status === 422) {
    const split = splitErrors(err.detail, [field]);
    return { field: split.fields[field] ?? null, general: split.general };
  }
  return { field: null, general: [errorMessage(err instanceof ApiError ? { detail: err.detail } : err)] };
}

export default function FamilyMembersScreen() {
  const { token, logOut } = useSession();
  const { syncFamily } = useProfile();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [family, setFamily] = useState<Family | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [general, setGeneral] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [dialogGeneral, setDialogGeneral] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const latest = useRef(0);
  const auth = { token: token ?? undefined };

  const show = useCallback(
    (f: Family) => {
      setFamily(f);
      syncFamily(f);
    },
    [syncFamily],
  );

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const f = await apiFetch<Family>("/family", { token: token ?? undefined });
      if (mine !== latest.current) return;
      show(f);
      setLoadError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setLoadError(errorMessage(err));
    }
  }, [token, logOut, show]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const members = family?.members ?? [];
  const full = members.length >= MAX_MEMBERS;

  async function add() {
    if (busy.current) return;
    const local = memberNameError(name, members);
    setGeneral([]);
    if (local) {
      setNameError(local);
      return;
    }
    busy.current = true;
    setAdding(true);
    setNameError(null);
    try {
      await apiFetch<Person>("/family/members", { method: "POST", body: { name: name.trim() }, ...auth });
      setName("");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      const m = messagesOf(err, "name");
      setNameError(m.field);
      setGeneral(m.general);
    } finally {
      busy.current = false;
      setAdding(false);
    }
  }

  const open = (kind: "rename" | "remove", member: Person) => {
    setEditing({ kind, member });
    setDraft(kind === "rename" ? member.name : "");
    setDraftError(null);
    setDialogGeneral([]);
  };

  const close = () => {
    if (!busy.current) setEditing(null);
  };

  async function confirm() {
    if (busy.current || editing === null) return;
    const { kind, member } = editing;
    setDialogGeneral([]);
    if (kind === "rename") {
      if (draft.trim() === member.name) {
        setEditing(null);
        return;
      }
      const local = memberNameError(draft, members, member.id);
      if (local) {
        setDraftError(local);
        return;
      }
    } else if (!confirmMatches(draft, member.name)) {
      setDraftError(`Type ${member.name} to remove them and all their data.`);
      return;
    }
    busy.current = true;
    setSaving(true);
    setDraftError(null);
    try {
      if (kind === "rename") {
        await apiFetch<Person>(`/family/members/${member.id}`, { method: "PATCH", body: { name: draft.trim() }, ...auth });
        await load();
      } else {
        const f = await apiFetch<Family>(`/family/members/${member.id}?confirm=${encodeURIComponent(draft.trim())}`, {
          method: "DELETE",
          ...auth,
        });
        show(f); // back to the owner if they were viewing this member
      }
      setEditing(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      const m = messagesOf(err, kind === "rename" ? "name" : "confirm");
      setDraftError(m.field);
      setDialogGeneral(m.general);
      if (err instanceof ApiError && err.status === 404) void load(); // removed elsewhere
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  const removing = editing?.kind === "remove";
  const confirmReady = editing === null || !removing || confirmMatches(draft, editing.member.name);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Manage family" back />
      {family === null && loadError === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading your family" />
        </View>
      ) : family === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {loadError}
          </Text>
          <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
        </View>
      ) : (
        <KeyboardAvoidingView style={styles.screen} behavior="height">
          <ScrollView
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
            contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}
          >
            <Text variant="bodyMedium" style={styles.muted}>
              Each family member has their own profile: accounts, investments and everything else, kept apart from yours. Switch to them from the Profile tab to record their money. The Family tab adds up everyone&apos;s investments.
            </Text>
            {loadError ? (
              <Text variant="bodyMedium" accessibilityRole="alert" style={styles.error}>
                {loadError} Pull down to try again.
              </Text>
            ) : null}

            {members.length === 0 ? (
              <EmptyState compact emoji="👨‍👩‍👧" title="No family members yet" body="Add a parent, your spouse or a child to keep their investments here too." />
            ) : (
              <View style={styles.list}>
                {members.map((member) => (
                  <Row
                    key={member.id}
                    emoji="🙂"
                    tone="purple"
                    title={member.name}
                  >
                    <View style={styles.actions}>
                      <ChunkyButton compact variant="alt" icon="pencil-outline" label="Rename" accessibilityLabel={`Rename ${member.name}`} onPress={() => open("rename", member)} />
                      <ChunkyButton compact variant="pink" icon="delete-outline" label="Remove" accessibilityLabel={`Remove ${member.name}`} onPress={() => open("remove", member)} />
                    </View>
                  </Row>
                ))}
              </View>
            )}

            <ChunkyBox radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.add}>
              <Text variant="titleSmall" accessibilityRole="header" style={styles.ink}>
                Add a family member
              </Text>
              {full ? (
                <Text variant="bodyMedium" style={styles.muted}>
                  You can have up to {MAX_MEMBERS} family members.
                </Text>
              ) : (
                <>
                  <TextInput
                    mode="outlined"
                    label="Name"
                    placeholder="Papa"
                    value={name}
                    onChangeText={(text) => {
                      setName(text);
                      setNameError(null);
                    }}
                    error={nameError !== null}
                    disabled={adding}
                    maxLength={NAME_MAX}
                    autoComplete="off"
                    importantForAutofill="no"
                    returnKeyType="done"
                    onSubmitEditing={() => void add()}
                  />
                  {nameError ? (
                    <HelperText type="error" visible>
                      {nameError}
                    </HelperText>
                  ) : null}
                  <Banner messages={general} />
                  <ChunkyButton label="Add" icon="plus" onPress={() => void add()} loading={adding} />
                </>
              )}
            </ChunkyBox>
          </ScrollView>
        </KeyboardAvoidingView>
      )}

      <Portal>
        <Dialog visible={editing !== null} onDismiss={close}>
          <Dialog.Title>{editing === null ? "" : removing ? `Remove ${editing.member.name}?` : `Rename ${editing.member.name}`}</Dialog.Title>
          <Dialog.Content style={styles.dialog}>
            {removing && editing ? (
              <Text variant="bodyMedium" style={styles.ink}>
                {removeWarning(editing.member.name)}
              </Text>
            ) : null}
            <TextInput
              mode="outlined"
              label={removing ? "Type their name" : "Name"}
              value={draft}
              onChangeText={(text) => {
                setDraft(text);
                setDraftError(null);
              }}
              error={draftError !== null}
              disabled={saving}
              maxLength={NAME_MAX}
              autoComplete="off"
              autoCorrect={false}
              importantForAutofill="no"
              autoFocus
            />
            {draftError ? (
              <HelperText type="error" visible>
                {draftError}
              </HelperText>
            ) : null}
            <Banner messages={dialogGeneral} />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={close} disabled={saving}>
              Cancel
            </Button>
            <Button
              onPress={() => void confirm()}
              loading={saving}
              disabled={saving || !confirmReady}
              textColor={removing ? BRAND.loss : undefined}
            >
              {removing ? "Remove" : "Save"}
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
  body: { paddingHorizontal: 16, gap: 12 },
  list: { gap: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, paddingTop: 8 },
  add: { padding: 14, gap: 8 },
  dialog: { gap: 8 },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
  error: { color: BRAND.loss },
});
