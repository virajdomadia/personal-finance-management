import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GoalTagChip } from "@/components/goal-tag";
import { ChunkyButton, HeaderAction, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { EmptyBox, GainPill, HeldRow, HistoryRow, PriceLine, SectionTitle, StatLine, StatsCard, TradeRow, WorthTile } from "@/components/investment-parts";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Coin,
  type CoinPrice,
  type CryptoPortfolio,
  type CryptoTrade,
  cryptoTradeTitle,
  formatCoinAverage,
  formatCoinPrice,
  formatCoinQty,
} from "@/lib/crypto";
import { investmentEmoji, investmentSticker } from "@/lib/fun";
import { linkLabel } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { formatDate } from "@/lib/transactions";
import { CoinGeckoCredit } from "@/components/coingecko-credit";

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
        <ScreenHeader title={title} back />
        <View style={styles.center}>
          {load.status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading this coin" />
          ) : load.status === "missing" ? (
            <>
              <Text variant="titleMedium">Coin not found</Text>
              <Text variant="bodyMedium" style={[styles.centerText, { color: BRAND.zinc600 }]}>
                It may have been deleted.
              </Text>
              <ChunkyButton label="Back to investments" onPress={() => router.back()} />
            </>
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {load.status === "error" ? load.message : null}
              </Text>
              <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
            </>
          )}
        </View>
      </View>
    );
  }

  const { coin } = data;
  const coinId = String(coin.id);
  const total = data.crypto.by_coin.find((x) => x.coin_id === coin.id);
  const holdings = data.crypto.holdings.filter((h) => h.coin_id === coin.id);
  const locked = new Set(data.archived.map((a) => a.id));
  // Coins in an archived account can't be sold until it's restored.
  const sellable = holdings.filter((h) => !locked.has(h.account_id));

  const trade = (params: Record<string, string>) => go({ pathname: "/crypto-trade-form", params: { coinId, ...params } });
  // The prices come newest first; a line runs oldest to newest.
  const line = [...data.prices].reverse().map((p) => ({ date: p.date, value: p.price }));

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={coin.symbol}
        back
        right={
          <HeaderAction
            icon="pencil-outline"
            label="Rename or delete coin"
            onPress={() => go({ pathname: "/coin-form", params: { id: coinId } })}
          />
        }
      />

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <View style={styles.top}>
          <Text variant="bodyLarge" style={styles.name}>
            {coin.name}
          </Text>
          <GoalTagChip tag={holdings.find((h) => h.in_goal)?.in_goal} />

          {notice ? <Banner messages={[notice]} /> : null}

          <WorthTile
            label={`${investmentEmoji("crypto")} Current value`}
            value={formatRupees(total?.value ?? "0.00")}
            sticker={total ? investmentSticker(total.unrealised_percent) : null}
          >
            {total ? <GainPill unrealised={total.unrealised} percent={total.unrealised_percent} /> : null}
            {total ? (
              <Text variant="bodySmall" style={styles.onTile}>
                {formatRupees(total.invested)} invested{total.at_cost ? " · at cost" : ""}
              </Text>
            ) : null}
          </WorthTile>

          <StatsCard>
            <StatLine
              label="Price"
              value={coin.price !== null ? formatCoinPrice(coin.price) : "No price yet"}
              note={coin.price_date ? `as of ${formatDate(coin.price_date)}` : "Valued at cost"}
            />
            <StatLine
              label="Quantity held"
              value={formatCoinQty(total?.quantity ?? "0")}
              note={total ? `avg ${formatCoinAverage(total.average_price)}` : undefined}
            />
          </StatsCard>
        </View>

        <PriceLine points={line} title="Price" format={formatCoinPrice} />

        <View style={styles.actions}>
          <ChunkyButton
            variant="alt"
            icon="tag-outline"
            label="Update price"
            onPress={() => go({ pathname: "/coin-price-form", params: { coinId } })}
          />
          <ChunkyButton
            variant="alt"
            icon="link-variant"
            label={linkLabel(coin.source_code)}
            onPress={() =>
              go({
                pathname: "/link-form",
                params: { kind: "crypto", id: coinId, title: coin.symbol, ...(coin.source_code ? { code: coin.source_code } : {}) },
              })
            }
          />
          <View style={styles.tradeButtons}>
            {sellable.length > 0 ? (
              <ChunkyButton
                variant="pink"
                label="Sell"
                style={styles.grow}
                onPress={() => trade(sellable.length === 1 ? { mode: "sell", accountId: String(sellable[0].account_id) } : { mode: "sell" })}
              />
            ) : null}
            <ChunkyButton variant="green" label="Buy" style={styles.grow} onPress={() => trade({ mode: "buy" })} />
          </View>
        </View>

        {holdings.length > 0 ? (
          <>
            <SectionTitle label="Held in" />
            {holdings.map((h) => (
              <HeldRow
                key={h.account_id}
                emoji="🏦"
                title={h.account_name}
                lines={[`${formatCoinQty(h.quantity)} ${h.symbol} · avg ${formatCoinAverage(h.average_price)}`, `${formatRupees(h.invested)} invested`]}
                value={formatRupees(h.value)}
                atCost={h.at_cost}
                unrealised={h.unrealised}
                unrealisedPercent={h.unrealised_percent}
                action={
                  locked.has(h.account_id) ? null : (
                    <ChunkyButton
                      compact
                      variant="alt"
                      label="Sell"
                      accessibilityLabel={`Sell ${h.symbol} from ${h.account_name}`}
                      onPress={() => trade({ mode: "sell", accountId: String(h.account_id) })}
                    />
                  )
                }
              />
            ))}
          </>
        ) : null}

        <SectionTitle label="Transactions" />
        {data.trades.length === 0 ? (
          <EmptyBox text="No transactions yet." action={{ label: "Add existing coins", onPress: () => trade({ mode: "opening" }) }} />
        ) : (
          data.trades.map((t) => {
            const details = [
              formatDate(t.date),
              t.account_name,
              t.opening ? `avg ${formatCoinAverage(t.price)}` : `@ ${formatCoinPrice(t.price)}`,
              t.charges !== "0.00" ? `${formatRupees(t.charges)} charges` : null,
              t.note,
            ].filter((d): d is string => Boolean(d));
            return (
              <TradeRow
                key={t.id}
                emoji={investmentEmoji("crypto")}
                title={cryptoTradeTitle(t)}
                details={details}
                cash={t.opening ? "Cost" : t.side === "buy" ? "Paid" : "Received"}
                amount={formatRupees(t.amount)}
                realised={t.realised}
                archived={locked.has(t.account_id)}
                archivedNote="Archived account. Restore it to change this."
                archivedLabel="archived account"
                hint="Opens the transaction to edit or delete"
                onPress={() => trade({ id: String(t.id) })}
              />
            );
          })
        )}

        <SectionTitle label="Price history" />
        {data.prices.length === 0 ? (
          <EmptyBox text="No price recorded. Until you add one, holdings are valued at cost." />
        ) : (
          data.prices.map((price, index) => (
            <HistoryRow
              key={price.id}
              date={price.date}
              value={formatCoinPrice(price.price)}
              note={index === 0 ? "Current" : undefined}
              deleteLabel={`Delete the price on ${formatDate(price.date)}`}
              auto={price.source === "auto"}
              onDelete={() => setDeletingPrice(price)}
            />
          ))
        )}
        <CoinGeckoCredit />
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

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  top: { padding: 16, paddingTop: 8, gap: 12 },
  name: { color: BRAND.zinc600 },
  onTile: { color: "#FFFFFF", marginTop: 8 },
  actions: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  tradeButtons: { flexDirection: "row", gap: 12 },
  grow: { flex: 1 },
  chips: { gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
});
