import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

import { ScreenHeader, Tile } from "@/components/chunky";
import { GoalTagChip } from "@/components/goal-tag";
import { TransactionsList } from "@/components/transactions-list";
import { type Account, type AccountList, OWED_TYPES, formatRupees, headlineBalance } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { freeBalanceText, overSetAsideText } from "@/lib/goals";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

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
      <ScreenHeader title={name ?? account?.name ?? "Transactions"} back />
      {account !== null ? (
        <View style={styles.summary}>
          <Tile
            tone="yellow"
            label={owed ? "Owed" : free ? "Free to spend" : "Balance"}
            value={formatRupees(headlineBalance(account))}
          >
            {free ? (
              <Text variant="bodySmall" style={styles.note}>
                {free}
              </Text>
            ) : null}
            {over ? (
              <Text variant="bodySmall" accessibilityRole="alert" style={styles.over}>
                {over}
              </Text>
            ) : null}
            <GoalTagChip tag={account.in_goal} />
          </Tile>
        </View>
      ) : null}
      <TransactionsList fixedAccountId={Number(id)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  summary: { marginHorizontal: 16, marginTop: 8 },
  note: { color: BRAND.ink, marginTop: 2 },
  over: { color: BRAND.ink, fontFamily: "Nunito_900Black", marginTop: 2 },
});
