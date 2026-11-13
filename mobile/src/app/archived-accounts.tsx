import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AccountRow } from "@/components/account-row";
import { ChunkyButton, EmptyState, ScreenHeader } from "@/components/chunky";
import { type Account, type AccountList, errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

export default function ArchivedAccountsScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const restoringRef = useRef(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<AccountList>("/accounts?archived=true", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setAccounts(result.accounts);
      setError(null);
      setRestoreError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setError(errorMessage(err));
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

  async function restore(account: Account) {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setRestoring(account.id);
    setRestoreError(null);
    try {
      await apiFetch(`/accounts/${account.id}/restore`, { method: "POST", token: token ?? undefined });
      setAccounts((current) => current?.filter((a) => a.id !== account.id) ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else setRestoreError(errorMessage(err));
    } finally {
      restoringRef.current = false;
      setRestoring(null);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Archived accounts" back />

      {accounts === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading archived accounts" />
        </View>
      ) : accounts === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {error}
          </Text>
          <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
        </View>
      ) : (
        <FlatList
          data={accounts}
          keyExtractor={(account) => String(account.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          ListHeaderComponent={
            error || restoreError ? (
              <Text
                variant="bodyMedium"
                accessibilityRole="alert"
                style={styles.error}
              >
                {restoreError ?? `${error} Pull down to try again.`}
              </Text>
            ) : undefined
          }
          renderItem={({ item }) => (
            <AccountRow
              account={item}
              showType
              action={
                <ChunkyButton
                  compact
                  variant="alt"
                  icon="archive-arrow-up-outline"
                  label="Restore"
                  loading={restoring === item.id}
                  disabled={restoring !== null && restoring !== item.id}
                  onPress={() => void restore(item)}
                  accessibilityLabel={`Restore ${item.name}`}
                />
              }
            />
          )}
          ListEmptyComponent={
            <EmptyState
              emoji="📦"
              title="No archived accounts"
              body="Accounts you close or stop using rest here, out of your totals. Nothing is ever deleted."
              action={{ label: "Back to accounts", variant: "alt", onPress: () => router.back() }}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  error: { color: BRAND.loss, padding: 16 },
});
