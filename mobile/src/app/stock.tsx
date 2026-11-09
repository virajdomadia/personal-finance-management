import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import {
  Appbar,
  Button,
  Chip,
  Dialog,
  Divider,
  IconButton,
  Portal,
  Surface,
  Text,
  TouchableRipple,
  useTheme,
} from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Signed, signedLabel } from "@/components/signed";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Portfolio, type Price, type Stock, type Trade, tradeTitle } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/transactions";

type Data = {
  stock: Stock;
  portfolio: Portfolio;
  trades: Trade[];
  prices: Price[];
  archived: Account[];
};

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "missing" } | { status: "ready"; data: Data };

async function fetchData(stockId: string, token: string | undefined): Promise<Data | null> {
  const auth = { token };
  const [stocks, portfolio, trades, prices, archived] = await Promise.all([
    apiFetch<{ stocks: Stock[] }>("/investments/stocks", auth),
    apiFetch<Portfolio>("/investments/portfolio", auth),
    apiFetch<{ trades: Trade[] }>(`/investments/trades?stock_id=${stockId}`, auth),
    apiFetch<{ prices: Price[] }>(`/investments/stocks/${stockId}/prices`, auth),
    apiFetch<AccountList>("/accounts?archived=true", auth),
  ]);
  const stock = stocks.stocks.find((s) => String(s.id) === stockId);
  if (!stock) return null;
  return { stock, portfolio, trades: trades.trades, prices: prices.prices, archived: archived.accounts };
}

export default function StockScreen() {
  const { id, symbol } = useLocalSearchParams<{ id: string; symbol?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingPrice, setDeletingPrice] = useState<Price | null>(null);
  const [deletingStock, setDeletingStock] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const latest = useRef(0);
  const navigating = useRef(false);
  // A valid id is a whole number; anything else can't be a stock, so don't ask the API.
  const valid = typeof id === "string" && /^\d{1,9}$/.test(id);

  const reload = useCallback(async () => {
    if (!valid) {
      setLoad({ status: "missing" });
      return;
    }
    const mine = ++latest.current;
    try {
      const data = await fetchData(id, token ?? undefined);
      if (mine !== latest.current) return;
      setLoad(data ? { status: "ready", data } : { status: "missing" });
      setNotice(null);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setLoad({ status: "missing" });
        return;
      }
      // Keeps what's on screen if there is something, with a message above it.
      setLoad((current) =>
        current.status === "ready" ? current : { status: "error", message: errorMessage(err) },
      );
      setNotice("We couldn't refresh this stock. Pull down to try again.");
    }
  }, [id, valid, token, logOut]);

  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
      void reload();
    }, [reload]),
  );

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !deletingRef.current) {
        setDeletingPrice(null);
        setDeletingStock(false);
      }
    });
    return () => subscription.remove();
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNotice(null);
    try {
      await reload();
    } finally {
      setRefreshing(false);
    }
  }, [reload]);

  const go = (target: Parameters<typeof router.push>[0]) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  };

  async function removePrice() {
    if (!deletingPrice || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    let failure: string | null = null;
    try {
      await apiFetch(`/investments/prices/${deletingPrice.id}`, { method: "DELETE", token: token ?? undefined });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      failure = errorMessage(err instanceof ApiError ? { detail: err.detail } : err);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      setDeletingPrice(null);
    }
    // A successful reload clears the notice, so a delete failure is shown after it.
    await reload();
    if (failure !== null) setNotice(failure);
  }

  // Only a stock with no trades and no prices can go; otherwise the server's reason is shown.
  async function removeStock() {
    if (!deletingStock || deletingRef.current || load.status !== "ready") return;
    deletingRef.current = true;
    setDeleting(true);
    let failure: string | null = null;
    try {
      await apiFetch(`/investments/stocks/${load.data.stock.id}`, { method: "DELETE", token: token ?? undefined });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      failure = errorMessage(err instanceof ApiError ? { detail: err.detail } : err);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      setDeletingStock(false);
    }
    if (failure === null) {
      router.back();
      return;
    }
    // A successful reload clears the notice, so a delete failure is shown after it.
    await reload();
    setNotice(failure);
  }

  const data = load.status === "ready" ? load.data : null;
  const title = data?.stock.symbol ?? symbol ?? "Stock";

  if (data === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title={title} />
        </Appbar.Header>
        <View style={styles.center}>
          {load.status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading this stock" />
          ) : load.status === "missing" ? (
            <>
              <Text variant="titleMedium">Stock not found</Text>
              <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
                It may have been deleted.
              </Text>
              <Button mode="contained" onPress={() => router.back()}>
                Back to investments
              </Button>
            </>
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {load.status === "error" ? load.message : null}
              </Text>
              <Button mode="contained" onPress={() => void refresh()} loading={refreshing} disabled={refreshing}>
                Try again
              </Button>
            </>
          )}
        </View>
      </View>
    );
  }

  const { stock } = data;
  const stockId = String(stock.id);
  const total = data.portfolio.by_stock.find((s) => s.stock_id === stock.id);
  const holdings = data.portfolio.holdings.filter((h) => h.stock_id === stock.id);
  const locked = new Set(data.archived.map((a) => a.id));
  // Shares in an archived broker can't be sold until it's restored.
  const sellable = holdings.filter((h) => !locked.has(h.account_id));
  // The brokers this stock was traded in, in the order they first appear.
  const brokers = [...new Map(data.trades.map((t) => [t.account_id, t.account_name])).entries()];
  // A filter on a broker with no trades left here falls back to all.
  const effective = brokers.some(([brokerId]) => String(brokerId) === filter) ? filter : "";
  const filterName = brokers.find(([brokerId]) => String(brokerId) === effective)?.[1];
  const shown = effective === "" ? data.trades : data.trades.filter((t) => String(t.account_id) === effective);

  const trade = (params: Record<string, string>) => go({ pathname: "/trade-form", params: { stockId, ...params } });

  const sectionTitle = (label: string) => (
    <Text variant="titleSmall" accessibilityRole="header" style={[styles.sectionHeader, { color: colors.primary }]}>
      {label}
    </Text>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={stock.symbol} />
        <Appbar.Action
          icon="pencil-outline"
          accessibilityLabel="Rename stock"
          onPress={() => go({ pathname: "/stock-form", params: { stockId } })}
        />
        <Appbar.Action icon="delete-outline" accessibilityLabel="Delete stock" onPress={() => setDeletingStock(true)} />
      </Appbar.Header>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <View style={styles.top}>
          <Text variant="bodyLarge" style={{ color: colors.onSurfaceVariant }}>
            {stock.name}
          </Text>

          {notice ? (
            <View style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
              <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                {notice}
              </Text>
            </View>
          ) : null}

          <Surface elevation={1} style={styles.summary}>
            <Line label="Current price">
              <View style={styles.end}>
                <Text variant="titleMedium" style={styles.right}>
                  {stock.price !== null ? formatRupees(stock.price) : "No price yet"}
                </Text>
                <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
                  {stock.price_date ? `as of ${formatDate(stock.price_date)}` : "Valued at cost"}
                </Text>
              </View>
            </Line>
            <Line label="Shares held">
              <View style={styles.end}>
                <Text variant="titleMedium" style={styles.right}>
                  {total ? total.shares : 0}
                </Text>
                {total ? (
                  <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
                    avg cost {formatRupees(total.average_cost)}
                  </Text>
                ) : null}
              </View>
            </Line>
            <Line label="Current value">
              <View style={styles.end}>
                <Text variant="titleMedium" style={styles.right}>
                  {formatRupees(total?.value ?? "0.00")}
                </Text>
                {total ? (
                  <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
                    {formatRupees(total.invested)} invested{total.at_cost ? " · at cost" : ""}
                  </Text>
                ) : null}
              </View>
            </Line>
            <Line label="Unrealised P&L">
              <View style={styles.end}>
                <Signed value={total?.unrealised ?? "0.00"} variant="titleMedium" style={styles.right} />
                {total ? <Signed value={total.unrealised_percent} percent variant="bodySmall" style={styles.right} /> : null}
              </View>
            </Line>
            <View style={styles.actions}>
              <Button mode="text" icon="tag-outline" onPress={() => go({ pathname: "/price-form", params: { stockId } })}>
                Update price
              </Button>
              {sellable.length > 0 ? (
                <Button
                  mode="outlined"
                  onPress={() => trade(sellable.length === 1 ? { side: "sell", accountId: String(sellable[0].account_id) } : { side: "sell" })}
                >
                  Sell
                </Button>
              ) : null}
              <Button mode="contained" onPress={() => trade({ side: "buy" })}>
                Buy
              </Button>
            </View>
          </Surface>
        </View>

        {holdings.length > 0 ? (
          <>
            {sectionTitle("Held in")}
            {holdings.map((h, index) => (
              <View key={h.account_id}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.row}>
                  <View style={styles.main}>
                    <Text variant="titleMedium">{h.account_name}</Text>
                    <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                      {h.shares} shares · avg cost {formatRupees(h.average_cost)}
                    </Text>
                    <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                      {formatRupees(h.invested)} invested
                    </Text>
                  </View>
                  <View style={styles.amounts}>
                    <Text variant="titleMedium" style={styles.right}>
                      {formatRupees(h.value)}
                    </Text>
                    {h.at_cost ? (
                      <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
                        at cost
                      </Text>
                    ) : null}
                    <Signed value={h.unrealised} variant="bodySmall" style={styles.right} />
                    <Signed value={h.unrealised_percent} percent variant="bodySmall" style={styles.right} />
                  </View>
                </View>
                {locked.has(h.account_id) ? null : (
                  <View style={styles.rowAction}>
                    <Button
                      compact
                      accessibilityLabel={`Sell ${h.symbol} from ${h.account_name}`}
                      onPress={() => trade({ side: "sell", accountId: String(h.account_id) })}
                    >
                      Sell
                    </Button>
                  </View>
                )}
              </View>
            ))}
          </>
        ) : null}

        {sectionTitle("Trades")}
        {brokers.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {[["", "All brokers"] as const, ...brokers.map(([brokerId, name]) => [String(brokerId), name] as const)].map(
              ([value, label]) => (
                <Chip
                  key={value || "all"}
                  selected={effective === value}
                  showSelectedCheck
                  onPress={() => setFilter(value)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: effective === value }}
                >
                  {label}
                </Chip>
              ),
            )}
          </ScrollView>
        ) : null}
        {shown.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
              {filterName ? `No trades in ${filterName} yet.` : "No trades yet."}
            </Text>
            <Button mode="outlined" onPress={() => trade({ opening: "1" })}>
              Add existing shares
            </Button>
          </View>
        ) : (
          shown.map((t, index) => (
            <View key={t.id}>
              {index > 0 ? <Divider /> : null}
              <TradeRow
                trade={t}
                archived={locked.has(t.account_id)}
                onPress={() => go({ pathname: "/trade-form", params: { id: String(t.id), stockId } })}
              />
            </View>
          ))
        )}

        {sectionTitle("Price history")}
        {data.prices.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
              No prices recorded. Until you add one, holdings are valued at cost.
            </Text>
          </View>
        ) : (
          data.prices.map((price, index) => (
            <View key={price.id}>
              {index > 0 ? <Divider /> : null}
              <View style={styles.priceRow}>
                <View style={styles.main}>
                  <Text variant="bodyLarge">{formatDate(price.date)}</Text>
                  {index === 0 ? (
                    <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                      Current
                    </Text>
                  ) : null}
                </View>
                <Text variant="titleMedium">{formatRupees(price.price)}</Text>
                <IconButton
                  icon="delete-outline"
                  accessibilityLabel={`Delete the price on ${formatDate(price.date)}`}
                  onPress={() => setDeletingPrice(price)}
                />
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <Portal>
        <Dialog visible={deletingPrice !== null} onDismiss={() => (deleting ? undefined : setDeletingPrice(null))}>
          <Dialog.Title>
            {deletingPrice
              ? `Delete the price of ${formatRupees(deletingPrice.price)} on ${formatDate(deletingPrice.date)}?`
              : "Delete this price?"}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              It&apos;s removed for good, and holdings are valued at the price before it (or at cost if there is none).
              This can&apos;t be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeletingPrice(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button onPress={() => void removePrice()} loading={deleting} disabled={deleting}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
        <Dialog visible={deletingStock} onDismiss={() => (deleting ? undefined : setDeletingStock(false))}>
          <Dialog.Title>Delete {stock.symbol}?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Only a stock with no trades and no prices can be deleted. This can&apos;t be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeletingStock(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button onPress={() => void removeStock()} loading={deleting} disabled={deleting}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
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

// One trade. Tapping opens it to edit or delete; trades in an archived broker are locked until it's restored.
function TradeRow({ trade, archived, onPress }: { trade: Trade; archived: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const title = tradeTitle(trade);
  const details = [
    formatDate(trade.date),
    trade.account_name,
    `${trade.quantity} × ${formatRupees(trade.price)}`,
    trade.charges !== "0.00" ? `${formatRupees(trade.charges)} charges` : null,
    trade.note,
  ].filter(Boolean);
  const cash = trade.opening ? "Cost" : trade.side === "buy" ? "Paid" : "Received";
  return (
    <TouchableRipple
      onPress={onPress}
      disabled={archived}
      accessibilityRole={archived ? undefined : "button"}
      accessibilityLabel={`${title}, ${details.join(", ")}, ${cash} ${formatRupees(trade.amount)}${trade.realised !== null ? `, realised ${signedLabel(trade.realised)}` : ""}${archived ? ", archived broker" : ""}`}
      accessibilityHint={archived ? undefined : "Opens the trade to edit or delete"}
    >
      <View style={styles.row}>
        <View style={styles.main}>
          <Text variant="titleMedium">{title}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {details.join(" · ")}
          </Text>
          {archived ? (
            <Text variant="labelSmall" style={{ color: colors.onSurfaceVariant }}>
              Archived broker. Restore it to change this trade.
            </Text>
          ) : null}
        </View>
        <View style={styles.amounts}>
          <Text variant="labelSmall" style={{ color: colors.onSurfaceVariant }}>
            {cash}
          </Text>
          <Text variant="titleMedium" style={styles.right}>
            {formatRupees(trade.amount)}
          </Text>
          {trade.realised !== null ? <Signed value={trade.realised} variant="bodySmall" style={styles.right} /> : null}
        </View>
      </View>
    </TouchableRipple>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  top: { padding: 16, paddingTop: 8, gap: 12 },
  banner: { borderRadius: 12, padding: 12 },
  summary: { borderRadius: 12, padding: 16, gap: 10 },
  line: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  end: { alignItems: "flex-end", flexShrink: 1 },
  right: { textAlign: "right" },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  chips: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  main: { flex: 1, gap: 2 },
  amounts: { flexShrink: 1, maxWidth: "55%", alignItems: "flex-end" },
  rowAction: { alignItems: "flex-end", paddingHorizontal: 8, paddingBottom: 4 },
  priceRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16, paddingRight: 4, paddingVertical: 4 },
  emptyBox: { alignItems: "center", gap: 12, paddingHorizontal: 24, paddingVertical: 16 },
});
