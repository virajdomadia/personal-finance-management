import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, SectionList, StyleSheet, View } from "react-native";
import { Button, Chip, Divider, FAB, IconButton, Surface, Text, TouchableRipple, useTheme } from "react-native-paper";

import { DueList } from "@/components/due-list";
import type { GoalDue } from "@/lib/goals";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { DueItem } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import {
  TRANSACTION_TYPES,
  type Activity,
  type Transaction,
  type TransactionList,
  type TransactionType,
  formatDate,
  activityAmount,
  activityLabel,
  formatMonth,
  groupByDate,
  savedMonth,
  shiftMonth,
  signedAmount,
  todayIndia,
} from "@/lib/transactions";

const PAGE_SIZE = 50;

type Filters = { month: string; accountId: number | null; type: TransactionType | null };
type Accounts = { active: Account[]; archived: Account[] };

function query(filters: Filters, offset: number): string {
  const params = [`month=${filters.month}`, `limit=${PAGE_SIZE}`, `offset=${offset}`];
  if (filters.accountId !== null) params.push(`account_id=${filters.accountId}`);
  if (filters.type !== null) params.push(`type=${filters.type}`);
  return `/transactions?${params.join("&")}`;
}

function TransactionRow({
  transaction: tx,
  viewedAccountId,
  onPress,
}: {
  transaction: Transaction;
  viewedAccountId: number | null;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const title = tx.type === "transfer" ? "Transfer" : tx.type === "emi" ? `EMI · ${tx.to_account_name}` : tx.category;
  const accounts =
    tx.type === "transfer"
      ? `${tx.account_name} → ${tx.to_account_name}`
      : tx.type === "emi" && tx.interest !== null
        ? `${tx.account_name} · ${formatRupees(tx.interest)} interest`
        : tx.account_name;
  const amount = signedAmount(tx, viewedAccountId);
  return (
    <TouchableRipple
      onPress={onPress}
      disabled={!tx.editable}
      accessibilityRole={tx.editable ? "button" : undefined}
      accessibilityLabel={`${title}, ${amount}, ${accounts}`}
    >
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <Text variant="titleMedium">{title}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {tx.note ? `${accounts} · ${tx.note}` : accounts}
          </Text>
        </View>
        <View style={styles.rowAmount}>
          <Text variant="titleMedium" style={styles.amountText}>
            {amount}
          </Text>
          {tx.editable ? null : (
            <Text variant="labelSmall" style={{ color: colors.onSurfaceVariant }}>
              Archived
            </Text>
          )}
        </View>
      </View>
    </TouchableRipple>
  );
}

// One buy or sell in an investment account. Read-only: tapping opens the stock, fund or coin.
function ActivityRow({ activity, onPress }: { activity: Activity; onPress: () => void }) {
  const { colors } = useTheme();
  const label = activityLabel(activity);
  const amount = activityAmount(activity.signed_amount);
  return (
    <TouchableRipple
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${amount}, ${formatDate(activity.date)}`}
      accessibilityHint="Opens it"
    >
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <Text variant="titleMedium">{label}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {formatDate(activity.date)}
          </Text>
        </View>
        <View style={styles.rowAmount}>
          <Text variant="titleMedium" style={styles.amountText}>
            {amount}
          </Text>
        </View>
      </View>
    </TouchableRipple>
  );
}

// `fixedAccountId` shows one account's transactions, in place of the account filter.
export function TransactionsList({ fixedAccountId = null }: { fixedAccountId?: number | null }) {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [thisMonth] = useState(() => todayIndia().slice(0, 7));
  const [filters, setFilters] = useState<Filters>({ month: thisMonth, accountId: fixedAccountId, type: null });
  const [list, setList] = useState<TransactionList | null>(null);
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  // The month's buys and sells in the viewed account. Null while loading; undefined when it could not load.
  const [activity, setActivity] = useState<Activity[] | null | undefined>(null);
  // Due and coming-up reminders, shown above the list when it isn't one account's.
  const [due, setDue] = useState<DueItem[]>([]);
  const [goalsDue, setGoalsDue] = useState<GoalDue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const latest = useRef(0);
  const navigating = useRef(false);
  // The filters on screen right now; a late reload must not read stale ones from its closure.
  const filtersRef = useRef(filters);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setLoadingMore(false);
    try {
      const auth = { token: token ?? undefined };
      const [result, active, archived, activityResult, dueResult] = await Promise.all([
        apiFetch<TransactionList>(query(filtersRef.current, 0), auth),
        apiFetch<AccountList>("/accounts", auth),
        apiFetch<AccountList>("/accounts?archived=true", auth),
        fixedAccountId === null
          ? Promise.resolve(null)
          : apiFetch<{ items: Activity[] }>(
              `/accounts/${fixedAccountId}/investment-activity?month=${filtersRef.current.month}`,
              auth,
            ).catch((err: unknown) => {
              // A 401 signs out below; anything else only leaves this section out.
              if (err instanceof ApiError && err.status === 401) throw err;
              return undefined;
            }),
        fixedAccountId !== null
          ? Promise.resolve(null)
          : apiFetch<{ items: DueItem[]; goals_due?: GoalDue[] }>("/recurring/due", auth).catch((err: unknown) => {
              // A 401 signs out below; anything else keeps the reminders already shown.
              if (err instanceof ApiError && err.status === 401) throw err;
              return null;
            }),
      ]);
      if (mine !== latest.current) return;
      if (dueResult !== null) {
        setDue(dueResult.items);
        setGoalsDue(dueResult.goals_due ?? []);
      }
      setActivity(activityResult === null ? null : activityResult === undefined ? undefined : activityResult.items);
      setList(result);
      setAccounts({ active: active.accounts, archived: archived.accounts });
      setError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setError(errorMessage(err));
    }
  }, [token, logOut, fixedAccountId]);

  const applyFilters = useCallback(
    (change: Partial<Filters>) => {
      const next = { ...filtersRef.current, ...change };
      filtersRef.current = next;
      setFilters(next);
      setList(null);
      // The old month's rows must not show while the new month loads.
      setActivity(null);
      setError(null);
      void load();
    },
    [load],
  );

  // Reloads whenever the screen regains focus, so coming back from the form shows fresh data.
  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
      const month = savedMonth.current;
      savedMonth.current = null;
      if (month && month !== filtersRef.current.month) applyFilters({ month });
      else void load();
    }, [load, applyFilters]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  async function loadMore() {
    if (list === null || loadingMore) return;
    const mine = ++latest.current;
    setLoadingMore(true);
    try {
      const more = await apiFetch<TransactionList>(query(filtersRef.current, list.transactions.length), {
        token: token ?? undefined,
      });
      if (mine !== latest.current) return;
      setList({ ...more, transactions: [...list.transactions, ...more.transactions] });
      setError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setError(errorMessage(err));
    } finally {
      if (mine === latest.current) setLoadingMore(false);
    }
  }

  // Drops a second push from a double tap until the screen regains focus.
  const open = (params: { id?: string; account?: string }) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push({ pathname: "/transaction-form", params });
  };

  const openInstrument = (activityRow: Activity) => {
    if (navigating.current) return;
    navigating.current = true;
    const params = { id: String(activityRow.instrument_id), symbol: activityRow.symbol };
    if (activityRow.kind === "stock") router.push({ pathname: "/stock", params });
    else if (activityRow.kind === "crypto") router.push({ pathname: "/coin", params });
    else router.push({ pathname: "/fund", params });
  };

  const sections = useMemo(
    () =>
      list
        ? groupByDate(list.transactions).map((group) => ({ date: group.date, data: group.transactions }))
        : [],
    [list],
  );

  const activeIds = accounts?.active.map((a) => a.id) ?? [];
  const canAdd = activeIds.length > 0 && (fixedAccountId === null || activeIds.includes(fixedAccountId));
  const noAccounts = accounts !== null && accounts.active.length === 0 && accounts.archived.length === 0;
  const defaultAccount = filters.accountId !== null && activeIds.includes(filters.accountId) ? filters.accountId : null;

  const filterBar = (
    <View style={styles.filters}>
      <View style={styles.monthRow}>
        <IconButton
          icon="chevron-left"
          accessibilityLabel="Previous month"
          onPress={() => applyFilters({ month: shiftMonth(filters.month, -1) })}
        />
        <Text variant="titleMedium" accessibilityLiveRegion="polite">
          {formatMonth(filters.month)}
        </Text>
        <IconButton
          icon="chevron-right"
          accessibilityLabel="Next month"
          disabled={filters.month >= thisMonth}
          onPress={() => applyFilters({ month: shiftMonth(filters.month, 1) })}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        <Chip selected={filters.type === null} showSelectedCheck onPress={() => applyFilters({ type: null })}>
          All types
        </Chip>
        {TRANSACTION_TYPES.map((option) => (
          <Chip
            key={option.value}
            selected={filters.type === option.value}
            showSelectedCheck
            onPress={() => applyFilters({ type: option.value })}
          >
            {option.label}
          </Chip>
        ))}
      </ScrollView>
      {fixedAccountId === null && accounts !== null && !noAccounts ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          <Chip selected={filters.accountId === null} showSelectedCheck onPress={() => applyFilters({ accountId: null })}>
            All accounts
          </Chip>
          {[...accounts.active, ...accounts.archived].map((account) => (
            <Chip
              key={account.id}
              selected={filters.accountId === account.id}
              showSelectedCheck
              onPress={() => applyFilters({ accountId: account.id })}
            >
              {account.archived ? `${account.name} (archived)` : account.name}
            </Chip>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      {list === null && error === null ? (
        <>
          {filterBar}
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading transactions" />
          </View>
        </>
      ) : list === null ? (
        <>
          {filterBar}
          <View style={styles.center}>
            <Text variant="bodyLarge" style={styles.centerText}>
              {error}
            </Text>
            <Button mode="contained" onPress={() => void refresh()} loading={refreshing} disabled={refreshing}>
              Try again
            </Button>
          </View>
        </>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(tx) => String(tx.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={styles.content}
          ItemSeparatorComponent={Divider}
          stickySectionHeadersEnabled={false}
          ListHeaderComponent={
            <View>
              {filterBar}
              {fixedAccountId === null ? (
                // Rendered even when empty, so a failed skip's message still shows.
                <View style={due.length > 0 ? styles.due : styles.dueEmpty}>
                  <DueList items={due} goals={goalsDue} onChanged={() => void load()} />
                </View>
              ) : null}
              <View style={styles.header}>
                {error ? (
                  <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.error, marginBottom: 12 }}>
                    {error} Pull down to try again.
                  </Text>
                ) : null}
                <Surface elevation={1} style={styles.totals}>
                  <View style={styles.total}>
                    <Text variant="labelLarge">Income</Text>
                    <Text variant="titleLarge" style={styles.totalAmount}>
                      {formatRupees(list.total_income)}
                    </Text>
                  </View>
                  <View style={styles.total}>
                    <Text variant="labelLarge">Spent</Text>
                    <Text variant="titleLarge" style={styles.totalAmount}>
                      {formatRupees(list.total_expense)}
                    </Text>
                  </View>
                </Surface>
              </View>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <Text variant="titleSmall" accessibilityRole="header" style={[styles.sectionHeader, { color: colors.primary }]}>
              {formatDate(section.date)}
            </Text>
          )}
          renderItem={({ item }) => (
            <TransactionRow
              transaction={item}
              viewedAccountId={filters.accountId}
              onPress={() => open({ id: String(item.id) })}
            />
          )}
          ListEmptyComponent={
            noAccounts ? (
              <View style={styles.empty}>
                <Text variant="titleMedium">Add an account first</Text>
                <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
                  Every transaction belongs to an account.
                </Text>
                <Button mode="contained" onPress={() => router.navigate("/accounts")}>
                  Go to accounts
                </Button>
              </View>
            ) : (
              <View style={styles.empty}>
                <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
                  No transactions match in {formatMonth(filters.month)}.
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            // The account's investment activity sits above Load more, so the button stays last.
            <View>
              {fixedAccountId !== null && filters.type === null && activity === undefined ? (
                <Text variant="bodyMedium" style={[styles.centerText, styles.activityNote, { color: colors.onSurfaceVariant }]}>
                  Investment activity could not be loaded. Pull down to try again.
                </Text>
              ) : null}
              {fixedAccountId !== null && filters.type === null && activity ? (
                activity.length > 0 ? (
                  <View accessibilityRole="list">
                    <Text variant="titleSmall" accessibilityRole="header" style={[styles.sectionHeader, { color: colors.primary }]}>
                      Investment activity
                    </Text>
                    {activity.map((row, index) => (
                      <View key={`${row.kind}-${row.trade_id}`}>
                        {index > 0 ? <Divider /> : null}
                        <ActivityRow activity={row} onPress={() => openInstrument(row)} />
                      </View>
                    ))}
                  </View>
                ) : null
              ) : null}
              {list.has_more ? (
                <Button onPress={() => void loadMore()} loading={loadingMore} disabled={loadingMore} style={styles.more}>
                  {loadingMore ? "Loading..." : "Load more"}
                </Button>
              ) : null}
            </View>
          }
        />
      )}

      {canAdd ? (
        <FAB
          icon="plus"
          label="Add"
          accessibilityLabel="Add transaction"
          style={styles.fab}
          onPress={() => open(defaultAccount === null ? {} : { account: String(defaultAccount) })}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { paddingBottom: 96 },
  filters: { gap: 8, paddingBottom: 8 },
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  chipRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16 },
  header: { paddingHorizontal: 16, paddingTop: 8 },
  due: { paddingHorizontal: 16, paddingTop: 8 },
  dueEmpty: { paddingHorizontal: 16 },
  totals: { borderRadius: 12, padding: 16, gap: 12 },
  total: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  totalAmount: { flexShrink: 1, textAlign: "right" },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  rowMain: { flex: 1, gap: 2 },
  rowAmount: { flexShrink: 1, maxWidth: "55%", alignItems: "flex-end" },
  amountText: { textAlign: "right" },
  empty: { alignItems: "center", gap: 8, padding: 32 },
  more: { marginTop: 8 },
  activityNote: { paddingHorizontal: 16, paddingTop: 16 },
  fab: { position: "absolute", right: 16, bottom: 16 },
});
