import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

import { AccountRow } from "@/components/account-row";
import { ChunkyBox, ChunkyButton, HeaderAction, ScreenHeader, Tile } from "@/components/chunky";
import {
  type Account,
  type AccountList,
  errorMessage,
  formatRupees,
  investmentsIn,
} from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { accountSections, ppfInterestText, rdDueText } from "@/lib/deposits";
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
                      onPress={() => closeRd(item)}
                    />
                  </>
                ) : undefined
              }
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text variant="titleMedium">Add your first account</Text>
              <Text variant="bodyMedium" style={styles.emptyText}>
                Bank accounts, cards, cash, loans and more. Tap + ADD to start.
              </Text>
            </View>
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
  note: { color: BRAND.ink, marginTop: 2 },
  owe: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginTop: 8 },
  oweAmount: { flexShrink: 1, color: BRAND.ink, textAlign: "right", fontVariant: ["tabular-nums"] },
  sectionHeader: { color: BRAND.ink, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  empty: { alignItems: "center", gap: 8, padding: 32 },
  emptyText: { color: BRAND.zinc600, textAlign: "center" },
});
