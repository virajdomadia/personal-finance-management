import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Appbar, Surface, Text, useTheme } from "react-native-paper";

import { GoalTagChip } from "@/components/goal-tag";
import { TransactionsList } from "@/components/transactions-list";
import { type Account, type AccountList, OWED_TYPES, formatRupees, headlineBalance } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { freeBalanceText, overSetAsideText } from "@/lib/goals";
import { useSession } from "@/lib/session";

export default function AccountTransactionsScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { colors } = useTheme();
  const { token, logOut } = useSession();
  const [account, setAccount] = useState<Account | null>(null);
  const latest = useRef(0);

  // The account's figures, read again on every visit. Only a summary: if it fails the list still works.
  useFocusEffect(
    useCallback(() => {
      const mine = ++latest.current;
      const auth = { token: token ?? undefined };
      Promise.all([apiFetch<AccountList>("/accounts", auth), apiFetch<AccountList>("/accounts?archived=true", auth)])
        .then(([active, archived]) => {
          if (mine !== latest.current) return;
          setAccount([...active.accounts, ...archived.accounts].find((a) => String(a.id) === id) ?? null);
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) void logOut();
        });
    }, [id, token, logOut]),
  );

  const free = account?.set_aside ? freeBalanceText(account) : null;
  const over = account?.free_balance ? overSetAsideText(account) : null;
  const owed = account !== null && OWED_TYPES.has(account.type);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={name ?? account?.name ?? "Transactions"} />
      </Appbar.Header>
      {account !== null ? (
        <Surface elevation={1} style={styles.summary}>
          <View style={styles.line}>
            <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
              {owed ? "Owed" : free ? "Free to spend" : "Balance"}
            </Text>
            <Text variant="titleLarge" style={styles.amount}>
              {formatRupees(headlineBalance(account))}
            </Text>
          </View>
          {free ? (
            <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
              {free}
            </Text>
          ) : null}
          {over ? (
            <Text variant="bodySmall" accessibilityRole="alert" style={{ color: colors.error }}>
              {over}
            </Text>
          ) : null}
          <GoalTagChip tag={account.in_goal} />
        </Surface>
      ) : null}
      <TransactionsList fixedAccountId={Number(id)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  summary: { borderRadius: 12, padding: 12, gap: 4, marginHorizontal: 16, marginTop: 8 },
  line: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  amount: { flexShrink: 1, textAlign: "right", fontWeight: "600" },
});
