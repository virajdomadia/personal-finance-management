import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GoalTagChip } from "@/components/goal-tag";
import { ChunkyButton, Chip, HeaderAction, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { EmptyBox, GainPill, HeldRow, HistoryRow, PriceLine, SectionTitle, StatLine, StatsCard, TradeRow, WorthTile } from "@/components/investment-parts";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Portfolio, type Price, type Stock, type Trade, tradeTitle } from "@/lib/investments";
import { investmentEmoji, investmentSticker } from "@/lib/fun";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
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
        <ScreenHeader title={title} back />
        <View style={styles.center}>
          {load.status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading this stock" />
          ) : load.status === "missing" ? (
            <>
              <Text variant="titleMedium">Stock not found</Text>
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
  // The prices come newest first; a line runs oldest to newest.
  const line = [...data.prices].reverse().map((p) => ({ date: p.date, value: p.price }));

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={stock.symbol}
        back
        right={
          <>
            <HeaderAction
              icon="pencil-outline"
              label="Rename stock"
              onPress={() => go({ pathname: "/stock-form", params: { stockId } })}
            />
            <HeaderAction icon="delete-outline" label="Delete stock" onPress={() => setDeletingStock(true)} />
          </>
        }
      />

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <View style={styles.top}>
          <Text variant="bodyLarge" style={styles.name}>
            {stock.name}
          </Text>
          <GoalTagChip tag={holdings.find((h) => h.in_goal)?.in_goal} />

          {notice ? <Banner messages={[notice]} /> : null}

          <WorthTile
            label={`${investmentEmoji("stock")} Current value`}
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
              label="Current price"
              value={stock.price !== null ? formatRupees(stock.price) : "No price yet"}
              note={stock.price_date ? `as of ${formatDate(stock.price_date)}` : "Valued at cost"}
            />
            <StatLine
              label="Shares held"
              value={String(total ? total.shares : 0)}
              note={total ? `avg cost ${formatRupees(total.average_cost)}` : undefined}
            />
          </StatsCard>
        </View>

        <PriceLine points={line} title="Price" format={formatRupees} />

        <View style={styles.actions}>
          <ChunkyButton
            variant="alt"
            icon="tag-outline"
            label="Update price"
            onPress={() => go({ pathname: "/price-form", params: { stockId } })}
          />
          <View style={styles.tradeButtons}>
            {sellable.length > 0 ? (
              <ChunkyButton
                variant="pink"
                label="Sell"
                style={styles.grow}
                onPress={() => trade(sellable.length === 1 ? { side: "sell", accountId: String(sellable[0].account_id) } : { side: "sell" })}
              />
            ) : null}
            <ChunkyButton variant="green" label="Buy" style={styles.grow} onPress={() => trade({ side: "buy" })} />
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
                lines={[`${h.shares} shares · avg cost ${formatRupees(h.average_cost)}`, `${formatRupees(h.invested)} invested`]}
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
                      onPress={() => trade({ side: "sell", accountId: String(h.account_id) })}
                    />
                  )
                }
              />
            ))}
          </>
        ) : null}

        <SectionTitle label="Trades" />
        {brokers.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {[["", "All brokers"] as const, ...brokers.map(([brokerId, name]) => [String(brokerId), name] as const)].map(
              ([value, label]) => (
                <Chip
                  key={value || "all"}
                  label={label}
                  selected={effective === value}
                  onPress={() => setFilter(value)}
                  accessibilityRole="radio"
                />
              ),
            )}
          </ScrollView>
        ) : null}
        {shown.length === 0 ? (
          <EmptyBox
            text={filterName ? `No trades in ${filterName} yet.` : "No trades yet."}
            action={{ label: "Add existing shares", onPress: () => trade({ opening: "1" }) }}
          />
        ) : (
          shown.map((t) => {
            const details = [
              formatDate(t.date),
              t.account_name,
              `${t.quantity} × ${formatRupees(t.price)}`,
              t.charges !== "0.00" ? `${formatRupees(t.charges)} charges` : null,
              t.note,
            ].filter((d): d is string => Boolean(d));
            return (
              <TradeRow
                key={t.id}
                emoji={investmentEmoji("stock")}
                title={tradeTitle(t)}
                details={details}
                cash={t.opening ? "Cost" : t.side === "buy" ? "Paid" : "Received"}
                amount={formatRupees(t.amount)}
                realised={t.realised}
                archived={locked.has(t.account_id)}
                archivedNote="Archived broker. Restore it to change this trade."
                archivedLabel="archived broker"
                hint="Opens the trade to edit or delete"
                onPress={() => go({ pathname: "/trade-form", params: { id: String(t.id), stockId } })}
              />
            );
          })
        )}

        <SectionTitle label="Price history" />
        {data.prices.length === 0 ? (
          <EmptyBox text="No prices recorded. Until you add one, holdings are valued at cost." />
        ) : (
          data.prices.map((price, index) => (
            <HistoryRow
              key={price.id}
              date={price.date}
              value={formatRupees(price.price)}
              note={index === 0 ? "Current" : undefined}
              deleteLabel={`Delete the price on ${formatDate(price.date)}`}
              onDelete={() => setDeletingPrice(price)}
            />
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
