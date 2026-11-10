import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Appbar, Button, Dialog, Divider, IconButton, Portal, Surface, Text, TouchableRipple, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Signed, signedLabel } from "@/components/signed";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Coin,
  type CoinPrice,
  type CryptoPortfolio,
  type CryptoTrade,
  cryptoTradeTitle,
  formatCoinPrice,
  formatCoinQty,
} from "@/lib/crypto";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/transactions";

type Data = {
  coin: Coin;
  crypto: CryptoPortfolio;
  trades: CryptoTrade[];
  prices: CoinPrice[];
  archived: Account[];
};

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "missing" } | { status: "ready"; data: Data };

async function fetchData(coinId: string, token: string | undefined): Promise<Data | null> {
  const auth = { token };
  const [coins, portfolio, trades, prices, archived] = await Promise.all([
    apiFetch<{ coins: Coin[] }>("/investments/coins", auth),
    apiFetch<{ crypto: CryptoPortfolio }>("/investments/portfolio", auth),
    apiFetch<{ trades: CryptoTrade[] }>(`/investments/crypto-trades?coin_id=${coinId}`, auth),
    apiFetch<{ prices: CoinPrice[] }>(`/investments/coins/${coinId}/prices`, auth),
    apiFetch<AccountList>("/accounts?archived=true", auth),
  ]);
  const coin = coins.coins.find((c) => String(c.id) === coinId);
  if (!coin) return null;
  return { coin, crypto: portfolio.crypto, trades: trades.trades, prices: prices.prices, archived: archived.accounts };
}

export default function CoinScreen() {
  const { id, symbol } = useLocalSearchParams<{ id: string; symbol?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingPrice, setDeletingPrice] = useState<CoinPrice | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const latest = useRef(0);
  const navigating = useRef(false);
  // A valid id is a whole number; anything else can't be a coin, so don't ask the API.
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
      setLoad((current) => (current.status === "ready" ? current : { status: "error", message: errorMessage(err) }));
      setNotice("We couldn't refresh this coin. Pull down to try again.");
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
      if (state !== "active" && !deletingRef.current) setDeletingPrice(null);
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
      await apiFetch(`/investments/coin-prices/${deletingPrice.id}`, { method: "DELETE", token: token ?? undefined });
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
    // A successful reload clears the notice, so a failure is shown after it.
    await reload();
    if (failure !== null) setNotice(failure);
  }

  const data = load.status === "ready" ? load.data : null;
  const title = data?.coin.symbol ?? symbol ?? "Coin";

  if (data === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title={title} />
        </Appbar.Header>
        <View style={styles.center}>
          {load.status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading this coin" />
          ) : load.status === "missing" ? (
            <>
              <Text variant="titleMedium">Coin not found</Text>
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

  const { coin } = data;
  const coinId = String(coin.id);
  const total = data.crypto.by_coin.find((c) => c.coin_id === coin.id);
  const holdings = data.crypto.holdings.filter((h) => h.coin_id === coin.id);
  const locked = new Set(data.archived.map((a) => a.id));
  // Coins in an archived account can't be sold until it's restored.
  const sellable = holdings.filter((h) => !locked.has(h.account_id));

  const trade = (params: Record<string, string>) => go({ pathname: "/crypto-trade-form", params: { coinId, ...params } });

  const sectionTitle = (label: string) => (
    <Text variant="titleSmall" accessibilityRole="header" style={[styles.sectionHeader, { color: colors.primary }]}>
      {label}
    </Text>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={coin.symbol} />
        <Appbar.Action
          icon="pencil-outline"
          accessibilityLabel="Rename or delete coin"
          onPress={() => go({ pathname: "/coin-form", params: { id: coinId } })}
        />
      </Appbar.Header>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <View style={styles.top}>
          <Text variant="titleMedium">{coin.name}</Text>

          {notice ? (
            <View style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
              <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                {notice}
              </Text>
            </View>
          ) : null}

          <Surface elevation={1} style={styles.summary}>
            <Line label="Price">
              <View style={styles.end}>
                <Text variant="titleMedium" style={styles.right}>
                  {coin.price !== null ? formatCoinPrice(coin.price) : "No price yet"}
                </Text>
                <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
                  {coin.price_date ? `as of ${formatDate(coin.price_date)}` : "Valued at cost"}
                </Text>
              </View>
            </Line>
            <Line label="Quantity held">
              <View style={styles.end}>
                <Text variant="titleMedium" style={styles.right}>
                  {formatCoinQty(total?.quantity ?? "0")}
                </Text>
                {total ? (
                  <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
                    avg {formatCoinPrice(total.average_price)}
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
              <Button mode="text" icon="tag-outline" onPress={() => go({ pathname: "/coin-price-form", params: { coinId } })}>
                Update price
              </Button>
              {sellable.length > 0 ? (
                <Button
                  mode="outlined"
                  onPress={() =>
                    trade(sellable.length === 1 ? { mode: "sell", accountId: String(sellable[0].account_id) } : { mode: "sell" })
                  }
                >
                  Sell
                </Button>
              ) : null}
              <Button mode="contained" onPress={() => trade({ mode: "buy" })}>
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
                      {formatCoinQty(h.quantity)} {h.symbol} · avg {formatCoinPrice(h.average_price)}
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
                      onPress={() => trade({ mode: "sell", accountId: String(h.account_id) })}
                    >
                      Sell
                    </Button>
                  </View>
                )}
              </View>
            ))}
          </>
        ) : null}

        {sectionTitle("Transactions")}
        {data.trades.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
              No transactions yet.
            </Text>
            <Button mode="outlined" onPress={() => trade({ mode: "opening" })}>
              Add existing coins
            </Button>
          </View>
        ) : (
          data.trades.map((t, index) => (
            <View key={t.id}>
              {index > 0 ? <Divider /> : null}
              <TradeRow trade={t} archived={locked.has(t.account_id)} onPress={() => trade({ id: String(t.id) })} />
            </View>
          ))
        )}

        {sectionTitle("Price history")}
        {data.prices.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
              No price recorded. Until you add one, holdings are valued at cost.
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
                <Text variant="titleMedium">{formatCoinPrice(price.price)}</Text>
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
              ? `Delete the price of ${formatCoinPrice(deletingPrice.price)} on ${formatDate(deletingPrice.date)}?`
              : "Delete this price?"}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              It&apos;s removed for good, and holdings are valued at the price before it (or at cost if there is none). This
              can&apos;t be undone.
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

// One transaction. Tapping opens it to edit or delete; ones in an archived account are locked until it's restored.
function TradeRow({ trade, archived, onPress }: { trade: CryptoTrade; archived: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const title = cryptoTradeTitle(trade);
  const details = [
    formatDate(trade.date),
    trade.account_name,
    trade.opening ? `avg ${formatCoinPrice(trade.price)}` : `@ ${formatCoinPrice(trade.price)}`,
    trade.charges !== "0.00" ? `${formatRupees(trade.charges)} charges` : null,
    trade.note,
  ].filter(Boolean);
  const cash = trade.opening ? "Cost" : trade.side === "buy" ? "Paid" : "Received";
  return (
    <TouchableRipple
      onPress={onPress}
      disabled={archived}
      accessibilityRole={archived ? undefined : "button"}
      accessibilityLabel={`${title}, ${details.join(", ")}, ${cash} ${formatRupees(trade.amount)}${trade.realised !== null ? `, realised ${signedLabel(trade.realised)}` : ""}${archived ? ", archived account" : ""}`}
      accessibilityHint={archived ? undefined : "Opens the transaction to edit or delete"}
    >
      <View style={styles.row}>
        <View style={styles.main}>
          <Text variant="titleMedium">{title}</Text>
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            {details.join(" · ")}
          </Text>
          {archived ? (
            <Text variant="labelSmall" style={{ color: colors.onSurfaceVariant }}>
              Archived account. Restore it to change this.
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
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  main: { flex: 1, gap: 2 },
  amounts: { flexShrink: 1, maxWidth: "55%", alignItems: "flex-end" },
  rowAction: { alignItems: "flex-end", paddingHorizontal: 8, paddingBottom: 4 },
  priceRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16, paddingRight: 4, paddingVertical: 4 },
  emptyBox: { alignItems: "center", gap: 12, paddingHorizontal: 24, paddingVertical: 16 },
});
