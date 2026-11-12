import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { FAB, Icon, Text, useTheme } from "react-native-paper";

import { ChunkyBox, ChunkyButton, Chip, Row, ScreenHeader, Segmented } from "@/components/chunky";
import { GoalTagLine } from "@/components/goal-tag";
import { LinkPrompt } from "@/components/link-prompt";
import { GainPill, TileLine, WorthTile } from "@/components/investment-parts";
import { Signed, signedLabel } from "@/components/signed";
import { type GoalTag, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type CoinTotal, type CryptoTradeMode, formatCoinAverage, formatCoinPrice, formatCoinQty } from "@/lib/crypto";
import { type FundTotal, type FundTradeMode, type Sip, dueText, formatNav, formatUnits } from "@/lib/funds";
import { type DepositRow, type DepositsPortfolio, type Portfolio, type StockTotal, type Totals, type Unlinked, formatSigned, tone } from "@/lib/investments";
import { accountEmoji, investmentEmoji, investmentSticker } from "@/lib/fun";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";
import { formatDate } from "@/lib/transactions";

type Kind = "buy" | "sell" | "opening";
type Segment = "stocks" | "funds" | "deposits" | "crypto";
type Go = (target: Parameters<typeof router.push>[0]) => void;

// The goal each instrument is in, from its per-account holdings (an instrument is in one goal at most).
function goalsOf<T extends { in_goal?: GoalTag | null }>(rows: T[], id: (row: T) => number): Map<number, GoalTag> {
  const tags = new Map<number, GoalTag>();
  for (const row of rows) if (row.in_goal) tags.set(id(row), row.in_goal);
  return tags;
}

export default function InvestmentsScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [unlinked, setUnlinked] = useState<Unlinked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const [focused, setFocused] = useState(true);
  const [soldOpen, setSoldOpen] = useState(false);
  const [redeemedOpen, setRedeemedOpen] = useState(false);
  const [coinsSoldOpen, setCoinsSoldOpen] = useState(false);
  const [segment, setSegment] = useState<Segment>("stocks");
  const latest = useRef(0);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    // The link prompt is a nicety: if its list fails, the tab works without it.
    const unlinkedRequest = apiFetch<Unlinked>("/investments/unlinked", { token: token ?? undefined }).catch(() => null);
    try {
      const result = await apiFetch<Portfolio>("/investments/portfolio", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setPortfolio(result);
      setError(null);
      const list = await unlinkedRequest;
      if (mine === latest.current && list) setUnlinked(list);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setError(errorMessage(err));
    }
  }, [token, logOut]);

  // Reloads whenever the tab regains focus, so coming back from a form shows fresh figures.
  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
      setFocused(true);
      void load();
      // Once per focus: fetch fresh coin prices if the server says they are stale, then reload.
      // A failure is ignored; the tab keeps what it has.
      let current = true;
      apiFetch<{ refreshed: boolean }>("/investments/coins/refresh", { method: "POST", token: token ?? undefined })
        .then((result) => {
          if (current && result.refreshed) void load();
        })
        .catch(() => undefined);
      return () => {
        current = false;
        setFocused(false);
        setFabOpen(false);
      };
    }, [load, token]),
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
  const go = useCallback<Go>((target) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  }, []);

  const addTrade = (kind: Kind) =>
    go({ pathname: "/trade-form", params: kind === "opening" ? { opening: "1" } : { side: kind } });
  const openStock = (row: { stock_id: number; symbol: string }) =>
    go({ pathname: "/stock", params: { id: String(row.stock_id), symbol: row.symbol } });
  const openCoin = (row: { coin_id: number; symbol: string }) =>
    go({ pathname: "/coin", params: { id: String(row.coin_id), symbol: row.symbol } });
  const addCoinTrade = (mode: CryptoTradeMode) => go({ pathname: "/crypto-trade-form", params: { mode } });
  const openFund = (row: { fund_id: number; symbol: string }) =>
    go({ pathname: "/fund", params: { id: String(row.fund_id), symbol: row.symbol } });
  // Deposits are accounts, so their actions (deposit, interest, close) live on the Accounts tab.
  const openAccounts = () => router.navigate("/accounts");
  const addFundTrade = (mode: FundTradeMode) => go({ pathname: "/fund-trade-form", params: { mode } });
  // Opens Record SIP for the SIP's oldest due month, with everything but the NAV filled in.
  const recordSip = (sip: Sip) =>
    go({
      pathname: "/fund-trade-form",
      params: { mode: "sip", fundId: String(sip.fund_id), sipId: String(sip.id), ...(sip.due_date ? { date: sip.due_date } : {}) },
    });

  const dueSips = portfolio?.funds.due_sips ?? [];
  const dueCards =
    dueSips.length > 0 ? (
      <View style={styles.dueList}>
        {dueSips.map((sip) => (
          <DueCard key={sip.id} sip={sip} onPress={() => recordSip(sip)} />
        ))}
      </View>
    ) : null;

  const errorLine = error ? (
    <Text variant="bodyMedium" accessibilityRole="alert" style={styles.error}>
      {error} Pull down to try again.
    </Text>
  ) : null;

  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />;

  let body: React.ReactNode;
  if (portfolio === null && error === null) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading investments" />
      </View>
    );
  } else if (portfolio === null) {
    body = (
      <View style={styles.center}>
        <Text variant="bodyLarge" style={styles.centerText}>
          {error}
        </Text>
        <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
      </View>
    );
  } else if (segment === "stocks") {
    const empty = portfolio.by_stock.length === 0 && portfolio.closed.length === 0;
    const stockGoals = goalsOf(portfolio.holdings, (h) => h.stock_id);
    body = (
      <FlatList
        data={portfolio.by_stock}
        keyExtractor={(row) => String(row.stock_id)}
        refreshControl={refreshControl}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            {errorLine}
            {dueCards}
            <LinkPrompt
              items={(unlinked?.stocks ?? []).map((x) => ({ id: x.id, text: x.symbol }))}
              onOpen={(item) => go({ pathname: "/stock", params: { id: String(item.id), symbol: item.text } })}
            />
            {empty ? null : <SummaryTile totals={portfolio.totals} kind="stock" />}
            {portfolio.by_stock.length > 0 ? <SectionTitle label="Holdings" /> : null}
          </View>
        }
        ListFooterComponent={
          portfolio.closed.length > 0 ? (
            <ClosedSection title={`Sold (${portfolio.closed.length})`} expanded={soldOpen} onToggle={() => setSoldOpen((open) => !open)}>
              {portfolio.closed.map((c) => (
                <ClosedRow
                  key={`${c.stock_id}-${c.account_id}`}
                  kind="stock"
                  title={c.symbol}
                  detail={`${c.name} · ${c.account_name}`}
                  realised={c.realised}
                  hint="Opens the stock"
                  onPress={() => openStock(c)}
                />
              ))}
            </ClosedSection>
          ) : undefined
        }
        renderItem={({ item }) => (
          <HoldingRow row={item} goal={stockGoals.get(item.stock_id)} onPress={() => openStock(item)} />
        )}
        ListEmptyComponent={
          empty ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">Add your shares</Text>
              <Text variant="bodyMedium" style={styles.emptyText}>
                Enter shares you already own, or record a buy. Buys and sells move your broker account&apos;s cash.
              </Text>
              <ChunkyButton variant="alt" label="Add existing shares" onPress={() => addTrade("opening")} />
            </View>
          ) : undefined
        }
      />
    );
  } else if (segment === "deposits") {
    const deposits = portfolio.deposits;
    const rows = deposits?.accounts ?? [];
    body = (
      <FlatList
        data={rows}
        keyExtractor={(row) => String(row.account_id)}
        refreshControl={refreshControl}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            {errorLine}
            {rows.length > 0 && deposits ? <DepositsSummary deposits={deposits} /> : null}
            {rows.length > 0 ? <SectionTitle label="Deposits" /> : null}
          </View>
        }
        renderItem={({ item }) => <DepositCard row={item} onPress={() => openAccounts()} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text variant="titleMedium">No PPF or RD yet</Text>
            <Text variant="bodyMedium" style={styles.emptyText}>
              Add a PPF or recurring deposit as an account. It shows here with its balance and the interest it has
              earned so far.
            </Text>
            <ChunkyButton variant="alt" label="Go to Accounts" onPress={() => openAccounts()} />
          </View>
        }
      />
    );
  } else if (segment === "crypto") {
    const crypto = portfolio.crypto;
    const empty = crypto.by_coin.length === 0 && crypto.closed.length === 0;
    const coinGoals = goalsOf(crypto.holdings, (h) => h.coin_id);
    body = (
      <FlatList
        data={crypto.by_coin}
        keyExtractor={(row) => String(row.coin_id)}
        refreshControl={refreshControl}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            {errorLine}
            <LinkPrompt
              items={(unlinked?.coins ?? []).map((x) => ({ id: x.id, text: x.symbol }))}
              onOpen={(item) => go({ pathname: "/coin", params: { id: String(item.id), symbol: item.text } })}
            />
            {empty ? null : <SummaryTile totals={crypto.totals} kind="crypto" />}
            {crypto.by_coin.length > 0 ? <SectionTitle label="Coins" /> : null}
          </View>
        }
        ListFooterComponent={
          crypto.closed.length > 0 ? (
            <ClosedSection
              title={`Sold (${crypto.closed.length})`}
              expanded={coinsSoldOpen}
              onToggle={() => setCoinsSoldOpen((open) => !open)}
            >
              {crypto.closed.map((c) => (
                <ClosedRow
                  key={`${c.coin_id}-${c.account_id}`}
                  kind="crypto"
                  title={c.name}
                  detail={`${c.symbol} · ${c.account_name}`}
                  realised={c.realised}
                  hint="Opens the coin"
                  onPress={() => openCoin(c)}
                />
              ))}
            </ClosedSection>
          ) : undefined
        }
        renderItem={({ item }) => (
          <CoinRow row={item} goal={coinGoals.get(item.coin_id)} onPress={() => openCoin(item)} />
        )}
        ListEmptyComponent={
          empty ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">Add your crypto</Text>
              <Text variant="bodyMedium" style={styles.emptyText}>
                Enter coins you already hold, or record a buy. Prices are typed in by hand, so until you add one coins are
                valued at cost.
              </Text>
              <ChunkyButton variant="alt" label="Add existing coins" onPress={() => addCoinTrade("opening")} />
            </View>
          ) : undefined
        }
      />
    );
  } else {
    const funds = portfolio.funds;
    const empty = funds.by_fund.length === 0 && funds.closed.length === 0;
    const fundGoals = goalsOf(funds.holdings, (h) => h.fund_id);
    body = (
      <FlatList
        data={funds.by_fund}
        keyExtractor={(row) => String(row.fund_id)}
        refreshControl={refreshControl}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            {errorLine}
            {dueCards}
            <LinkPrompt
              items={(unlinked?.funds ?? []).map((x) => ({ id: x.id, text: x.name }))}
              onOpen={(item) => go({ pathname: "/fund", params: { id: String(item.id) } })}
            />
            {empty ? null : <SummaryTile totals={funds.totals} kind="mutual_fund" />}
            {funds.by_fund.length > 0 ? <SectionTitle label="Funds" /> : null}
          </View>
        }
        ListFooterComponent={
          funds.closed.length > 0 ? (
            <ClosedSection
              title={`Redeemed (${funds.closed.length})`}
              expanded={redeemedOpen}
              onToggle={() => setRedeemedOpen((open) => !open)}
            >
              {funds.closed.map((c) => (
                <ClosedRow
                  key={`${c.fund_id}-${c.account_id}`}
                  kind="mutual_fund"
                  title={c.name}
                  detail={`${c.symbol} · ${c.account_name}`}
                  realised={c.realised}
                  hint="Opens the fund"
                  onPress={() => openFund(c)}
                />
              ))}
            </ClosedSection>
          ) : undefined
        }
        renderItem={({ item }) => (
          <FundRow row={item} goal={fundGoals.get(item.fund_id)} onPress={() => openFund(item)} />
        )}
        ListEmptyComponent={
          empty ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">Add your mutual funds</Text>
              <Text variant="bodyMedium" style={styles.emptyText}>
                Enter units you already hold, or add a SIP. Each month a SIP shows here as due until you record it with
                that day&apos;s NAV.
              </Text>
              <ChunkyButton variant="alt" label="Add existing units" onPress={() => addFundTrade("opening")} />
              <ChunkyButton variant="alt" label="Add SIP" onPress={() => go({ pathname: "/sip-form" })} />
            </View>
          ) : undefined
        }
      />
    );
  }

  const hasHoldings = (portfolio?.holdings.length ?? 0) > 0;
  const hasCoinHoldings = (portfolio?.crypto.holdings.length ?? 0) > 0;
  const hasFundHoldings = (portfolio?.funds.holdings.length ?? 0) > 0;
  // With one SIP due, Record SIP goes straight to it; otherwise the form asks which.
  const onlyDue = dueSips.length === 1 ? dueSips[0] : null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Investments" />

      <View style={styles.segments}>
        <Segmented<Segment>
          label="Investment type"
          value={segment}
          onChange={(value) => {
            setFabOpen(false);
            setSegment(value);
          }}
          options={[
            { value: "stocks", label: "Stocks" },
            { value: "funds", label: "Funds" },
            { value: "deposits", label: "Deposits" },
            { value: "crypto", label: "Crypto" },
          ]}
        />
      </View>

      {body}

      {segment === "deposits" ? null : segment === "stocks" ? (
        <FAB.Group
          open={fabOpen}
          visible={focused && portfolio !== null}
          icon={fabOpen ? "close" : "plus"}
          label={fabOpen ? undefined : "Add trade"}
          accessibilityLabel={fabOpen ? "Close trade options" : "Add a trade"}
          fabStyle={styles.fab}
          onStateChange={({ open }) => setFabOpen(open)}
          actions={[
            { ...look, icon: "archive-arrow-down-outline", label: "Add existing shares", onPress: () => addTrade("opening") },
            ...(hasHoldings ? [{ ...look, icon: "minus", label: "Sell", onPress: () => addTrade("sell") }] : []),
            { ...look, icon: "plus", label: "Buy", onPress: () => addTrade("buy") },
          ]}
        />
      ) : segment === "crypto" ? (
        <FAB.Group
          open={fabOpen}
          visible={focused && portfolio !== null}
          icon={fabOpen ? "close" : "plus"}
          label={fabOpen ? undefined : "Add"}
          accessibilityLabel={fabOpen ? "Close crypto options" : "Add a crypto transaction"}
          fabStyle={styles.fab}
          onStateChange={({ open }) => setFabOpen(open)}
          actions={[
            { ...look, icon: "archive-arrow-down-outline", label: "Add existing coins", onPress: () => addCoinTrade("opening") },
            ...(hasCoinHoldings ? [{ ...look, icon: "minus", label: "Sell", onPress: () => addCoinTrade("sell") }] : []),
            { ...look, icon: "plus", label: "Buy", onPress: () => addCoinTrade("buy") },
          ]}
        />
      ) : (
        <FAB.Group
          open={fabOpen}
          visible={focused && portfolio !== null}
          icon={fabOpen ? "close" : "plus"}
          label={fabOpen ? undefined : "Add"}
          accessibilityLabel={fabOpen ? "Close fund options" : "Add a fund transaction or SIP"}
          fabStyle={styles.fab}
          onStateChange={({ open }) => setFabOpen(open)}
          actions={[
            { ...look, icon: "calendar-sync-outline", label: "Add SIP", onPress: () => go({ pathname: "/sip-form" }) },
            { ...look, icon: "archive-arrow-down-outline", label: "Add existing units", onPress: () => addFundTrade("opening") },
            ...(hasFundHoldings ? [{ ...look, icon: "minus", label: "Redeem", onPress: () => addFundTrade("sell") }] : []),
            { ...look, icon: "plus", label: "Buy", onPress: () => addFundTrade("buy") },
            {
              ...look,
              icon: "calendar-check-outline",
              label: "Record SIP",
              onPress: () => (onlyDue ? recordSip(onlyDue) : addFundTrade("sip")),
            },
          ]}
        />
      )}
    </View>
  );
}

// One SIP that is due. The whole card is the button: it opens Record SIP with only the NAV left to type.
function DueCard({ sip, onPress }: { sip: Sip; onPress: () => void }) {
  const text = dueText(sip);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint="Opens Record SIP with the NAV to type"
    >
      {({ pressed }) => (
        <ChunkyBox pressed={pressed} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.due}>
          <Icon source="calendar-clock" size={24} color={BRAND.ink} />
          <Text variant="bodyMedium" style={styles.dueText}>
            {text}
          </Text>
          <Icon source="chevron-right" size={24} color={BRAND.ink} />
        </ChunkyBox>
      )}
    </Pressable>
  );
}

// The worth of the segment: a blue tile with the sticker, the gain on a pill, and invested and realised.
function SummaryTile({ totals, kind }: { totals: Totals; kind: "stock" | "mutual_fund" | "crypto" }) {
  return (
    <WorthTile
      label={`${investmentEmoji(kind)} Current value`}
      value={formatRupees(totals.value)}
      sticker={investmentSticker(totals.unrealised_percent)}
    >
      <GainPill unrealised={totals.unrealised} percent={totals.unrealised_percent} label="Unrealised P&L" />
      <TileLine label="Invested" value={formatRupees(totals.invested)} />
      <TileLine
        label="Realised P&L"
        value={formatSigned(totals.realised)}
        accessibilityLabel={`Realised P&L ${signedLabel(totals.realised)}`}
      />
    </WorthTile>
  );
}

function DepositsSummary({ deposits }: { deposits: DepositsPortfolio }) {
  return (
    <WorthTile tone="orange" label="🐷 In deposits" value={formatRupees(deposits.value)}>
      <Text variant="bodyMedium" style={styles.onTile}>
        ≈ {formatRupees(deposits.interest_estimate)} interest (estimate)
      </Text>
    </WorthTile>
  );
}

// One PPF or RD. The whole card opens the Accounts tab, where its actions are.
function DepositCard({ row, onPress }: { row: DepositRow; onPress: () => void }) {
  const kindLabel = row.type === "ppf" ? "PPF" : "RD";
  const maturity = row.maturity_date ? `Matures ${formatDate(row.maturity_date)}` : null;
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={accountEmoji(row.type)}
        tone="orange"
        title={row.name}
        meta={`${kindLabel}${maturity ? ` · ${maturity}` : ""}`}
        amount={formatRupees(row.balance)}
        sub={`≈ ${formatRupees(row.interest_estimate)} interest (estimate)`}
        onPress={onPress}
        accessibilityLabel={`${row.name}, ${kindLabel}, balance ${formatRupees(row.balance)}, about ${formatRupees(row.interest_estimate)} interest estimated${maturity ? `, ${maturity.toLowerCase()}` : ""}`}
        accessibilityHint="Opens Accounts"
      />
    </View>
  );
}

// "Sold (3)": a button that shows or hides the closed positions under it.
function ClosedSection({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.footer}>
      <View style={styles.footerHead}>
        <Chip icon={expanded ? "chevron-up" : "chevron-down"} label={title} selected={expanded} onPress={onToggle} />
      </View>
      {expanded ? children : null}
    </View>
  );
}

function SectionTitle({ label }: { label: string }) {
  return (
    <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionHeader}>
      {label.toUpperCase()}
    </Text>
  );
}

function ClosedRow({
  kind,
  title,
  detail,
  realised,
  hint,
  onPress,
}: {
  kind: "stock" | "mutual_fund" | "crypto";
  title: string;
  detail: string;
  realised: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={investmentEmoji(kind)}
        tone="card"
        title={title}
        meta={detail}
        caption="Realised"
        amount={formatSigned(realised)}
        amountTone={tone(realised) === "flat" ? undefined : (tone(realised) as "gain" | "loss")}
        onPress={onPress}
        accessibilityLabel={`${title}, ${detail}, realised ${signedLabel(realised)}`}
        accessibilityHint={hint}
      />
    </View>
  );
}

// The row's lines go in a column that keeps its natural width (up to 65%), so a long figure shrinks to fit.
function rowLines(sub: string | null, row: { unrealised: string; unrealised_percent: string }) {
  return (
    <>
      {sub ? (
        <Text variant="bodySmall" style={styles.rowSub}>
          {sub}
        </Text>
      ) : null}
      <Signed value={row.unrealised} variant="bodySmall" style={styles.signed} />
      <Signed value={row.unrealised_percent} percent variant="bodySmall" style={styles.signed} />
    </>
  );
}

function HoldingRow({ row, goal, onPress }: { row: StockTotal; goal?: GoalTag; onPress: () => void }) {
  const priced = row.at_cost ? "at cost" : row.price !== null ? `@ ${formatRupees(row.price)}` : null;
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={investmentEmoji("stock")}
        tone="blue"
        title={row.symbol}
        meta={
          <>
            <Text variant="bodySmall" style={styles.meta}>
              {row.name}
            </Text>
            <Text variant="bodySmall" style={styles.meta}>
              {row.shares} shares · avg {formatRupees(row.average_cost)}
            </Text>
            <GoalTagLine tag={goal} />
          </>
        }
        amount={formatRupees(row.value)}
        sub={rowLines(priced, row)}
        onPress={onPress}
        accessibilityLabel={`${row.symbol}, ${row.name}, ${row.shares} shares, worth ${formatRupees(row.value)}${row.at_cost ? " at cost" : ""}, unrealised ${signedLabel(row.unrealised)}, ${signedLabel(row.unrealised_percent, true)}${goal ? `, for ${goal.name}` : ""}`}
        accessibilityHint="Opens its trades and prices"
      />
    </View>
  );
}

// Fund names are long, so the name leads and the short symbol sits with the units underneath.
function FundRow({ row, goal, onPress }: { row: FundTotal; goal?: GoalTag; onPress: () => void }) {
  const priced = row.at_cost ? "at cost" : row.nav !== null ? `NAV ${formatNav(row.nav)}` : null;
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={investmentEmoji("mutual_fund")}
        tone="green"
        title={row.name}
        meta={
          <>
            <Text variant="bodySmall" style={styles.meta}>
              {row.symbol} · {formatUnits(row.units)} units
            </Text>
            <Text variant="bodySmall" style={styles.meta}>
              avg NAV {formatNav(row.average_nav)}
            </Text>
            <GoalTagLine tag={goal} />
          </>
        }
        amount={formatRupees(row.value)}
        sub={rowLines(priced, row)}
        onPress={onPress}
        accessibilityLabel={`${row.name}, ${formatUnits(row.units)} units, worth ${formatRupees(row.value)}${row.at_cost ? " at cost" : ""}, unrealised ${signedLabel(row.unrealised)}, ${signedLabel(row.unrealised_percent, true)}${goal ? `, for ${goal.name}` : ""}`}
        accessibilityHint="Opens its transactions, NAVs and SIPs"
      />
    </View>
  );
}

// Coin names lead, with the quantity and ticker underneath. Prices go through formatCoinPrice,
// averages through formatCoinAverage.
function CoinRow({ row, goal, onPress }: { row: CoinTotal; goal?: GoalTag; onPress: () => void }) {
  const priced = row.at_cost ? "at cost" : row.price !== null ? `@ ${formatCoinPrice(row.price)}` : null;
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={investmentEmoji("crypto")}
        tone="orange"
        title={row.name}
        meta={
          <>
            <Text variant="bodySmall" style={styles.meta}>
              {formatCoinQty(row.quantity)} {row.symbol}
            </Text>
            <Text variant="bodySmall" style={styles.meta}>
              avg {formatCoinAverage(row.average_price)}
            </Text>
            <GoalTagLine tag={goal} />
          </>
        }
        amount={formatRupees(row.value)}
        sub={rowLines(priced, row)}
        onPress={onPress}
        accessibilityLabel={`${row.name}, ${formatCoinQty(row.quantity)} ${row.symbol}, worth ${formatRupees(row.value)}${row.at_cost ? " at cost" : ""}, unrealised ${signedLabel(row.unrealised)}, ${signedLabel(row.unrealised_percent, true)}${goal ? `, for ${goal.name}` : ""}`}
        accessibilityHint="Opens its transactions and prices"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  segments: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  content: { paddingBottom: 112 },
  header: { paddingHorizontal: 16, paddingTop: 8, gap: 12 },
  error: { color: BRAND.loss },
  dueList: { gap: 12 },
  due: { backgroundColor: BRAND.due, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, minHeight: 56 },
  dueText: { flex: 1, color: BRAND.ink },
  onTile: { color: "#FFFFFF", marginTop: 6 },
  sectionHeader: { color: BRAND.ink, letterSpacing: 0.6, paddingTop: 8 },
  rowWrap: { paddingHorizontal: 16, paddingVertical: 4 },
  meta: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  rowSub: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16, textAlign: "right" },
  signed: { fontSize: 12, lineHeight: 16, textAlign: "right" },
  footer: { marginTop: 8 },
  footerHead: { alignItems: "flex-start", paddingHorizontal: 16, paddingBottom: 8 },
  empty: { alignItems: "center", gap: 12, padding: 32 },
  emptyText: { color: BRAND.zinc600, textAlign: "center" },
  fab: { backgroundColor: BRAND.yellow, borderWidth: 2.5, borderColor: BRAND.ink, borderRadius: 16 },
  fabAction: { backgroundColor: BRAND.card, borderWidth: 2.5, borderColor: BRAND.ink },
  fabLabel: { color: BRAND.ink },
});

// The chunky look for each speed-dial action: a white chip with an ink border.
const look = { style: styles.fabAction, labelStyle: styles.fabLabel };
