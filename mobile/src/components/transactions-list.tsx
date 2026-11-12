import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, SectionList, StyleSheet, View } from "react-native";
import { Searchbar, Text, useTheme } from "react-native-paper";

import { ChunkyButton, Chip, HeaderAction, Row, StackedBar, Tag, Tile } from "@/components/chunky";

import { DueList } from "@/components/due-list";
import type { GoalDue } from "@/lib/goals";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { whole } from "@/lib/recurring";
import { BRAND } from "@/lib/theme";
import { categoryEmoji, investmentEmoji } from "@/lib/fun";
import type { DueItem } from "@/lib/recurring";
import {
  type FilterKey,
  type TransactionFilters,
  blankFilters,
  dateRangeLabel,
  filterChips,
  filterHandoff,
  hasDateRange,
  isNarrowed,
  removeFilter,
  transactionsQuery,
} from "@/lib/search";
import { useSession } from "@/lib/session";
import {
  TRANSACTION_TYPES,
  type Activity,
  type Transaction,
  type TransactionList,
  dayLabel,
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
const SEARCH_DELAY_MS = 400;

type Filters = TransactionFilters;
type Accounts = { active: Account[]; archived: Account[] };

const query = (filters: Filters, offset: number) => transactionsQuery(filters, offset, PAGE_SIZE);

const amountTone = (amount: string) => (amount.startsWith("+") ? "gain" : amount.startsWith("-") ? "loss" : undefined);

export function TransactionRow({
  transaction: tx,
  viewedAccountId,
  onPress,
}: {
  transaction: Transaction;
  viewedAccountId: number | null;
  onPress: () => void;
}) {
  // An SMS can record money before its category is known; To review asks for it.
  const title = tx.type === "transfer" ? "Transfer" : tx.type === "emi" ? `EMI · ${tx.to_account_name}` : (tx.category ?? "Uncategorised");
  const accounts =
    tx.type === "transfer"
      ? `${tx.account_name} → ${tx.to_account_name}`
      : tx.type === "emi" && tx.interest !== null
        ? `${tx.account_name} · ${formatRupees(tx.interest)} interest`
        : tx.account_name;
  const amount = signedAmount(tx, viewedAccountId);
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={tx.type === "transfer" ? "🔁" : tx.type === "emi" ? "🏧" : categoryEmoji(tx.category)}
        tone={tx.type === "income" ? "green" : tx.type === "expense" ? "pink" : tx.type === "emi" ? "purple" : "blue"}
        title={title ?? ""}
        meta={tx.note ? `${accounts} · ${tx.note}` : accounts}
        amount={amount}
        amountTone={amountTone(amount)}
        sub={
          tx.from_sms ? (
            <>
              {tx.editable ? null : <Text variant="bodySmall" style={styles.archived}>Archived</Text>}
              <Tag label="SMS" />
            </>
          ) : tx.editable ? undefined : (
            "Archived"
          )
        }
        onPress={tx.editable ? onPress : undefined}
        accessibilityLabel={`${title}, ${amount}, ${accounts}${tx.from_sms ? ", from a bank SMS" : ""}`}
      />
    </View>
  );
}

// The month's spending, split by category. The bar is left out when there is nothing to split.
export function SpentTile({ list, label }: { list: TransactionList; label: string }) {
  const split = list.expense_by_category.map((c) => ({ label: c.category, value: Number(c.amount) }));
  return (
    <Tile tone="card" label={label} value={whole(list.total_expense)} size="huge">
      <View style={styles.incomeLine}>
        <Text variant="labelLarge" style={styles.incomeLabel}>
          Income
        </Text>
        <Text variant="titleMedium" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={styles.incomeAmount}>
          {whole(list.total_income)}
        </Text>
      </View>
      <StackedBar items={split} label="Spending by category" />
    </Tile>
  );
}

// "TODAY", "YESTERDAY", then a date.
export function DayHeader({ date, today }: { date: string; today: string }) {
  return (
    <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionHeader}>
      {dayLabel(date, today).toUpperCase()}
    </Text>
  );
}

// One buy or sell in an investment account. Read-only: tapping opens the stock, fund or coin.
function ActivityRow({ activity, onPress }: { activity: Activity; onPress: () => void }) {
  const label = activityLabel(activity);
  const amount = activityAmount(activity.signed_amount);
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={investmentEmoji(activity.kind)}
        tone="purple"
        title={label}
        meta={formatDate(activity.date)}
        amount={amount}
        amountTone={amountTone(amount)}
        onPress={onPress}
        accessibilityLabel={`${label}, ${amount}, ${formatDate(activity.date)}`}
        accessibilityHint="Opens it"
      />
    </View>
  );
}

// `fixedAccountId` shows one account's transactions, in place of the account filter.
export function TransactionsList({ fixedAccountId = null }: { fixedAccountId?: number | null }) {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [thisMonth] = useState(() => todayIndia().slice(0, 7));
  const [filters, setFilters] = useState<Filters>(() => blankFilters(thisMonth, fixedAccountId));
  // Search and the filter sheet are for the main list; one account's list keeps its type chips.
  const searchable = fixedAccountId === null;
  // What is typed in the search box; it reaches the filters after a pause.
  const [search, setSearch] = useState("");
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
    // `keep` leaves the current rows up while the new ones load, so typing in the search box (which
    // sits in the list's header) never unmounts it and drops the keyboard.
    (change: Partial<Filters>, keep = false) => {
      const next = { ...filtersRef.current, ...change };
      filtersRef.current = next;
      setFilters(next);
      if (!keep) {
        setList(null);
        // The old month's rows must not show while the new month loads.
        setActivity(null);
      }
      setError(null);
      void load();
    },
    [load],
  );

  // Reloads whenever the screen regains focus, so coming back from the form shows fresh data. New
  // filters from the filter sheet or the month screen land here too.
  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
      const month = savedMonth.current;
      savedMonth.current = null;
      const handed = searchable ? filterHandoff.next : null;
      filterHandoff.next = null;
      if (handed) {
        setSearch(handed.q);
        applyFilters(handed);
      } else if (month && month !== filtersRef.current.month && !hasDateRange(filtersRef.current)) {
        applyFilters({ month });
      } else {
        void load();
      }
    }, [load, applyFilters, searchable]),
  );

  // The search box applies after a pause in typing.
  useEffect(() => {
    if (search.trim() === filtersRef.current.q.trim()) return;
    const timer = setTimeout(() => applyFilters({ q: search }, true), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search, applyFilters]);

  const openFilters = () => {
    if (navigating.current) return;
    navigating.current = true;
    filterHandoff.draft = { ...filtersRef.current, q: search };
    router.push("/transaction-filters");
  };

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

  const today = todayIndia();
  const activeIds = accounts?.active.map((a) => a.id) ?? [];
  const canAdd = activeIds.length > 0 && (fixedAccountId === null || activeIds.includes(fixedAccountId));
  const noAccounts = accounts !== null && accounts.active.length === 0 && accounts.archived.length === 0;
  const defaultAccount = filters.accountId !== null && activeIds.includes(filters.accountId) ? filters.accountId : null;

  const ranged = hasDateRange(filters);
  const narrowed = isNarrowed(filters, !searchable);
  const accountName = (id: number) => [...(accounts?.active ?? []), ...(accounts?.archived ?? [])].find((a) => a.id === id)?.name;
  const chips = searchable ? filterChips(filters, accountName) : [];
  const dropFilter = (key: FilterKey) => applyFilters(removeFilter(filtersRef.current, key));
  const periodText = ranged ? (dateRangeLabel(filters.dateFrom, filters.dateTo) ?? "") : formatMonth(filters.month);
  const spentLabel = ranged
    ? "Spent in these dates"
    : filters.month === thisMonth
      ? "Spent this month"
      : `Spent in ${formatMonth(filters.month)}`;

  const filterBar = (
    <View style={styles.filters}>
      {ranged ? (
        <Text variant="titleMedium" accessibilityLiveRegion="polite" style={[styles.month, styles.range]}>
          {periodText}
        </Text>
      ) : (
        <View style={styles.monthRow}>
          <HeaderAction
            icon="chevron-left"
            label="Previous month"
            onPress={() => applyFilters({ month: shiftMonth(filters.month, -1) })}
          />
          <Text variant="titleMedium" accessibilityLiveRegion="polite" style={styles.month}>
            {periodText}
          </Text>
          <HeaderAction
            icon="chevron-right"
            label="Next month"
            disabled={filters.month >= thisMonth}
            onPress={() => applyFilters({ month: shiftMonth(filters.month, 1) })}
          />
        </View>
      )}
      {searchable ? (
        <>
          <View style={styles.search}>
            <Searchbar
              placeholder="Search notes, payees, categories"
              value={search}
              onChangeText={setSearch}
              onSubmitEditing={() => applyFilters({ q: search }, true)}
              onClearIconPress={() => applyFilters({ q: "" }, true)}
              maxLength={100}
              autoCorrect={false}
              returnKeyType="search"
              style={styles.searchbar}
              inputStyle={styles.searchInput}
            />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.chipRow}
          >
            <Chip
              label={chips.length > 0 ? `Filters · ${chips.length}` : "Filters"}
              icon="tune-variant"
              selected={chips.length > 0}
              onPress={openFilters}
              accessibilityHint="Opens the filters"
            />
            {chips.map((chip) => (
              <Chip
                key={chip.key}
                label={chip.label}
                icon="close"
                onPress={() => dropFilter(chip.key)}
                accessibilityLabel={`Remove filter: ${chip.label}`}
              />
            ))}
          </ScrollView>
        </>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          <Chip label="All types" selected={filters.type === null} onPress={() => applyFilters({ type: null })} />
          {TRANSACTION_TYPES.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={filters.type === option.value}
              onPress={() => applyFilters({ type: option.value })}
            />
          ))}
        </ScrollView>
      )}
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
            <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
          </View>
        </>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(tx) => String(tx.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={styles.content}
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
                  <Text variant="bodyMedium" accessibilityRole="alert" style={styles.error}>
                    {error} Pull down to try again.
                  </Text>
                ) : null}
                <SpentTile list={list} label={narrowed ? `${spentLabel} · matching` : spentLabel} />
              </View>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <DayHeader date={section.date} today={today} />
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
                <Text variant="bodyMedium" style={[styles.centerText, styles.muted]}>
                  Every transaction belongs to an account.
                </Text>
                <ChunkyButton label="Go to accounts" onPress={() => router.navigate("/accounts")} />
              </View>
            ) : (
              <View style={styles.empty}>
                <Text variant="bodyMedium" style={[styles.centerText, styles.muted]}>
                  {narrowed || ranged ? `No transactions match in ${periodText}.` : `No transactions in ${periodText}.`}
                </Text>
              </View>
            )
          }
          ListFooterComponent={
            // The account's investment activity sits above Load more, so the button stays last.
            <View>
              {fixedAccountId !== null && filters.type === null && activity === undefined ? (
                <Text variant="bodyMedium" style={[styles.centerText, styles.activityNote, styles.muted]}>
                  Investment activity could not be loaded. Pull down to try again.
                </Text>
              ) : null}
              {fixedAccountId !== null && filters.type === null && activity ? (
                activity.length > 0 ? (
                  <View accessibilityRole="list">
                    <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionHeader}>
                      INVESTMENT ACTIVITY
                    </Text>
                    {activity.map((row) => (
                      <View key={`${row.kind}-${row.trade_id}`}>
                        <ActivityRow activity={row} onPress={() => openInstrument(row)} />
                      </View>
                    ))}
                  </View>
                ) : null
              ) : null}
              {list.has_more ? (
                <ChunkyButton
                  variant="alt"
                  label={loadingMore ? "Loading..." : "Load more"}
                  onPress={() => void loadMore()}
                  loading={loadingMore}
                  style={styles.more}
                />
              ) : null}
            </View>
          }
        />
      )}

      {canAdd ? (
        <View style={styles.fab}>
          <ChunkyButton
            variant="green"
            icon="plus"
            label="Add"
            accessibilityLabel="Add transaction"
            onPress={() => open(defaultAccount === null ? {} : { account: String(defaultAccount) })}
          />
        </View>
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
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16 },
  month: { flex: 1, textAlign: "center", color: BRAND.ink },
  range: { paddingHorizontal: 16, paddingVertical: 10 },
  search: { paddingHorizontal: 16 },
  searchbar: { backgroundColor: BRAND.card, borderWidth: 2.5, borderColor: BRAND.ink, borderRadius: 14, elevation: 0 },
  searchInput: { minHeight: 0 },
  chipRow: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  header: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  due: { paddingHorizontal: 16, paddingTop: 8 },
  dueEmpty: { paddingHorizontal: 16 },
  error: { color: BRAND.loss },
  muted: { color: BRAND.zinc600 },
  archived: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16, textAlign: "right" },
  incomeLine: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginTop: 4 },
  incomeLabel: { color: BRAND.zinc600 },
  incomeAmount: { flexShrink: 1, color: BRAND.gain, textAlign: "right", fontVariant: ["tabular-nums"] },
  sectionHeader: { color: BRAND.ink, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, letterSpacing: 0.6 },
  rowWrap: { paddingHorizontal: 16, paddingVertical: 4 },
  empty: { alignItems: "center", gap: 8, padding: 32 },
  more: { marginTop: 8, marginHorizontal: 16 },
  activityNote: { paddingHorizontal: 16, paddingTop: 16 },
  fab: { position: "absolute", right: 16, bottom: 16 },
});
