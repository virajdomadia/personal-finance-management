import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GoalTagChip } from "@/components/goal-tag";
import { ChunkyBox, ChunkyButton, HeaderAction, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { EmptyBox, GainPill, HeldRow, HistoryRow, PriceLine, SectionTitle, StatLine, StatsCard, TradeRow, WorthTile } from "@/components/investment-parts";
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
import { investmentEmoji, investmentSticker } from "@/lib/fun";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
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
        <ScreenHeader title={title} back />
        <View style={styles.center}>
          {load.status === "loading" ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading this fund" />
          ) : load.status === "missing" ? (
            <>
              <Text variant="titleMedium">Fund not found</Text>
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

  const { fund } = data;
  const fundId = String(fund.id);
  const total = data.portfolio.funds.by_fund.find((x) => x.fund_id === fund.id);
  const holdings = data.portfolio.funds.holdings.filter((h) => h.fund_id === fund.id);
  const locked = new Set(data.archived.map((a) => a.id));
  // Units in an archived bank account can't be redeemed until it's restored.
  const redeemable = holdings.filter((h) => !locked.has(h.account_id));
  const sides = new Map(data.trades.map((t) => [t.id, t.side]));

  const trade = (params: Record<string, string>) => go({ pathname: "/fund-trade-form", params: { fundId, ...params } });
  const recordSip = (sip: Sip) =>
    trade({ mode: "sip", sipId: String(sip.id), ...(sip.due_date ? { date: sip.due_date } : {}) });
  // The NAVs come newest first; a line runs oldest to newest.
  const line = [...data.navs].reverse().map((n) => ({ date: n.date, value: n.nav }));

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title={fund.symbol}
        back
        right={
          <HeaderAction
            icon="pencil-outline"
            label="Rename or delete fund"
            onPress={() => go({ pathname: "/fund-form", params: { id: fundId } })}
          />
        }
      />

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
        <View style={styles.top}>
          <Text variant="titleMedium" style={styles.name}>
            {fund.name}
          </Text>
          <GoalTagChip tag={holdings.find((h) => h.in_goal)?.in_goal} />

          {notice ? <Banner messages={[notice]} /> : null}

          <WorthTile
            label={`${investmentEmoji("mutual_fund")} Current value`}
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
              label="NAV"
              value={fund.nav !== null ? formatNav(fund.nav) : "No NAV yet"}
              note={fund.nav_date ? `as of ${formatDate(fund.nav_date)}` : "Valued at cost"}
            />
            <StatLine
              label="Units held"
              value={formatUnits(total?.units ?? "0.000")}
              note={total ? `avg NAV ${formatNav(total.average_nav)}` : undefined}
            />
          </StatsCard>
        </View>

        <PriceLine points={line} title="NAV" format={formatNav} />

        <View style={styles.actions}>
          <ChunkyButton
            variant="alt"
            icon="tag-outline"
            label="Update NAV"
            onPress={() => go({ pathname: "/nav-form", params: { fundId } })}
          />
          <View style={styles.tradeButtons}>
            {redeemable.length > 0 ? (
              <ChunkyButton
                variant="pink"
                label="Redeem"
                style={styles.grow}
                onPress={() =>
                  trade(redeemable.length === 1 ? { mode: "sell", accountId: String(redeemable[0].account_id) } : { mode: "sell" })
                }
              />
            ) : null}
            <ChunkyButton variant="green" label="Buy" style={styles.grow} onPress={() => trade({ mode: "buy" })} />
          </View>
        </View>

        <SectionTitle
          label="SIPs"
          action={
            data.sips.length > 0 ? (
              <ChunkyButton
                compact
                variant="alt"
                icon="plus"
                label="Add SIP"
                onPress={() => go({ pathname: "/sip-form", params: { fundId } })}
              />
            ) : undefined
          }
        />
        {data.sips.length === 0 ? (
          <EmptyBox
            text="No SIP in this fund. A SIP reminds you each month, and you record it with that day's NAV."
            action={{ label: "Add SIP", onPress: () => go({ pathname: "/sip-form", params: { fundId } }) }}
          />
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
            <SectionTitle label="Held in" />
            {holdings.map((h) => (
              <HeldRow
                key={h.account_id}
                emoji="🏦"
                title={h.account_name}
                lines={[`${formatUnits(h.units)} units · avg NAV ${formatNav(h.average_nav)}`, `${formatRupees(h.invested)} invested`]}
                value={formatRupees(h.value)}
                atCost={h.at_cost}
                unrealised={h.unrealised}
                unrealisedPercent={h.unrealised_percent}
                action={
                  locked.has(h.account_id) ? null : (
                    <ChunkyButton
                      compact
                      variant="alt"
                      label="Redeem"
                      accessibilityLabel={`Redeem ${h.symbol} from ${h.account_name}`}
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
          <EmptyBox text="No transactions yet." action={{ label: "Add existing units", onPress: () => trade({ mode: "opening" }) }} />
        ) : (
          data.trades.map((t) => {
            const details = [
              formatDate(t.date),
              t.account_name,
              t.opening ? `avg NAV ${formatNav(t.nav)}` : `NAV ${formatNav(t.nav)}`,
              t.charges !== "0.00" ? `${formatRupees(t.charges)} ${t.side === "buy" ? "stamp duty" : "charges"}` : null,
              t.note,
            ].filter((d): d is string => Boolean(d));
            return (
              <TradeRow
                key={t.id}
                emoji={investmentEmoji("mutual_fund")}
                title={fundTradeTitle(t)}
                details={details}
                cash={t.opening ? "Cost" : t.side === "buy" ? "Paid" : "Received"}
                amount={formatRupees(t.amount)}
                realised={t.realised}
                archived={locked.has(t.account_id)}
                archivedNote="Archived bank account. Restore it to change this."
                archivedLabel="archived bank account"
                hint="Opens the transaction to edit or delete"
                onPress={() => trade({ id: String(t.id) })}
              />
            );
          })
        )}

        <SectionTitle label="NAV history" />
        {data.navs.length === 0 ? (
          <EmptyBox text="No NAV recorded. Until you add one, holdings are valued at cost." />
        ) : (
          data.navs.map((nav, index) => {
            const source =
              nav.trade_id === null ? null : sides.get(nav.trade_id) === "sell" ? "from a redemption" : "from a purchase";
            const note = [index === 0 ? "Current" : null, source].filter(Boolean).join(" · ");
            return (
              <HistoryRow
                key={nav.id}
                date={nav.date}
                value={formatNav(nav.nav)}
                note={note || undefined}
                deleteLabel={`Delete the NAV on ${formatDate(nav.date)}`}
                onDelete={() => setDeletingNav(nav)}
              />
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

const styles = StyleSheet.create({
  sipCard: { padding: 12, gap: 2 },
  sipTitle: { color: BRAND.ink },
  sipDetails: { color: BRAND.zinc600 },
  sipActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  top: { padding: 16, paddingTop: 8, gap: 12 },
  name: { color: BRAND.zinc600 },
  onTile: { color: "#FFFFFF", marginTop: 8 },
  actions: { paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  tradeButtons: { flexDirection: "row", gap: 12 },
  grow: { flex: 1 },
  sipList: { gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
});

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
    <ChunkyBox radius={14} offset={3} style={[styles.sipCard, { backgroundColor: due ? BRAND.due : BRAND.card }]}>
      <Text variant="titleMedium" style={styles.sipTitle}>
        {label}
      </Text>
      <Text variant="labelLarge" style={styles.sipTitle}>
        {status}
      </Text>
      <Text variant="bodySmall" style={styles.sipDetails}>
        {details}
      </Text>
      <View style={styles.sipActions}>
        <ChunkyButton compact variant="alt" label="Edit" disabled={busy} accessibilityLabel={`Edit the ${label}`} onPress={onEdit} />
        <ChunkyButton
          compact
          variant="alt"
          label={sip.active ? "Stop" : "Restart"}
          disabled={busy && !saving}
          loading={saving}
          accessibilityLabel={`${sip.active ? "Stop" : "Restart"} the ${label}`}
          onPress={onActive}
        />
        {due ? (
          <ChunkyButton compact variant="green" label="Record" disabled={busy} accessibilityLabel={`Record the ${label}`} onPress={onRecord} />
        ) : null}
      </View>
    </ChunkyBox>
  );
}
