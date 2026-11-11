import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import {
  Appbar,
  Button,
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

import { GoalTagChip } from "@/components/goal-tag";
import { Signed, signedLabel } from "@/components/signed";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Fund,
  type FundTrade,
  type Nav,
  type Sip,
  formatNav,
  formatUnits,
  fundTradeTitle,
} from "@/lib/funds";
import type { Portfolio } from "@/lib/investments";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/transactions";

type Data = {
  fund: Fund;
  portfolio: Portfolio;
  trades: FundTrade[];
  navs: Nav[];
  sips: Sip[];
  archived: Account[];
};

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "missing" } | { status: "ready"; data: Data };

async function fetchData(fundId: string, token: string | undefined): Promise<Data | null> {
  const auth = { token };
  const [funds, portfolio, trades, navs, sips, archived] = await Promise.all([
    apiFetch<{ funds: Fund[] }>("/investments/funds", auth),
    apiFetch<Portfolio>("/investments/portfolio", auth),
    apiFetch<{ trades: FundTrade[] }>(`/investments/fund-trades?fund_id=${fundId}`, auth),
    apiFetch<{ navs: Nav[] }>(`/investments/funds/${fundId}/navs`, auth),
    apiFetch<{ sips: Sip[] }>(`/investments/sips?fund_id=${fundId}`, auth),
    apiFetch<AccountList>("/accounts?archived=true", auth),
  ]);
  const fund = funds.funds.find((f) => String(f.id) === fundId);
  if (!fund) return null;
  return { fund, portfolio, trades: trades.trades, navs: navs.navs, sips: sips.sips, archived: archived.accounts };
}

function sipAmount(sip: Sip): string {
  return formatRupees(sip.amount.replace(/\.00$/, ""));
}

export default function FundScreen() {
  const { id, symbol } = useLocalSearchParams<{ id: string; symbol?: string }>();
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingNav, setDeletingNav] = useState<Nav | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sipBusy, setSipBusy] = useState<number | null>(null);
  const deletingRef = useRef(false);
  const sipBusyRef = useRef(false);
  const latest = useRef(0);
  const navigating = useRef(false);
  // A valid id is a whole number; anything else can't be a fund, so don't ask the API.
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
      setNotice("We couldn't refresh this fund. Pull down to try again.");
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
      if (state !== "active" && !deletingRef.current) setDeletingNav(null);
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

  async function removeNav() {
    if (!deletingNav || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    let failure: string | null = null;
    try {
      await apiFetch(`/investments/navs/${deletingNav.id}`, { method: "DELETE", token: token ?? undefined });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      failure = errorMessage(err instanceof ApiError ? { detail: err.detail } : err);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
      setDeletingNav(null);
    }
    // A successful reload clears the notice, so a failure is shown after it.
    await reload();
    if (failure !== null) setNotice(failure);
  }

  // Stopping keeps the SIP's past instalments; a stopped SIP is never due.
  async function setSipActive(sip: Sip, active: boolean) {
    if (sipBusyRef.current) return;
    sipBusyRef.current = true;
    setSipBusy(sip.id);
    let failure: string | null = null;
    try {
      await apiFetch<Sip>(`/investments/sips/${sip.id}`, { method: "PATCH", token: token ?? undefined, body: { active } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      failure = errorMessage(err instanceof ApiError ? { detail: err.detail } : err);
    } finally {
      sipBusyRef.current = false;
      setSipBusy(null);
    }
    await reload();
    if (failure !== null) setNotice(failure);
  }

  const data = load.status === "ready" ? load.data : null;
  const title = data?.fund.symbol ?? symbol ?? "Fund";

  if (data === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Appbar.Header>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title={title} />
        </Appbar.Header>
        <View style={styles.center}>
          {load.status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading this fund" />
          ) : load.status === "missing" ? (
            <>
              <Text variant="titleMedium">Fund not found</Text>
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

  const { fund } = data;
  const fundId = String(fund.id);
  const total = data.portfolio.funds.by_fund.find((f) => f.fund_id === fund.id);
  const holdings = data.portfolio.funds.holdings.filter((h) => h.fund_id === fund.id);
  const locked = new Set(data.archived.map((a) => a.id));
  // Units in an archived bank account can't be redeemed until it's restored.
  const redeemable = holdings.filter((h) => !locked.has(h.account_id));
  const sides = new Map(data.trades.map((t) => [t.id, t.side]));

  const trade = (params: Record<string, string>) => go({ pathname: "/fund-trade-form", params: { fundId, ...params } });
  const recordSip = (sip: Sip) =>
    trade({ mode: "sip", sipId: String(sip.id), ...(sip.due_date ? { date: sip.due_date } : {}) });

  const sectionTitle = (label: string, action?: React.ReactNode) => (
    <View style={styles.sectionRow}>
      <Text variant="titleSmall" accessibilityRole="header" style={[styles.sectionHeader, { color: colors.primary }]}>
        {label}
      </Text>
      {action}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={fund.symbol} />
        <Appbar.Action
          icon="pencil-outline"
          accessibilityLabel="Rename or delete fund"
          onPress={() => go({ pathname: "/fund-form", params: { id: fundId } })}
        />
      </Appbar.Header>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <View style={styles.top}>
          <Text variant="titleMedium">{fund.name}</Text>
          <GoalTagChip tag={holdings.find((h) => h.in_goal)?.in_goal} />

          {notice ? (
            <View style={[styles.banner, { backgroundColor: colors.errorContainer }]}>
              <Text variant="bodyMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
                {notice}
              </Text>
            </View>
          ) : null}

          <Surface elevation={1} style={styles.summary}>
            <Line label="NAV">
              <View style={styles.end}>
                <Text variant="titleMedium" style={styles.right}>
                  {fund.nav !== null ? formatNav(fund.nav) : "No NAV yet"}
                </Text>
                <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
                  {fund.nav_date ? `as of ${formatDate(fund.nav_date)}` : "Valued at cost"}
                </Text>
              </View>
            </Line>
            <Line label="Units held">
              <View style={styles.end}>
                <Text variant="titleMedium" style={styles.right}>
                  {formatUnits(total?.units ?? "0.000")}
                </Text>
                {total ? (
                  <Text variant="bodySmall" style={[styles.right, { color: colors.onSurfaceVariant }]}>
                    avg NAV {formatNav(total.average_nav)}
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
              <Button mode="text" icon="tag-outline" onPress={() => go({ pathname: "/nav-form", params: { fundId } })}>
                Update NAV
              </Button>
              {redeemable.length > 0 ? (
                <Button
                  mode="outlined"
                  onPress={() =>
                    trade(redeemable.length === 1 ? { mode: "sell", accountId: String(redeemable[0].account_id) } : { mode: "sell" })
                  }
                >
                  Redeem
                </Button>
              ) : null}
              <Button mode="contained" onPress={() => trade({ mode: "buy" })}>
                Buy
              </Button>
            </View>
          </Surface>
        </View>

        {sectionTitle(
          "SIPs",
          data.sips.length > 0 ? (
            <Button compact icon="plus" onPress={() => go({ pathname: "/sip-form", params: { fundId } })}>
              Add SIP
            </Button>
          ) : undefined,
        )}
        {data.sips.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
              No SIP in this fund. A SIP reminds you each month, and you record it with that day&apos;s NAV.
            </Text>
            <Button mode="outlined" onPress={() => go({ pathname: "/sip-form", params: { fundId } })}>
              Add SIP
            </Button>
          </View>
        ) : (
          <View style={styles.sipList}>
            {data.sips.map((sip) => (
              <SipCard
                key={sip.id}
                sip={sip}
                busy={sipBusy !== null}
                saving={sipBusy === sip.id}
                onRecord={() => recordSip(sip)}
                onEdit={() => go({ pathname: "/sip-form", params: { id: String(sip.id), fundId } })}
                onActive={() => void setSipActive(sip, !sip.active)}
              />
            ))}
          </View>
        )}

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
                      {formatUnits(h.units)} units · avg NAV {formatNav(h.average_nav)}
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
                      accessibilityLabel={`Redeem ${h.symbol} from ${h.account_name}`}
                      onPress={() => trade({ mode: "sell", accountId: String(h.account_id) })}
                    >
                      Redeem
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
              Add existing units
            </Button>
          </View>
        ) : (
          data.trades.map((t, index) => (
            <View key={t.id}>
              {index > 0 ? <Divider /> : null}
              <TradeRow
                trade={t}
                archived={locked.has(t.account_id)}
                onPress={() => trade({ id: String(t.id) })}
              />
            </View>
          ))
        )}

        {sectionTitle("NAV history")}
        {data.navs.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
              No NAV recorded. Until you add one, holdings are valued at cost.
            </Text>
          </View>
        ) : (
          data.navs.map((nav, index) => {
            const source =
              nav.trade_id === null ? null : sides.get(nav.trade_id) === "sell" ? "from a redemption" : "from a purchase";
            const note = [index === 0 ? "Current" : null, source].filter(Boolean).join(" · ");
            return (
              <View key={nav.id}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.navRow}>
                  <View style={styles.main}>
                    <Text variant="bodyLarge">{formatDate(nav.date)}</Text>
                    {note ? (
                      <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                        {note}
                      </Text>
                    ) : null}
                  </View>
                  <Text variant="titleMedium">{formatNav(nav.nav)}</Text>
                  <IconButton
                    icon="delete-outline"
                    accessibilityLabel={`Delete the NAV on ${formatDate(nav.date)}`}
                    onPress={() => setDeletingNav(nav)}
                  />
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      <Portal>
        <Dialog visible={deletingNav !== null} onDismiss={() => (deleting ? undefined : setDeletingNav(null))}>
          <Dialog.Title>
            {deletingNav ? `Delete the NAV of ${formatNav(deletingNav.nav)} on ${formatDate(deletingNav.date)}?` : "Delete this NAV?"}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              It&apos;s removed for good, and holdings are valued at the NAV before it (or at cost if there is none). This
              can&apos;t be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeletingNav(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button onPress={() => void removeNav()} loading={deleting} disabled={deleting}>
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

// One SIP: its status up top, and the actions a thumb needs underneath. Delete lives in its edit screen.
function SipCard({
  sip,
  busy,
  saving,
  onRecord,
  onEdit,
  onActive,
}: {
  sip: Sip;
  busy: boolean;
  saving: boolean;
  onRecord: () => void;
  onEdit: () => void;
  onActive: () => void;
}) {
  const { colors } = useTheme();
  const due = sip.active && sip.due_date !== null;
  const label = `${sipAmount(sip)} SIP on day ${sip.day}`;
  const status = !sip.active
    ? "Stopped"
    : due
      ? `Due since ${formatDate(sip.due_date ?? "")}${sip.due.length > 1 ? ` (${sip.due.length} months)` : ""}`
      : "Up to date";
  const details = [
    sip.account_name,
    `from ${formatDate(sip.start_date)}`,
    `${sip.instalments} ${sip.instalments === 1 ? "instalment" : "instalments"}`,
  ].join(" · ");
  return (
    <Surface
      elevation={0}
      style={[styles.sipCard, { backgroundColor: due ? colors.tertiaryContainer : colors.surfaceVariant }]}
    >
      <Text variant="titleMedium" style={{ color: due ? colors.onTertiaryContainer : colors.onSurface }}>
        {label}
      </Text>
      <Text variant="labelLarge" style={{ color: due ? colors.onTertiaryContainer : colors.onSurfaceVariant }}>
        {status}
      </Text>
      <Text variant="bodySmall" style={{ color: due ? colors.onTertiaryContainer : colors.onSurfaceVariant }}>
        {details}
      </Text>
      <View style={styles.sipActions}>
        <Button compact disabled={busy} accessibilityLabel={`Edit the ${label}`} onPress={onEdit}>
          Edit
        </Button>
        <Button
          compact
          disabled={busy}
          loading={saving}
          accessibilityLabel={`${sip.active ? "Stop" : "Restart"} the ${label}`}
          onPress={onActive}
        >
          {sip.active ? "Stop" : "Restart"}
        </Button>
        {due ? (
          <Button mode="contained" compact disabled={busy} accessibilityLabel={`Record the ${label}`} onPress={onRecord}>
            Record
          </Button>
        ) : null}
      </View>
    </Surface>
  );
}

// One transaction. Tapping opens it to edit or delete; ones in an archived bank are locked until it's restored.
function TradeRow({ trade, archived, onPress }: { trade: FundTrade; archived: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const title = fundTradeTitle(trade);
  const details = [
    formatDate(trade.date),
    trade.account_name,
    trade.opening ? `avg NAV ${formatNav(trade.nav)}` : `NAV ${formatNav(trade.nav)}`,
    trade.charges !== "0.00" ? `${formatRupees(trade.charges)} ${trade.side === "buy" ? "stamp duty" : "charges"}` : null,
    trade.note,
  ].filter(Boolean);
  const cash = trade.opening ? "Cost" : trade.side === "buy" ? "Paid" : "Received";
  return (
    <TouchableRipple
      onPress={onPress}
      disabled={archived}
      accessibilityRole={archived ? undefined : "button"}
      accessibilityLabel={`${title}, ${details.join(", ")}, ${cash} ${formatRupees(trade.amount)}${trade.realised !== null ? `, realised ${signedLabel(trade.realised)}` : ""}${archived ? ", archived bank account" : ""}`}
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
              Archived bank account. Restore it to change this.
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
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingRight: 8 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  sipList: { gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  sipCard: { borderRadius: 12, padding: 12, gap: 2 },
  sipActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 4, marginTop: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  main: { flex: 1, gap: 2 },
  amounts: { flexShrink: 1, maxWidth: "55%", alignItems: "flex-end" },
  rowAction: { alignItems: "flex-end", paddingHorizontal: 8, paddingBottom: 4 },
  navRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16, paddingRight: 4, paddingVertical: 4 },
  emptyBox: { alignItems: "center", gap: 12, paddingHorizontal: 24, paddingVertical: 16 },
});
