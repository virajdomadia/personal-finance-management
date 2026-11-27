import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CategoryChips } from "@/components/category-chips";
import { ChunkyBox, ChunkyButton, HeaderAction, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { CATEGORIES_PATH, type CategoryTree, pickerGroups, sameName } from "@/lib/categories";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { type SplitPart, splitLeft } from "@/lib/transactions";

type Split = { id: number; total: string; parts: { id: number; category: string | null; amount: string }[] };

const MAX_PARTS = 20;

// One bill across several categories: each part becomes its own expense, adding up to the bill.
export default function SplitScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [total, setTotal] = useState<string | null>(null);
  const [parts, setParts] = useState<SplitPart[]>([]);
  const [tree, setTree] = useState<CategoryTree | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    Promise.all([apiFetch<Split>(`/transactions/${id}/split`, auth), apiFetch<CategoryTree>(CATEGORIES_PATH, auth).catch(() => null)])
      .then(([split, categories]) => {
        if (!current) return;
        setTotal(split.total);
        setTree(categories);
        const loaded = split.parts.map((p) => ({ category: p.category ?? "", amount: p.amount }));
        // An unsplit bill starts as its whole amount plus an empty second part.
        setParts(loaded.length > 1 ? loaded : [...loaded, { category: "", amount: "" }]);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logOut();
        else if (current) setError(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
      });
    return () => {
      current = false;
    };
  }, [id, token, logOut]);

  const left = total === null ? "" : splitLeft(total, parts);
  const ready = left === "0.00" && parts.every((p) => p.category.trim() !== "" && p.amount.trim() !== "");
  const change = (i: number, key: keyof SplitPart, value: string) => setParts((ps) => ps.map((p, n) => (n === i ? { ...p, [key]: value } : p)));
  const remove = (i: number) => {
    setParts((ps) => ps.filter((_, n) => n !== i));
    setActive(0);
  };
  const add = () => {
    setParts((ps) => [...ps, { category: "", amount: left === "" || left === "0.00" || left.startsWith("-") ? "" : left }]);
    setActive(parts.length);
  };

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/transactions/${id}/split`, { method: "PUT", token: token ?? undefined, body: { parts } });
      router.back();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void logOut();
      setError(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
    } finally {
      setSaving(false);
    }
  };

  const status =
    left === "" ? "Check the amounts" : left === "0.00" ? "All assigned" : left.startsWith("-") ? `${formatRupees(left.slice(1))} too much` : `Left to assign ${formatRupees(left)}`;
  const groups = pickerGroups(tree?.expense ?? []);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={total === null ? "Split" : `Split ${formatRupees(total)}`} back />
      {total === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading the bill" />
        </View>
      ) : (
        <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
            {error ? <Banner messages={[error]} /> : null}
            {parts.map((part, i) => (
              <ChunkyBox key={i} style={styles.card}>
                <View style={styles.row}>
                  <Text variant="titleSmall" style={styles.heading}>
                    Part {i + 1}
                  </Text>
                  {parts.length > 1 ? <HeaderAction icon="close" label={`Remove part ${i + 1}`} disabled={saving} onPress={() => remove(i)} /> : null}
                </View>
                <TextInput
                  mode="outlined"
                  label="Category"
                  value={part.category}
                  maxLength={40}
                  disabled={saving}
                  onFocus={() => setActive(i)}
                  onChangeText={(v) => change(i, "category", v)}
                />
                <TextInput
                  mode="outlined"
                  label="Amount (₹)"
                  value={part.amount}
                  keyboardType="numeric"
                  disabled={saving}
                  onFocus={() => setActive(i)}
                  onChangeText={(v) => change(i, "amount", v)}
                />
                {active === i && groups.length > 0 ? (
                  <CategoryChips groups={groups} selected={(name) => sameName(part.category, name)} onPick={(name) => change(i, "category", name)} disabled={saving} />
                ) : null}
              </ChunkyBox>
            ))}
            <View style={styles.row}>
              <ChunkyButton compact variant="alt" icon="plus" label="Add part" disabled={saving || parts.length >= MAX_PARTS} onPress={add} />
              <Text accessibilityLiveRegion="polite" variant="bodyMedium" style={{ color: left === "0.00" ? BRAND.gain : BRAND.loss, fontWeight: "800" }}>
                {status}
              </Text>
            </View>
            {parts.length === 1 ? (
              <Text variant="bodySmall" style={styles.muted}>
                One part puts the whole bill back together.
              </Text>
            ) : null}
            <ChunkyButton variant="green" label={saving ? "Saving..." : "Save split ✓"} accessibilityLabel="Save split" onPress={() => void save()} loading={saving} disabled={!ready && !saving} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 12 },
  card: { padding: 14, gap: 10 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  heading: { color: BRAND.ink },
  muted: { color: BRAND.zinc600 },
});
