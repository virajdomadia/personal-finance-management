import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { Appbar, Button, Divider, FAB, List, Surface, Text, TouchableRipple, useTheme } from "react-native-paper";

import { Signed, signedLabel } from "@/components/signed";
import { errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { Portfolio, StockTotal } from "@/lib/investments";
import { useSession } from "@/lib/session";

type Kind = "buy" | "sell" | "opening";

export default function InvestmentsScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fabOpen, setFabOpen] = useState(false);
  const [focused, setFocused] = useState(true);
  const [soldOpen, setSoldOpen] = useState(false);
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
  const go = useCallback((target: Parameters<typeof router.push>[0]) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  }, []);

  const addTrade = (kind: Kind) =>
    go({ pathname: "/trade-form", params: kind === "opening" ? { opening: "1" } : { side: kind } });
  const openStock = (row: { stock_id: number; symbol: string }) =>
    go({ pathname: "/stock", params: { id: String(row.stock_id), symbol: row.symbol } });

  const hasHoldings = (portfolio?.holdings.length ?? 0) > 0;
  const empty = portfolio !== null && portfolio.by_stock.length === 0 && portfolio.closed.length === 0;

  const header = portfolio ? (
    <View style={styles.header}>
      {error ? (
        <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.error }}>
          {error} Pull down to try again.
        </Text>
      ) : null}
      {empty ? null : (
        <Surface elevation={1} style={styles.summary}>
          <View>
            <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
              Current value
            </Text>
            <Text variant="headlineMedium" adjustsFontSizeToFit numberOfLines={1} style={styles.value}>
              {formatRupees(portfolio.totals.value)}
            </Text>
          </View>
          <Line label="Invested">
            <Text variant="titleMedium" style={styles.right}>
              {formatRupees(portfolio.totals.invested)}
            </Text>
          </Line>
          <Line label="Unrealised P&L">
            <View style={styles.pnl}>
              <Signed value={portfolio.totals.unrealised} variant="titleMedium" style={styles.right} />
              <Signed value={portfolio.totals.unrealised_percent} percent variant="bodySmall" style={styles.right} />
            </View>
          </Line>
          <Line label="Realised P&L">
            <Signed value={portfolio.totals.realised} variant="titleMedium" style={styles.right} />
          </Line>
        </Surface>
      )}
      {portfolio.by_stock.length > 0 ? (
        <Text variant="titleSmall" accessibilityRole="header" style={[styles.sectionHeader, { color: colors.primary }]}>
          Holdings
        </Text>
      ) : null}
    </View>
  ) : null;

  const footer =
    portfolio && portfolio.closed.length > 0 ? (
      <View style={styles.footer}>
        <Divider />
        <List.Accordion
          title={`Sold (${portfolio.closed.length})`}
          expanded={soldOpen}
          onPress={() => setSoldOpen((open) => !open)}
          titleStyle={{ color: colors.primary }}
        >
          {portfolio.closed.map((c) => (
            <TouchableRipple
              key={`${c.stock_id}-${c.account_id}`}
              onPress={() => openStock(c)}
              accessibilityRole="button"
              accessibilityHint="Opens the stock"
            >
              <View style={styles.row}>
                <View style={styles.main}>
                  <Text variant="titleMedium">{c.symbol}</Text>
                  <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                    {c.name} · {c.account_name}
                  </Text>
                </View>
                <View style={styles.amounts}>
                  <Text variant="labelSmall" style={{ color: colors.onSurfaceVariant }}>
                    Realised
                  </Text>
                  <Signed value={c.realised} variant="titleMedium" style={styles.right} />
                </View>
              </View>
            </TouchableRipple>
          ))}
        </List.Accordion>
      </View>
    ) : null;

  return (
    <View style={styles.screen}>
      <Appbar.Header>
        <Appbar.Content title="Investments" />
      </Appbar.Header>

      {portfolio === null && error === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading investments" />
        </View>
      ) : portfolio === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {error}
          </Text>
          <Button mode="contained" onPress={() => void refresh()} loading={refreshing} disabled={refreshing}>
            Try again
          </Button>
        </View>
      ) : (
        <FlatList
          data={portfolio.by_stock}
          keyExtractor={(row) => String(row.stock_id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={styles.content}
          ItemSeparatorComponent={Divider}
          ListHeaderComponent={header ?? undefined}
          ListFooterComponent={footer ?? undefined}
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
      )}

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
    </View>
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

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { paddingBottom: 112 },
  header: { padding: 16, paddingBottom: 0, gap: 12 },
  summary: { borderRadius: 12, padding: 16, gap: 10 },
  value: { fontWeight: "600" },
  line: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  pnl: { alignItems: "flex-end", flexShrink: 1 },
  right: { textAlign: "right" },
  sectionHeader: { paddingTop: 8, paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  main: { flex: 1, gap: 2 },
  amounts: { flexShrink: 1, maxWidth: "55%", alignItems: "flex-end" },
  footer: { marginTop: 8 },
  empty: { alignItems: "center", gap: 12, padding: 32 },
});
