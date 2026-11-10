import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import {
  Appbar,
  Button,
  Divider,
  FAB,
  Icon,
  List,
  SegmentedButtons,
  Surface,
  Text,
  TouchableRipple,
  useTheme,
} from "react-native-paper";

import { Signed, signedLabel } from "@/components/signed";
import { errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type CoinTotal, type CryptoTradeMode, formatCoinAverage, formatCoinPrice, formatCoinQty } from "@/lib/crypto";
import { type FundTotal, type FundTradeMode, type Sip, dueText, formatNav, formatUnits } from "@/lib/funds";
import type { DepositRow, DepositsPortfolio, Portfolio, StockTotal, Totals } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/transactions";

type Kind = "buy" | "sell" | "opening";
type Segment = "stocks" | "funds" | "deposits" | "crypto";
type Go = (target: Parameters<typeof router.push>[0]) => void;

export default function InvestmentsScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
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
    try {
      const result = await apiFetch<Portfolio>("/investments/portfolio", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setPortfolio(result);
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

  // Reloads whenever the tab regains focus, so coming back from a form shows fresh figures.
  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
      setFocused(true);
      void load();
      return () => {
        setFocused(false);
        setFabOpen(false);
      };
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
    <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.error }}>
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
        <Button mode="contained" onPress={() => void refresh()} loading={refreshing} disabled={refreshing}>
          Try again
        </Button>
      </View>
    );
  } else if (segment === "stocks") {
    const empty = portfolio.by_stock.length === 0 && portfolio.closed.length === 0;
    body = (
      <FlatList
        data={portfolio.by_stock}
        keyExtractor={(row) => String(row.stock_id)}
        refreshControl={refreshControl}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Divider}
        ListHeaderComponent={
          <View style={styles.header}>
            {errorLine}
            {dueCards}
            {empty ? null : <SummaryCard totals={portfolio.totals} />}
            {portfolio.by_stock.length > 0 ? <SectionTitle label="Holdings" /> : null}
          </View>
        }
        ListFooterComponent={
          portfolio.closed.length > 0 ? (
            <View style={styles.footer}>
              <Divider />
              <List.Accordion
                title={`Sold (${portfolio.closed.length})`}
                expanded={soldOpen}
                onPress={() => setSoldOpen((open) => !open)}
                titleStyle={{ color: colors.primary }}
              >
                {portfolio.closed.map((c) => (
                  <ClosedRow
                    key={`${c.stock_id}-${c.account_id}`}
                    title={c.symbol}
                    detail={`${c.name} · ${c.account_name}`}
                    realised={c.realised}
                    hint="Opens the stock"
                    onPress={() => openStock(c)}
                  />
                ))}
              </List.Accordion>
            </View>
          ) : undefined
        }
        renderItem={({ item }) => <HoldingRow row={item} onPress={() => openStock(item)} />}
        ListEmptyComponent={
          empty ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">Add your shares</Text>
              <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant, textAlign: "center" }}>
                Enter shares you already own, or record a buy. Buys and sells move your broker account&apos;s cash.
              </Text>
              <Button mode="outlined" onPress={() => addTrade("opening")}>
                Add existing shares
              </Button>
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
        ItemSeparatorComponent={DepositGap}
        renderItem={({ item }) => <DepositCard row={item} onPress={() => openAccounts()} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text variant="titleMedium">No PPF or RD yet</Text>
            <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant, textAlign: "center" }}>
              Add a PPF or recurring deposit as an account. It shows here with its balance and the interest it has
              earned so far.
            </Text>
            <Button mode="outlined" onPress={() => openAccounts()}>
              Go to Accounts
            </Button>
          </View>
        }
      />
    );
  } else if (segment === "crypto") {
    const crypto = portfolio.crypto;
    const empty = crypto.by_coin.length === 0 && crypto.closed.length === 0;
    body = (
      <FlatList
        data={crypto.by_coin}
        keyExtractor={(row) => String(row.coin_id)}
        refreshControl={refreshControl}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Divider}
        ListHeaderComponent={
          <View style={styles.header}>
            {errorLine}
            {empty ? null : <SummaryCard totals={crypto.totals} />}
            {crypto.by_coin.length > 0 ? <SectionTitle label="Coins" /> : null}
          </View>
        }
        ListFooterComponent={
          crypto.closed.length > 0 ? (
            <View style={styles.footer}>
              <Divider />
              <List.Accordion
                title={`Sold (${crypto.closed.length})`}
                expanded={coinsSoldOpen}
                onPress={() => setCoinsSoldOpen((open) => !open)}
                titleStyle={{ color: colors.primary }}
              >
                {crypto.closed.map((c) => (
                  <ClosedRow
                    key={`${c.coin_id}-${c.account_id}`}
                    title={c.name}
                    detail={`${c.symbol} · ${c.account_name}`}
                    realised={c.realised}
                    hint="Opens the coin"
                    onPress={() => openCoin(c)}
                  />
                ))}
              </List.Accordion>
            </View>
          ) : undefined
        }
        renderItem={({ item }) => <CoinRow row={item} onPress={() => openCoin(item)} />}
        ListEmptyComponent={
          empty ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">Add your crypto</Text>
              <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant, textAlign: "center" }}>
                Enter coins you already hold, or record a buy. Prices are typed in by hand, so until you add one coins are
                valued at cost.
              </Text>
              <Button mode="outlined" onPress={() => addCoinTrade("opening")}>
                Add existing coins
              </Button>
            </View>
          ) : undefined
        }
      />
    );
  } else {
    const funds = portfolio.funds;
    const empty = funds.by_fund.length === 0 && funds.closed.length === 0;
    body = (
      <FlatList
        data={funds.by_fund}
        keyExtractor={(row) => String(row.fund_id)}
        refreshControl={refreshControl}
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Divider}
        ListHeaderComponent={
          <View style={styles.header}>
            {errorLine}
            {dueCards}
            {empty ? null : <SummaryCard totals={funds.totals} />}
            {funds.by_fund.length > 0 ? <SectionTitle label="Funds" /> : null}
          </View>
        }
        ListFooterComponent={
          funds.closed.length > 0 ? (
            <View style={styles.footer}>
              <Divider />
              <List.Accordion
                title={`Redeemed (${funds.closed.length})`}
                expanded={redeemedOpen}
                onPress={() => setRedeemedOpen((open) => !open)}
                titleStyle={{ color: colors.primary }}
              >
                {funds.closed.map((c) => (
                  <ClosedRow
                    key={`${c.fund_id}-${c.account_id}`}
                    title={c.name}
                    detail={`${c.symbol} · ${c.account_name}`}
                    realised={c.realised}
                    hint="Opens the fund"
                    onPress={() => openFund(c)}
                  />
                ))}
              </List.Accordion>
            </View>
          ) : undefined
        }
        renderItem={({ item }) => <FundRow row={item} onPress={() => openFund(item)} />}
        ListEmptyComponent={
          empty ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">Add your mutual funds</Text>
              <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant, textAlign: "center" }}>
                Enter units you already hold, or add a SIP. Each month a SIP shows here as due until you record it with
                that day&apos;s NAV.
              </Text>
              <Button mode="outlined" onPress={() => addFundTrade("opening")}>
                Add existing units
              </Button>
              <Button mode="text" onPress={() => go({ pathname: "/sip-form" })}>
                Add SIP
              </Button>
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
    <View style={styles.screen}>
      <Appbar.Header>
        <Appbar.Content title="Investments" />
      </Appbar.Header>

      <SegmentedButtons
        value={segment}
        onValueChange={(value) => {
          setFabOpen(false);
          setSegment(value as Segment);
        }}
        style={styles.segments}
        buttons={[
          { value: "stocks", label: "Stocks" },
          { value: "funds", label: "Funds" },
          { value: "deposits", label: "Deposits" },
          { value: "crypto", label: "Crypto" },
        ]}
      />

      {body}

      {segment === "deposits" ? null : segment === "stocks" ? (
        <FAB.Group
          open={fabOpen}
          visible={focused && portfolio !== null}
          icon={fabOpen ? "close" : "plus"}
          label={fabOpen ? undefined : "Add trade"}
          accessibilityLabel={fabOpen ? "Close trade options" : "Add a trade"}
          onStateChange={({ open }) => setFabOpen(open)}
          actions={[
            { icon: "archive-arrow-down-outline", label: "Add existing shares", onPress: () => addTrade("opening") },
            ...(hasHoldings ? [{ icon: "minus", label: "Sell", onPress: () => addTrade("sell") }] : []),
            { icon: "plus", label: "Buy", onPress: () => addTrade("buy") },
          ]}
        />
      ) : segment === "crypto" ? (
        <FAB.Group
          open={fabOpen}
          visible={focused && portfolio !== null}
          icon={fabOpen ? "close" : "plus"}
          label={fabOpen ? undefined : "Add"}
          accessibilityLabel={fabOpen ? "Close crypto options" : "Add a crypto transaction"}
          onStateChange={({ open }) => setFabOpen(open)}
          actions={[
            { icon: "archive-arrow-down-outline", label: "Add existing coins", onPress: () => addCoinTrade("opening") },
            ...(hasCoinHoldings ? [{ icon: "minus", label: "Sell", onPress: () => addCoinTrade("sell") }] : []),
            { icon: "plus", label: "Buy", onPress: () => addCoinTrade("buy") },
          ]}
        />
      ) : (
        <FAB.Group
          open={fabOpen}
          visible={focused && portfolio !== null}
          icon={fabOpen ? "close" : "plus"}
          label={fabOpen ? undefined : "Add"}
          accessibilityLabel={fabOpen ? "Close fund options" : "Add a fund transaction or SIP"}
          onStateChange={({ open }) => setFabOpen(open)}
          actions={[
            { icon: "calendar-sync-outline", label: "Add SIP", onPress: () => go({ pathname: "/sip-form" }) },
            { icon: "archive-arrow-down-outline", label: "Add existing units", onPress: () => addFundTrade("opening") },
            ...(hasFundHoldings ? [{ icon: "minus", label: "Redeem", onPress: () => addFundTrade("sell") }] : []),
            { icon: "plus", label: "Buy", onPress: () => addFundTrade("buy") },
            {
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
  const { colors } = useTheme();
  const text = dueText(sip);
  return (
    <Surface elevation={0} style={[styles.due, { backgroundColor: colors.tertiaryContainer }]}>
      <TouchableRipple
        onPress={onPress}
        borderless
        style={styles.dueRipple}
        accessibilityRole="button"
        accessibilityLabel={text}
        accessibilityHint="Opens Record SIP with the NAV to type"
      >
        <View style={styles.dueInner}>
          <Icon source="calendar-clock" size={24} color={colors.onTertiaryContainer} />
          <Text variant="bodyMedium" style={[styles.grow, { color: colors.onTertiaryContainer }]}>
            {text}
          </Text>
          <Icon source="chevron-right" size={24} color={colors.onTertiaryContainer} />
        </View>
      </TouchableRipple>
    </Surface>
  );
}

function SummaryCard({ totals }: { totals: Totals }) {
  const { colors } = useTheme();
  return (
    <Surface elevation={1} style={styles.summary}>
      <View>
        <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
          Current value
        </Text>
        <Text variant="headlineMedium" adjustsFontSizeToFit numberOfLines={1} style={styles.value}>
          {formatRupees(totals.value)}
        </Text>
      </View>
      <Line label="Invested">
        <Text variant="titleMedium" style={styles.right}>
          {formatRupees(totals.invested)}
        </Text>
      </Line>
      <Line label="Unrealised P&L">
        <View style={styles.pnl}>
          <Signed value={totals.unrealised} variant="titleMedium" style={styles.right} />
          <Signed value={totals.unrealised_percent} percent variant="bodySmall" style={styles.right} />
        </View>
      </Line>
      <Line label="Realised P&L">
        <Signed value={totals.realised} variant="titleMedium" style={styles.right} />
      </Line>
    </Surface>
  );
}

function DepositsSummary({ deposits }: { deposits: DepositsPortfolio }) {
  const { colors } = useTheme();
  return (
    <Surface elevation={1} style={styles.summary}>
      <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
        In deposits
      </Text>
      <Text variant="headlineMedium" adjustsFontSizeToFit numberOfLines={1} style={styles.value}>
        {formatRupees(deposits.value)}
      </Text>
      <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
        ≈ {formatRupees(deposits.interest_estimate)} interest (estimate)
      </Text>
    </Surface>
  );
}

function DepositGap() {
  return <View style={styles.gap} />;
}

// One PPF or RD. The whole card opens the Accounts tab, where its actions are.
function DepositCard({ row, onPress }: { row: DepositRow; onPress: () => void }) {
  const { colors } = useTheme();
  const kindLabel = row.type === "ppf" ? "PPF" : "RD";
  const maturity = row.maturity_date ? `Matures ${formatDate(row.maturity_date)}` : null;
  return (
    <Surface elevation={1} style={styles.depositCard}>
      <TouchableRipple
        onPress={onPress}
        borderless
        style={styles.dueRipple}
        accessibilityRole="button"
        accessibilityLabel={`${row.name}, ${kindLabel}, balance ${formatRupees(row.balance)}, about ${formatRupees(row.interest_estimate)} interest estimated${maturity ? `, ${maturity.toLowerCase()}` : ""}`}
        accessibilityHint="Opens Accounts"
      >
        <View style={styles.row}>
          <View style={styles.main}>
            <Text variant="titleMedium">{row.name}</Text>
            <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
              {kindLabel}
              {maturity ? ` · ${maturity}` : ""}
            </Text>
          </View>
          <View style={styles.amounts}>
            <Text variant="titleMedium" style={styles.right}>
              {formatRupees(row.balance)}
            </Text>
            <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
              ≈ {formatRupees(row.interest_estimate)} interest (estimate)
            </Text>
          </View>
        </View>
      </TouchableRipple>
    </Surface>
  );
}

function SectionTitle({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <Text variant="titleSmall" accessibilityRole="header" style={[styles.sectionHeader, { color: colors.primary }]}>
      {label}
    </Text>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.line}>
      <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function ClosedRow({
  title,
  detail,
  realised,
  hint,
  onPress,
}: {
  title: string;
  detail: string;
  realised: string;
  hint: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <TouchableRipple onPress={onPress} accessibilityRole="button" accessibilityHint={hint}>
      <View style={styles.row}>
        <View style={styles.main}>
          <Text variant="titleMedium">{title}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {detail}
          </Text>
        </View>
        <View style={styles.amounts}>
          <Text variant="labelSmall" style={{ color: colors.onSurfaceVariant }}>
            Realised
          </Text>
          <Signed value={realised} variant="titleMedium" style={styles.right} />
        </View>
      </View>
    </TouchableRipple>
  );
}

// Amounts sit in a column of up to 55% of the row and wrap, so a long figure never runs under the name.
function HoldingRow({ row, onPress }: { row: StockTotal; onPress: () => void }) {
  const { colors } = useTheme();
  const priced = row.at_cost ? "at cost" : row.price !== null ? `@ ${formatRupees(row.price)}` : null;
  return (
    <TouchableRipple
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.symbol}, ${row.name}, ${row.shares} shares, worth ${formatRupees(row.value)}${row.at_cost ? " at cost" : ""}, unrealised ${signedLabel(row.unrealised)}, ${signedLabel(row.unrealised_percent, true)}`}
      accessibilityHint="Opens its trades and prices"
    >
      <View style={styles.row}>
        <View style={styles.main}>
          <Text variant="titleMedium">{row.symbol}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {row.name}
          </Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {row.shares} shares · avg {formatRupees(row.average_cost)}
          </Text>
        </View>
        <View style={styles.amounts}>
          <Text variant="titleMedium" style={styles.right}>
            {formatRupees(row.value)}
          </Text>
          {priced ? (
            <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
              {priced}
            </Text>
          ) : null}
          <Signed value={row.unrealised} variant="bodySmall" style={styles.right} />
          <Signed value={row.unrealised_percent} percent variant="bodySmall" style={styles.right} />
        </View>
      </View>
    </TouchableRipple>
  );
}

// Fund names are long, so the name leads and the short symbol sits with the units underneath.
function FundRow({ row, onPress }: { row: FundTotal; onPress: () => void }) {
  const { colors } = useTheme();
  const priced = row.at_cost ? "at cost" : row.nav !== null ? `NAV ${formatNav(row.nav)}` : null;
  return (
    <TouchableRipple
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, ${formatUnits(row.units)} units, worth ${formatRupees(row.value)}${row.at_cost ? " at cost" : ""}, unrealised ${signedLabel(row.unrealised)}, ${signedLabel(row.unrealised_percent, true)}`}
      accessibilityHint="Opens its transactions, NAVs and SIPs"
    >
      <View style={styles.row}>
        <View style={styles.main}>
          <Text variant="titleMedium">{row.name}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {row.symbol} · {formatUnits(row.units)} units
          </Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            avg NAV {formatNav(row.average_nav)}
          </Text>
        </View>
        <View style={styles.amounts}>
          <Text variant="titleMedium" style={styles.right}>
            {formatRupees(row.value)}
          </Text>
          {priced ? (
            <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
              {priced}
            </Text>
          ) : null}
          <Signed value={row.unrealised} variant="bodySmall" style={styles.right} />
          <Signed value={row.unrealised_percent} percent variant="bodySmall" style={styles.right} />
        </View>
      </View>
    </TouchableRipple>
  );
}

// Coin names lead, with the quantity and ticker underneath. Prices go through formatCoinPrice,
// averages through formatCoinAverage.
function CoinRow({ row, onPress }: { row: CoinTotal; onPress: () => void }) {
  const { colors } = useTheme();
  const priced = row.at_cost ? "at cost" : row.price !== null ? `@ ${formatCoinPrice(row.price)}` : null;
  return (
    <TouchableRipple
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, ${formatCoinQty(row.quantity)} ${row.symbol}, worth ${formatRupees(row.value)}${row.at_cost ? " at cost" : ""}, unrealised ${signedLabel(row.unrealised)}, ${signedLabel(row.unrealised_percent, true)}`}
      accessibilityHint="Opens its transactions and prices"
    >
      <View style={styles.row}>
        <View style={styles.main}>
          <Text variant="titleMedium">{row.name}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {formatCoinQty(row.quantity)} {row.symbol}
          </Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            avg {formatCoinAverage(row.average_price)}
          </Text>
        </View>
        <View style={styles.amounts}>
          <Text variant="titleMedium" style={styles.right}>
            {formatRupees(row.value)}
          </Text>
          {priced ? (
            <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
              {priced}
            </Text>
          ) : null}
          <Signed value={row.unrealised} variant="bodySmall" style={styles.right} />
          <Signed value={row.unrealised_percent} percent variant="bodySmall" style={styles.right} />
        </View>
      </View>
    </TouchableRipple>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  segments: { marginHorizontal: 16, marginTop: 4, marginBottom: 4 },
  content: { paddingBottom: 112 },
  header: { padding: 16, paddingBottom: 0, gap: 12 },
  dueList: { gap: 8 },
  due: { borderRadius: 12 },
  dueRipple: { borderRadius: 12 },
  dueInner: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, minHeight: 56 },
  grow: { flex: 1 },
  summary: { borderRadius: 12, padding: 16, gap: 10 },
  value: { fontWeight: "600" },
  line: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  pnl: { alignItems: "flex-end", flexShrink: 1 },
  right: { textAlign: "right" },
  sectionHeader: { paddingTop: 8, paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  main: { flex: 1, gap: 2 },
  amounts: { flexShrink: 1, maxWidth: "55%", alignItems: "flex-end" },
  gap: { height: 8 },
  depositCard: { borderRadius: 12, marginHorizontal: 16 },
  footer: { marginTop: 8 },
  empty: { alignItems: "center", gap: 12, padding: 32 },
});
