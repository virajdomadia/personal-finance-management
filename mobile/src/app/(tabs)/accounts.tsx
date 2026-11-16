import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

import { AccountRow } from "@/components/account-row";
import { ChunkyBox, ChunkyButton, EmptyState, HeaderAction, ScreenHeader, Tile } from "@/components/chunky";
import {
  type Account,
  type AccountList,
  errorMessage,
  formatRupees,
  investmentsIn,
} from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { accountSections, fdMaturedText, ppfInterestText, rdDueText } from "@/lib/deposits";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

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

  // Close an RD or FD, or renew a matured FD, each on its own screen.
  const openDeposit = useCallback((pathname: "/close-deposit-form" | "/renew-fd-form", deposit: Account) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push({ pathname, params: { id: String(deposit.id) } });
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

  // A matured FD still open has two ways forward, so its card carries both buttons.
  const maturedCards = useMemo(() => {
    const cards: { account: Account; text: string }[] = [];
    for (const account of list?.accounts ?? []) {
      const text = fdMaturedText(account);
      if (text) cards.push({ account, text });
    }
    return cards;
  }, [list]);

  const data = useMemo(() => (list ? accountSections(list.accounts) : []), [list]);
  const investments = list ? investmentsIn(list) : null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Accounts"
        right={
          <>
            <HeaderAction
              icon="archive-outline"
              label="Archived accounts"
              onPress={() => {
                if (navigating.current) return;
                navigating.current = true;
                router.push("/archived-accounts");
              }}
            />
            <Pressable onPress={() => open()} accessibilityRole="button" accessibilityLabel="Add account" hitSlop={4}>
              {({ pressed }) => (
                <ChunkyBox pressed={pressed} radius={999} offset={SHADOW_OFFSET_SM} style={styles.add}>
                  <Text variant="labelLarge" style={styles.addText}>
                    + ADD
                  </Text>
                </ChunkyBox>
              )}
            </Pressable>
          </>
        }
      />

      {list === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading accounts" />
        </View>
      ) : list === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {error}
          </Text>
          <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
        </View>
      ) : (
        <SectionList
          sections={data}
          keyExtractor={(account) => String(account.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={styles.content}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            <View style={styles.header}>
              {error ? (
                <Text variant="bodyMedium" accessibilityRole="alert" style={styles.error}>
                  {error} Pull down to try again.
                </Text>
              ) : null}
              {dueCards.map((card) => (
                <Pressable
                  key={card.key}
                  onPress={() => openTransaction(card.params)}
                  accessibilityRole="button"
                  accessibilityLabel={card.text}
                >
                  {({ pressed }) => (
                    <ChunkyBox pressed={pressed} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.due}>
                      <Text variant="bodyMedium" style={styles.dueText}>
                        {card.text}
                      </Text>
                    </ChunkyBox>
                  )}
                </Pressable>
              ))}
              {maturedCards.map((card) => (
                <ChunkyBox key={`fd-${card.account.id}`} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.due}>
                  <Text variant="bodyMedium" style={styles.dueText}>
                    {card.text}
                  </Text>
                  <View style={styles.dueActions}>
                    <ChunkyButton
                      compact
                      variant="alt"
                      icon="close-circle-outline"
                      label="Close"
                      accessibilityLabel={`Close ${card.account.name}`}
                      onPress={() => openDeposit("/close-deposit-form", card.account)}
                    />
                    <ChunkyButton
                      compact
                      variant="alt"
                      icon="autorenew"
                      label="Renew"
                      accessibilityLabel={`Renew ${card.account.name}`}
                      onPress={() => openDeposit("/renew-fd-form", card.account)}
                    />
                  </View>
                </ChunkyBox>
              ))}
              <Tile tone="yellow" label="Total balance" value={whole(list.total_have)} size="huge">
                {investments !== null ? (
                  <Text variant="bodySmall" style={styles.note}>
                    Includes investments {formatRupees(investments)}
                  </Text>
                ) : null}
                <View style={styles.owe}>
                  <Text variant="labelLarge" style={styles.note}>
                    You owe
                  </Text>
                  <Text
                    variant="titleMedium"
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.6}
                    style={styles.oweAmount}
                  >
                    {formatRupees(list.total_owe)}
                  </Text>
                </View>
              </Tile>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionHeader}>
              {section.title}
            </Text>
          )}
          renderItem={({ item }) => (
            <AccountRow
              account={item}
              onPress={() => open({ id: String(item.id) })}
              action={
                item.type === "loan" && item.balance !== "0.00" ? (
                  <ChunkyButton
                    compact
                    variant="alt"
                    icon="cash-check"
                    label="Record EMI"
                    accessibilityLabel={`Record an EMI for ${item.name}`}
                    onPress={() => recordEmi(item)}
                  />
                ) : item.type === "ppf" ? (
                  <>
                    <ChunkyButton
                      compact
                      variant="alt"
                      icon="bank-transfer-in"
                      label="Deposit"
                      accessibilityLabel={`Deposit to ${item.name}`}
                      onPress={() => openTransaction({ ppf: String(item.id) })}
                    />
                    {item.deposit?.kind === "ppf" && item.deposit.interest_due !== null ? (
                      <ChunkyButton
                        compact
                        variant="alt"
                        icon="percent"
                        label="Record interest"
                        accessibilityLabel={`Record interest for ${item.name}`}
                        onPress={() => openTransaction({ interest: String(item.id) })}
                      />
                    ) : null}
                  </>
                ) : item.type === "rd" ? (
                  <>
                    {item.deposit?.kind === "rd" && item.deposit.due.length > 0 ? (
                      <ChunkyButton
                        compact
                        variant="alt"
                        icon="cash-check"
                        label="Record instalment"
                        accessibilityLabel={`Record an instalment for ${item.name}`}
                        onPress={() => openTransaction({ rd: String(item.id) })}
                      />
                    ) : null}
                    <ChunkyButton
                      compact
                      variant="alt"
                      icon="close-circle-outline"
                      label="Close RD"
                      accessibilityLabel={`Close ${item.name}`}
                      onPress={() => openDeposit("/close-deposit-form", item)}
                    />
                  </>
                ) : item.type === "fd" ? (
                  <>
                    {item.deposit?.kind === "fd" && item.deposit.matured ? (
                      <ChunkyButton
                        compact
                        variant="alt"
                        icon="autorenew"
                        label="Renew FD"
                        accessibilityLabel={`Renew ${item.name}`}
                        onPress={() => openDeposit("/renew-fd-form", item)}
                      />
                    ) : null}
                    <ChunkyButton
                      compact
                      variant="alt"
                      icon="close-circle-outline"
                      label="Close FD"
                      accessibilityLabel={`Close ${item.name}`}
                      onPress={() => openDeposit("/close-deposit-form", item)}
                    />
                  </>
                ) : undefined
              }
            />
          )}
          ListEmptyComponent={
            <EmptyState
              emoji="👛"
              title="Add your first account"
              body="Your bank accounts, cards, cash, wallets and loans live here, so you can see what you have and what you owe."
              action={{ label: "Add account", onPress: () => open() }}
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
  content: { paddingBottom: 32 },
  header: { paddingHorizontal: 16, paddingTop: 8, gap: 12 },
  error: { color: BRAND.loss },
  add: { paddingHorizontal: 14, paddingVertical: 9, minHeight: 44, justifyContent: "center", backgroundColor: BRAND.ink },
  addText: { color: "#FFFFFF", fontSize: 13, lineHeight: 18, letterSpacing: 0.6 },
  due: { backgroundColor: BRAND.due, padding: 14 },
  dueText: { color: BRAND.ink },
  dueActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, paddingTop: 10 },
  note: { color: BRAND.ink, marginTop: 2 },
  owe: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginTop: 8 },
  oweAmount: { flexShrink: 1, color: BRAND.ink, textAlign: "right", fontVariant: ["tabular-nums"] },
  sectionHeader: { color: BRAND.ink, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
});
