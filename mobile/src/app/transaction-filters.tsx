import { router } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { HelperText, Text, TextInput, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyButton, Chip, ScreenHeader } from "@/components/chunky";
import { CategoryChips } from "@/components/category-chips";
import { DateField } from "@/components/date-field";
import { Heading } from "@/components/form-parts";
import { type Account, type AccountList } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { CATEGORIES_PATH, type CategoryTree, pickerGroups, sameName } from "@/lib/categories";
import { UNCATEGORISED, blankFilters, filterErrors, filterHandoff, type TransactionFilters } from "@/lib/search";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { TRANSACTION_TYPES, formatMonth, todayIndia } from "@/lib/transactions";

const MONEY_MAX_LENGTH = 16;

// Whether a picker below offers this name (an archived or merged one is not, so it gets its own chip).
const offered = (tree: CategoryTree, name: string) =>
  [...tree.expense, ...tree.income].some((c) => !c.archived && sameName(c.name, name));

// The transactions list's filters, as a full screen. It starts from the list's filters and hands the
// new ones back through filterHandoff; going back without "Show" changes nothing.
export default function TransactionFiltersScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [today] = useState(() => todayIndia());
  const [filters, setFilters] = useState<TransactionFilters>(() => filterHandoff.draft ?? blankFilters(today.slice(0, 7)));
  const [accounts, setAccounts] = useState<Account[] | "failed" | null>(null);
  const [tree, setTree] = useState<CategoryTree | "failed" | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Choices only: if either fails, that section says so and the rest still works.
  useEffect(() => {
    let current = true;
    const auth = { token: token ?? undefined };
    const onFail = (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return false;
      }
      return true;
    };
    Promise.all([apiFetch<AccountList>("/accounts", auth), apiFetch<AccountList>("/accounts?archived=true", auth)]).then(
      ([active, archived]) => current && setAccounts([...active.accounts, ...archived.accounts]),
      (err: unknown) => {
        if (current && onFail(err)) setAccounts("failed");
      },
    );
    apiFetch<CategoryTree>(CATEGORIES_PATH, auth).then(
      (result) => current && setTree(result),
      (err: unknown) => {
        if (current && onFail(err)) setTree("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [token, logOut]);

  const set = (change: Partial<TransactionFilters>) => {
    setErrors({});
    setFilters((f) => ({ ...f, ...change }));
  };

  const show = () => {
    const found = filterErrors(filters);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    filterHandoff.next = filters;
    router.back();
  };

  // Keeps the month and what is typed in the search box.
  const clear = () => {
    setErrors({});
    setFilters((f) => ({ ...blankFilters(f.month), q: f.q }));
  };

  const kinds: ("expense" | "income")[] =
    filters.type === "income" ? ["income"] : filters.type === "expense" || filters.type === "emi" ? ["expense"] : ["expense", "income"];
  const pickCategory = (name: string) => set({ category: filters.category !== null && sameName(filters.category, name) ? null : name });
  const isCategory = (name: string) => filters.category !== null && sameName(filters.category, name);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Filters" back />
      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          <View>
            <Heading label="Type" />
            <View style={styles.chips} accessibilityRole="radiogroup">
              <Chip label="Any type" selected={filters.type === null} onPress={() => set({ type: null })} accessibilityRole="radio" />
              {TRANSACTION_TYPES.map((t) => (
                <Chip key={t.value} label={t.label} selected={filters.type === t.value} onPress={() => set({ type: t.value })} accessibilityRole="radio" />
              ))}
            </View>
          </View>

          <View>
            <Heading label="Account" />
            {accounts === null || accounts === "failed" ? (
              <Text variant="bodySmall" style={[styles.muted, styles.gap]}>
                {accounts === null ? "Loading accounts…" : "Accounts couldn't be loaded. Go back and try again."}
              </Text>
            ) : (
              <View style={styles.chips} accessibilityRole="radiogroup">
                <Chip label="Any account" selected={filters.accountId === null} onPress={() => set({ accountId: null })} accessibilityRole="radio" />
                {accounts.map((a) => (
                  <Chip
                    key={a.id}
                    label={a.archived ? `${a.name} (archived)` : a.name}
                    selected={filters.accountId === a.id}
                    onPress={() => set({ accountId: a.id })}
                    accessibilityRole="radio"
                  />
                ))}
              </View>
            )}
          </View>

          <View>
            <Heading label="Category" />
            <Text variant="bodySmall" style={styles.muted}>
              A category includes its subcategories.
            </Text>
            <View style={styles.chips} accessibilityRole="radiogroup">
              <Chip label="Any category" selected={filters.category === null} onPress={() => set({ category: null })} accessibilityRole="radio" />
              <Chip label={UNCATEGORISED} icon="tag-off-outline" selected={isCategory(UNCATEGORISED)} onPress={() => pickCategory(UNCATEGORISED)} accessibilityRole="radio" />
              {filters.category !== null && !isCategory(UNCATEGORISED) && (tree === null || tree === "failed" || !offered(tree, filters.category)) ? (
                <Chip label={filters.category} selected onPress={() => set({ category: null })} accessibilityRole="radio" />
              ) : null}
            </View>
            {tree === null || tree === "failed" ? (
              <Text variant="bodySmall" style={[styles.muted, styles.gap]}>
                {tree === null ? "Loading categories…" : "Categories couldn't be loaded. Go back and try again."}
              </Text>
            ) : (
              kinds.map((kind) => (
                <View key={kind} style={styles.gap}>
                  {kinds.length > 1 ? (
                    <Text variant="labelMedium" style={styles.muted}>
                      {kind === "expense" ? "Spending" : "Income"}
                    </Text>
                  ) : null}
                  <CategoryChips groups={pickerGroups(tree[kind])} selected={isCategory} onPick={pickCategory} />
                </View>
              ))
            )}
          </View>

          <View style={styles.section}>
            <Heading label="Dates" />
            <Text variant="bodySmall" style={styles.muted}>
              {filters.dateFrom === "" && filters.dateTo === ""
                ? `Showing ${formatMonth(filters.month)}. Pick dates to search across months.`
                : "These dates replace the month."}
            </Text>
            <DateField
              label="From"
              value={filters.dateFrom}
              onChange={(iso) => set({ dateFrom: iso })}
              maxDate={filters.dateTo || today}
              chips={[]}
            />
            <DateField
              label="To"
              value={filters.dateTo}
              onChange={(iso) => set({ dateTo: iso })}
              minDate={filters.dateFrom || undefined}
              maxDate={today}
              error={errors.dateTo}
              chips={[{ label: "Today", value: today }]}
            />
            {filters.dateFrom !== "" || filters.dateTo !== "" ? (
              <ChunkyButton compact variant="alt" label="Clear dates" onPress={() => set({ dateFrom: "", dateTo: "" })} style={styles.start} />
            ) : null}
          </View>

          <View>
            <Heading label="Amount (₹)" />
            <View style={styles.amounts}>
              <View style={styles.amount}>
                <TextInput
                  mode="outlined"
                  label="At least"
                  value={filters.amountMin}
                  onChangeText={(text) => set({ amountMin: text })}
                  keyboardType="decimal-pad"
                  maxLength={MONEY_MAX_LENGTH}
                  error={Boolean(errors.amountMin)}
                />
                {errors.amountMin ? (
                  <HelperText type="error" visible>
                    {errors.amountMin}
                  </HelperText>
                ) : null}
              </View>
              <View style={styles.amount}>
                <TextInput
                  mode="outlined"
                  label="At most"
                  value={filters.amountMax}
                  onChangeText={(text) => set({ amountMax: text })}
                  keyboardType="decimal-pad"
                  maxLength={MONEY_MAX_LENGTH}
                  error={Boolean(errors.amountMax)}
                />
                {errors.amountMax ? (
                  <HelperText type="error" visible>
                    {errors.amountMax}
                  </HelperText>
                ) : null}
              </View>
            </View>
          </View>

          <ChunkyButton variant="green" label="Show transactions" onPress={show} style={styles.show} />
          <ChunkyButton variant="alt" label="Clear filters" onPress={clear} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 18 },
  muted: { color: BRAND.zinc600 },
  gap: { marginTop: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  section: { gap: 10 },
  start: { alignSelf: "flex-start" },
  amounts: { flexDirection: "row", gap: 12, marginTop: 8 },
  amount: { flex: 1, minWidth: 0 },
  show: { marginTop: 8 },
});
