import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, HelperText, Portal, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { Banner, useBlockBack } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { amountInput, budgetAmountError, budgetErrorText, budgetPath, budgetPayload } from "@/lib/budgets";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

// Sets, changes or removes one category's budget. Every change applies from this month on.
export default function BudgetFormScreen() {
  const params = useLocalSearchParams<{ id?: string; name?: string; amount?: string; spent?: string; parent?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const editing = Boolean(params.amount);
  const [amount, setAmount] = useState(() => amountInput(params.amount));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [general, setGeneral] = useState<string[]>([]);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [asking, setAsking] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const name = params.name ?? "This category";

  useBlockBack(useCallback(() => busyRef.current, []));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busyRef.current) setAsking(false);
    });
    return () => subscription.remove();
  }, []);

  async function run(kind: "save" | "remove", request: () => Promise<void>) {
    if (busyRef.current || params.id === undefined) return;
    busyRef.current = true;
    setBusy(kind);
    setFieldError(null);
    setGeneral([]);
    let done = false;
    try {
      await request();
      done = true;
      if (mounted.current) router.back();
    } catch (err) {
      setAsking(false);
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
      } else if (err instanceof ApiError && err.status === 422) {
        const found = budgetErrorText(err.detail);
        setFieldError(found.amount);
        setGeneral(found.general);
      } else {
        setGeneral([errorMessage(err instanceof ApiError ? { detail: err.detail } : err)]);
      }
    } finally {
      if (!done) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  }

  const save = () => {
    const problem = budgetAmountError(amount);
    if (problem !== null) {
      setFieldError(problem);
      return;
    }
    void run("save", async () => {
      await apiFetch(budgetPath(params.id ?? ""), { method: "PUT", token: token ?? undefined, body: budgetPayload(amount) });
    });
  };

  const remove = () => {
    void run("remove", async () => {
      await apiFetch(budgetPath(params.id ?? ""), { method: "DELETE", token: token ?? undefined });
    });
  };

  if (params.id === undefined) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Budget" back />
        <View style={styles.center}>
          <Text variant="bodyLarge">This budget couldn&apos;t be opened.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={editing ? "Change budget" : "New budget"} back backDisabled={busy !== null} />
      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          <Banner messages={general} />
          <ChunkyBox style={styles.head}>
            <Text variant="titleLarge" style={styles.ink}>
              {name}
            </Text>
            {params.parent ? (
              <Text variant="bodySmall" style={styles.muted}>
                in {params.parent}
              </Text>
            ) : null}
            {params.spent ? (
              <Text variant="bodyMedium" style={styles.ink}>
                {whole(params.spent)} spent this month
              </Text>
            ) : null}
          </ChunkyBox>

          <View>
            <TextInput
              mode="outlined"
              label="Budget a month"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              left={<TextInput.Affix text="₹" />}
              error={fieldError !== null}
              disabled={busy !== null}
              autoFocus={!editing}
              returnKeyType="done"
              onSubmitEditing={save}
              accessibilityLabel={`Budget a month for ${name}`}
            />
            {fieldError ? (
              <HelperText type="error" visible>
                {fieldError}
              </HelperText>
            ) : null}
          </View>
          <Text variant="bodySmall" style={styles.muted}>
            Applies from this month on and stays the same every month until you change it. Unused budget doesn&apos;t carry over. A
            budget on a category counts its subcategories too.
          </Text>

          <ChunkyButton label={editing ? "Save" : "Set budget"} onPress={save} loading={busy === "save"} disabled={busy !== null} />
          {editing ? (
            <ChunkyButton
              label="Remove budget"
              variant="pink"
              icon="trash-can-outline"
              onPress={() => setAsking(true)}
              disabled={busy !== null}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Dialog visible={asking} onDismiss={() => (busy ? undefined : setAsking(false))}>
          <Dialog.Title>Remove this budget?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {name} won&apos;t have a budget from this month on. Earlier months keep theirs.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsking(false)} disabled={busy !== null}>
              Keep
            </Button>
            <Button onPress={remove} loading={busy === "remove"} disabled={busy !== null} textColor={BRAND.loss}>
              Remove
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { padding: 16, gap: 14 },
  head: { padding: 16, gap: 4, backgroundColor: BRAND.yellow },
  ink: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
});
