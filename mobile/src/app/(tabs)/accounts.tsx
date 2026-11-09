import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { Appbar, Button, Divider, FAB, Surface, Text, TouchableRipple, useTheme } from "react-native-paper";

import { AccountRow } from "@/components/account-row";
import {
  type Account,
  type AccountList,
  errorMessage,
  formatRupees,
  investmentsIn,
} from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { accountSections, ppfInterestText, rdDueText } from "@/lib/deposits";
import { useSession } from "@/lib/session";

export default function AccountsScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [list, setList] = useState<AccountList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<AccountList>("/accounts", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setList(result);
      setError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setError(errorMessage(err));
    }
  }, [token, logOut]);

  // Reloads whenever the tab regains focus, so coming back from the form shows fresh data.
  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
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

  // Drops a second push from a double tap until the screen regains focus.
  const open = useCallback((params?: { id: string }) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(params ? { pathname: "/account-form", params } : "/account-form");
  }, []);

  const recordEmi = useCallback((loan: Account) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push({ pathname: "/transaction-form", params: { loan: String(loan.id) } });
  }, []);

  // A transaction pre-filled for a deposit: `rd` is the next instalment, `ppf` a deposit, `interest` the PPF's interest.
  const openTransaction = useCallback((params: { rd: string } | { ppf: string } | { interest: string }) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push({ pathname: "/transaction-form", params });
  }, []);

  const closeRd = useCallback((rd: Account) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push({ pathname: "/close-rd-form", params: { id: String(rd.id) } });
  }, []);

  const dueCards = useMemo(() => {
    const cards: { key: string; text: string; params: { rd: string } | { interest: string } }[] = [];
    for (const account of list?.accounts ?? []) {
      const rd = rdDueText(account);
      if (rd) cards.push({ key: `rd-${account.id}`, text: rd, params: { rd: String(account.id) } });
      const ppf = ppfInterestText(account);
      if (ppf) cards.push({ key: `ppf-${account.id}`, text: ppf, params: { interest: String(account.id) } });
    }
    return cards;
  }, [list]);

  const data = useMemo(() => (list ? accountSections(list.accounts) : []), [list]);
  const investments = list ? investmentsIn(list) : null;

  return (
    <View style={styles.screen}>
      <Appbar.Header>
        <Appbar.Content title="Accounts" />
        <Appbar.Action
          icon="archive-outline"
          accessibilityLabel="Archived accounts"
          onPress={() => {
            if (navigating.current) return;
            navigating.current = true;
            router.push("/archived-accounts");
          }}
        />
      </Appbar.Header>

      {list === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading accounts" />
        </View>
      ) : list === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {error}
          </Text>
          <Button mode="contained" onPress={() => void refresh()} loading={refreshing} disabled={refreshing}>
            Try again
          </Button>
        </View>
      ) : (
        <SectionList
          sections={data}
          keyExtractor={(account) => String(account.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={styles.content}
          ItemSeparatorComponent={Divider}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            <View style={styles.header}>
              {error ? (
                <Text
                  variant="bodyMedium"
                  accessibilityRole="alert"
                  style={{ color: colors.error, marginBottom: 12 }}
                >
                  {error} Pull down to try again.
                </Text>
              ) : null}
              {dueCards.map((card) => (
                <Surface key={card.key} elevation={2} style={[styles.due, { backgroundColor: colors.secondaryContainer }]}>
                  <TouchableRipple
                    onPress={() => openTransaction(card.params)}
                    accessibilityRole="button"
                    accessibilityLabel={card.text}
                    style={styles.dueTouch}
                  >
                    <Text variant="bodyMedium" style={{ color: colors.onSecondaryContainer }}>
                      {card.text}
                    </Text>
                  </TouchableRipple>
                </Surface>
              ))}
              <Surface elevation={1} style={styles.totals}>
                <View style={styles.total}>
                  <Text variant="labelLarge">You have</Text>
                  <Text variant="titleLarge" style={styles.totalAmount}>
                    {formatRupees(list.total_have)}
                  </Text>
                  {investments !== null ? (
                    <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                      Includes investments {formatRupees(investments)}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.total}>
                  <Text variant="labelLarge">You owe</Text>
                  <Text variant="titleLarge" style={styles.totalAmount}>
                    {formatRupees(list.total_owe)}
                  </Text>
                </View>
              </Surface>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <Text
              variant="titleSmall"
              accessibilityRole="header"
              style={[styles.sectionHeader, { color: colors.primary }]}
            >
              {section.title}
            </Text>
          )}
          renderItem={({ item }) => (
            <AccountRow
              account={item}
              onPress={() => open({ id: String(item.id) })}
              action={
                item.type === "loan" && item.balance !== "0.00" ? (
                  <Button
                    compact
                    icon="cash-check"
                    accessibilityLabel={`Record an EMI for ${item.name}`}
                    onPress={() => recordEmi(item)}
                  >
                    Record EMI
                  </Button>
                ) : item.type === "ppf" ? (
                  <>
                    <Button
                      compact
                      icon="bank-transfer-in"
                      accessibilityLabel={`Deposit to ${item.name}`}
                      onPress={() => openTransaction({ ppf: String(item.id) })}
                    >
                      Deposit
                    </Button>
                    {item.deposit?.kind === "ppf" && item.deposit.interest_due !== null ? (
                      <Button
                        compact
                        icon="percent"
                        accessibilityLabel={`Record interest for ${item.name}`}
                        onPress={() => openTransaction({ interest: String(item.id) })}
                      >
                        Record interest
                      </Button>
                    ) : null}
                  </>
                ) : item.type === "rd" ? (
                  <>
                    {item.deposit?.kind === "rd" && item.deposit.due.length > 0 ? (
                      <Button
                        compact
                        icon="cash-check"
                        accessibilityLabel={`Record an instalment for ${item.name}`}
                        onPress={() => openTransaction({ rd: String(item.id) })}
                      >
                        Record instalment
                      </Button>
                    ) : null}
                    <Button
                      compact
                      icon="close-circle-outline"
                      accessibilityLabel={`Close ${item.name}`}
                      onPress={() => closeRd(item)}
                    >
                      Close RD
                    </Button>
                  </>
                ) : undefined
              }
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text variant="titleMedium">Add your first account</Text>
              <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant, textAlign: "center" }}>
                Bank accounts, cards, cash, loans and more. Tap Add account to start.
              </Text>
            </View>
          }
        />
      )}

      <FAB
        icon="plus"
        label="Add account"
        style={styles.fab}
        onPress={() => open()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { paddingBottom: 96 },
  header: { padding: 16 },
  due: { borderRadius: 12, marginBottom: 12, overflow: "hidden" },
  dueTouch: { padding: 16 },
  totals: { borderRadius: 12, padding: 16, gap: 12 },
  total: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  totalAmount: { flexShrink: 1, textAlign: "right" },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  empty: { alignItems: "center", gap: 8, padding: 32 },
  fab: { position: "absolute", right: 16, bottom: 16 },
});
