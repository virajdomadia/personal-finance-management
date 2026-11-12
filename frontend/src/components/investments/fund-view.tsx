"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Fund,
  type FundHolding,
  type FundTrade,
  type FundTradeForm,
  type FundTradeMode,
  type Nav,
  type Sip,
  blankFundTradeForm,
  dueText,
  formatNav,
  formatUnits,
  sipTradeForm,
} from "@/lib/funds";
import { type Portfolio, linkLabel } from "@/lib/investments";
import { formatDate, todayIndia } from "@/lib/transactions";

import { FundDialog } from "./fund-dialog";
import { FundTradeDialog } from "./fund-trade-dialog";
import { LinkDialog } from "./link-dialog";
import { NavDialog } from "./nav-dialog";
import { Tile } from "@/components/ui/chunky";
import { investmentSticker } from "@/lib/fun";
import {
  ConfirmDelete,
  LIST,
  Notice,
  QUIET,
  ROW_ACTION,
  SECONDARY,
  SECTION_TITLE,
  Signed,
  BUY,
  SELL,
  PlainSigned,
  AutoBadge,
  PriceCard,
  TradeTr,
  TradesTable,
  BackLink,
  archivedIds,
  isUnauthorized,
  GoalTagLink,
} from "./shared";
import { SipDialog } from "./sip-dialog";

type Data = {
  fund: Fund;
  funds: Fund[];
  portfolio: Portfolio;
  trades: FundTrade[];
  navs: Nav[];
  sips: Sip[];
  active: Account[];
  archived: Account[];
};
type Load = { status: "loading" } | { status: "error" } | { status: "missing" } | { status: "ready"; data: Data };
type Dialog =
  | { kind: "none" }
  | { kind: "trade"; trade: FundTrade | null; initial: FundTradeForm; focusNav: boolean }
  | { kind: "deleteTrade"; trade: FundTrade }
  | { kind: "nav" }
  | { kind: "deleteNav"; nav: Nav }
  | { kind: "sip"; sip: Sip | null }
  | { kind: "deleteSip"; sip: Sip }
  | { kind: "rename" }
  | { kind: "link" }
  | { kind: "deleteFund" };

async function fetchData(fundId: number): Promise<Data | null> {
  const [funds, portfolio, trades, navs, sips, active, archived] = await Promise.all([
    apiFetch<{ funds: Fund[] }>("/investments/funds"),
    apiFetch<Portfolio>("/investments/portfolio"),
    apiFetch<{ trades: FundTrade[] }>(`/investments/fund-trades?fund_id=${fundId}`),
    apiFetch<{ navs: Nav[] }>(`/investments/funds/${fundId}/navs`),
    apiFetch<{ sips: Sip[] }>("/investments/sips"),
    apiFetch<AccountList>("/accounts"),
    apiFetch<AccountList>("/accounts?archived=true"),
  ]);
  const fund = funds.funds.find((f) => f.id === fundId);
  if (!fund) return null;
  return {
    fund,
    funds: funds.funds,
    portfolio,
    trades: trades.trades,
    navs: navs.navs,
    sips: sips.sips,
    active: active.accounts,
    archived: archived.accounts,
  };
}

// "SIP due" lines, each with a Record SIP button.
export function DueSips({ sips, onRecord }: { sips: Sip[]; onRecord: (sip: Sip) => void }) {
  if (sips.length === 0) return null;
  return (
    <ul aria-label="SIPs due" className="flex flex-col gap-2">
      {sips.map((sip) => (
        <li
          key={sip.id}
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[14px] border-[2.5px] border-ink bg-due px-4 py-2 shadow-chunky-sm"
        >
          <p className="min-w-0 flex-1 text-sm font-extrabold [overflow-wrap:anywhere]">{dueText(sip)}</p>
          <button type="button" className={SECONDARY} onClick={() => onRecord(sip)}>
            Record SIP
          </button>
        </li>
      ))}
    </ul>
  );
}

export function fundTradeTitle(trade: FundTrade): string {
  const units = `${formatUnits(trade.units)} units`;
  if (trade.opening) return `Existing ${units}`;
  if (trade.side === "sell") return `Redeemed ${units}`;
  return trade.sip_id !== null ? `SIP: ${units}` : `Bought ${units}`;
}

function FundTradeRow({
  trade,
  archived,
  onEdit,
  onDelete,
}: {
  trade: FundTrade;
  archived: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const title = fundTradeTitle(trade);
  const cash = trade.opening ? "Cost" : trade.side === "buy" ? "Paid" : "Received";
  return (
    <TradeTr
      title={title}
      chip={trade.estimated ? "estimated" : undefined}
      date={trade.date}
      details={[
        trade.account_name,
        trade.opening ? `avg NAV ${formatNav(trade.nav)}` : `NAV ${formatNav(trade.nav)}`,
        trade.charges !== "0.00" ? `${formatRupees(trade.charges)} ${trade.side === "buy" ? "stamp duty" : "charges"}` : null,
        trade.note,
      ]}
      cashLabel={cash}
      amount={trade.amount}
      realised={trade.realised}
      archived={archived}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

function sipAmount(sip: Sip): string {
  return formatRupees(sip.amount.replace(/\.00$/, ""));
}

export function FundView({ fundId }: { fundId: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [busySip, setBusySip] = useState<number | null>(null);
  const latest = useRef(0);
  const router = useRouter();

  const reload = useCallback(() => {
    const request = ++latest.current;
    fetchData(fundId)
      .then((data) => {
        if (request === latest.current) setLoad(data ? { status: "ready", data } : { status: "missing" });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request !== latest.current) return;
        else if (err instanceof ApiError && err.status === 404) setLoad({ status: "missing" });
        else setLoad({ status: "error" });
      });
  }, [fundId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const closeDialog = () => setDialog({ kind: "none" });
  const done = (message: string | null) => {
    setNotice(message);
    closeDialog();
    reload();
  };
  const data = load.status === "ready" ? load.data : null;
  const holdings = data?.portfolio.funds.holdings.filter((h) => h.fund_id === fundId) ?? [];
  const fundSips = data?.sips.filter((s) => s.fund_id === fundId) ?? [];
  const due = fundSips.filter((s) => s.due_date !== null).sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));

  const openTrade = (mode: FundTradeMode, accountId: number | null = null) => {
    const initial = { ...blankFundTradeForm(mode, todayIndia()), fund_id: String(fundId) };
    if (accountId !== null) initial.account_id = String(accountId);
    setDialog({ kind: "trade", trade: null, initial, focusNav: false });
  };
  const recordSip = (sip: Sip) =>
    setDialog({ kind: "trade", trade: null, initial: sipTradeForm(sip, sip.due_date ?? todayIndia()), focusNav: true });

  async function setSipActive(sip: Sip, active: boolean) {
    if (busySip !== null) return;
    setBusySip(sip.id);
    try {
      await apiFetch<Sip>(`/investments/sips/${sip.id}`, { method: "PATCH", body: JSON.stringify({ active }) });
      setNotice(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        void logout();
        return;
      }
      setNotice(errorMessage(err));
    } finally {
      setBusySip(null);
    }
    reload();
  }

  return (
    <div className="mx-auto max-w-4xl">
      <BackLink />

      {data && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-black [overflow-wrap:anywhere]"><span aria-hidden="true">🥧 </span>{data.fund.name}</h1>
            <p className="text-sm font-bold text-zinc-700 [overflow-wrap:anywhere]">{data.fund.symbol} · mutual fund</p>
            <GoalTagLink tag={holdings.find((h) => h.in_goal)?.in_goal} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "rename" })}>
              Rename
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "link" })}>
              {linkLabel(data.fund.source_code)}
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "deleteFund" })}>
              Delete fund
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "nav" })}>
              Update NAV
            </button>
            {holdings.length > 0 && (
              <button type="button" className={SELL} onClick={() => openTrade("sell", holdings.length === 1 ? holdings[0].account_id : null)}>
                Redeem
              </button>
            )}
            <button type="button" className={BUY} onClick={() => openTrade("buy")}>
              Buy
            </button>
          </div>
        </div>
      )}

      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading this fund...
        </p>
      )}

      {load.status === "missing" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <h1 className="font-extrabold">Fund not found</h1>
          <p className="mt-1 font-bold text-zinc-600">It may have been deleted.</p>
        </div>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <p>We couldn&apos;t load this fund.</p>
          <button
            type="button"
            className={`${QUIET} mt-2`}
            onClick={() => {
              setLoad({ status: "loading" });
              reload();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-8">
          <DueSips sips={due} onRecord={recordSip} />
          <FundSummary data={data} />
          <BankHoldings holdings={holdings} onRedeem={(h) => openTrade("sell", h.account_id)} />
          <Sips
            sips={fundSips}
            busy={busySip}
            onAdd={() => setDialog({ kind: "sip", sip: null })}
            onEdit={(sip) => setDialog({ kind: "sip", sip })}
            onActive={setSipActive}
            onDelete={(sip) => setDialog({ kind: "deleteSip", sip })}
          />
          <Transactions
            data={data}
            onAdd={() => openTrade("opening")}
            onEdit={(trade) => setDialog({ kind: "trade", trade, initial: blankFundTradeForm("buy", trade.date), focusNav: false })}
            onDelete={(trade) => setDialog({ kind: "deleteTrade", trade })}
          />
          <NavHistory navs={data.navs} trades={data.trades} onDelete={(nav) => setDialog({ kind: "deleteNav", nav })} />
        </div>
      )}

      {dialog.kind === "trade" && data && (
        <FundTradeDialog
          key={dialog.trade?.id ?? `new-${dialog.initial.mode}`}
          trade={dialog.trade}
          initial={dialog.initial}
          funds={data.funds}
          banks={data.active.filter((a) => a.type === "bank")}
          holdings={data.portfolio.funds.holdings}
          sips={data.sips}
          focusNav={dialog.focusNav}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
          onFundCreated={reload}
        />
      )}

      {dialog.kind === "deleteTrade" && (
        <ConfirmDelete
          title={`Delete ${fundTradeTitle(dialog.trade)} on ${formatDate(dialog.trade.date)}?`}
          body={
            dialog.trade.opening
              ? "It's removed for good, and the holding shrinks. This can't be undone."
              : `It's removed for good, ${dialog.trade.account_name}'s balance moves back, and the NAV recorded with it goes too. This can't be undone.`
          }
          path={`/investments/fund-trades/${dialog.trade.id}`}
          onClose={closeDialog}
          onDone={done}
        />
      )}

      {dialog.kind === "nav" && data && <NavDialog fund={data.fund} onClose={closeDialog} onSaved={() => done(null)} onConflict={done} />}

      {dialog.kind === "deleteNav" && (
        <ConfirmDelete
          title={`Delete the NAV of ${formatNav(dialog.nav.nav)} on ${formatDate(dialog.nav.date)}?`}
          body="It's removed for good, and holdings are valued at the NAV before it (or at cost if there is none). This can't be undone."
          path={`/investments/navs/${dialog.nav.id}`}
          onClose={closeDialog}
          onDone={done}
        />
      )}

      {dialog.kind === "sip" && data && (
        <SipDialog
          sip={dialog.sip}
          funds={data.funds}
          banks={data.active.filter((a) => a.type === "bank")}
          defaultFundId={fundId}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
          onFundCreated={reload}
        />
      )}

      {dialog.kind === "deleteSip" && (
        <ConfirmDelete
          title={`Delete the ${sipAmount(dialog.sip)} SIP?`}
          body="Only a SIP with no instalments recorded can be deleted. This can't be undone."
          path={`/investments/sips/${dialog.sip.id}`}
          onClose={closeDialog}
          onDone={done}
        />
      )}

      {dialog.kind === "link" && data && (
        <LinkDialog
          kind="mutual_fund"
          path={`/investments/funds/${data.fund.id}`}
          title={`${data.fund.name}: live prices`}
          linkedCode={data.fund.source_code}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
        />
      )}

      {dialog.kind === "rename" && data && <FundDialog fund={data.fund} onClose={closeDialog} onSaved={() => done(null)} onConflict={done} />}

      {dialog.kind === "deleteFund" && data && (
        <ConfirmDelete
          title={`Delete ${data.fund.name}?`}
          body="Only a fund with no transactions, NAVs or SIPs can be deleted. This can't be undone."
          path={`/investments/funds/${data.fund.id}`}
          onClose={closeDialog}
          onDone={(message) => {
            if (message === null) router.push("/investments");
            else done(message);
          }}
        />
      )}
    </div>
  );
}

function FundSummary({ data }: { data: Data }) {
  const total = data.portfolio.funds.by_fund.find((f) => f.fund_id === data.fund.id);
  const { fund } = data;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <Tile
            tone="blue"
            size="huge"
            emoji="🥧"
            label="Worth today"
            value={formatRupees(total?.value ?? "0.00")}
            sticker={investmentSticker(total?.unrealised_percent ?? null)}
          >
            {total ? (
              <span className="mt-0.5 block text-xs font-extrabold break-words">
                <PlainSigned value={total.unrealised} percent={total.unrealised_percent} />
                {total.at_cost ? " · at cost" : ""}
              </span>
            ) : null}
          </Tile>
        </div>
        <Tile tone="yellow" emoji="💰" label="You put in" value={formatRupees(total?.invested ?? "0.00")} />
        <Tile label="Units held" value={total ? formatUnits(total.units) : "0.000"}>
          {total ? <span className="mt-0.5 block text-xs font-bold text-zinc-600">avg NAV {formatNav(total.average_nav)}</span> : null}
        </Tile>
      </div>
      <PriceCard
        label="Current NAV"
        value={fund.nav !== null ? formatNav(fund.nav) : "—"}
        sub={fund.nav_date ? `as of ${formatDate(fund.nav_date)}` : "No NAV recorded yet"}
        points={data.navs.map((n) => ({ date: n.date, value: Number(n.nav) }))}
        lineLabel="NAV history"
      />
    </div>
  );
}

function BankHoldings({ holdings, onRedeem }: { holdings: FundHolding[]; onRedeem: (h: FundHolding) => void }) {
  if (holdings.length === 0) return null;
  return (
    <section aria-labelledby="by-bank-title">
      <h2 id="by-bank-title" className={SECTION_TITLE}>
        Held through
      </h2>
      <ul className={LIST}>
        {holdings.map((h) => (
          <li key={h.account_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-32 flex-1">
              <p className="text-sm font-extrabold [overflow-wrap:anywhere]">{h.account_name}</p>
              <p className="text-xs font-bold text-zinc-600 tabular-nums">
                {formatUnits(h.units)} units · avg NAV {formatNav(h.average_nav)} · {formatRupees(h.invested)} invested
              </p>
            </div>
            <div className="text-right text-sm tabular-nums">
              <p className="font-extrabold">
                {h.at_cost && <span className="mr-1.5 text-xs font-bold text-zinc-600">at cost</span>}
                {formatRupees(h.value)}
              </p>
              <p className="text-xs">
                <Signed value={h.unrealised} /> · <Signed value={h.unrealised_percent} percentOnly />
              </p>
            </div>
            <div className="flex w-24 shrink-0 justify-end">
              <button type="button" className={ROW_ACTION} aria-label={`Redeem ${h.name} from ${h.account_name}`} onClick={() => onRedeem(h)}>
                Redeem
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Sips({
  sips,
  busy,
  onAdd,
  onEdit,
  onActive,
  onDelete,
}: {
  sips: Sip[];
  busy: number | null;
  onAdd: () => void;
  onEdit: (sip: Sip) => void;
  onActive: (sip: Sip, active: boolean) => void;
  onDelete: (sip: Sip) => void;
}) {
  return (
    <section aria-labelledby="sips-title">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 id="sips-title" className="text-xs font-black tracking-wider uppercase">
          SIPs
        </h2>
        {sips.length > 0 && (
          <button type="button" className={ROW_ACTION} onClick={onAdd}>
            Add SIP
          </button>
        )}
      </div>
      {sips.length === 0 ? (
        <div className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-4 py-6 text-center text-sm font-extrabold text-zinc-700">
          <p>No SIP in this fund. A SIP reminds you each month, and you record it with that day&apos;s NAV.</p>
          <button type="button" className={`${QUIET} mt-2`} onClick={onAdd}>
            Add SIP
          </button>
        </div>
      ) : (
        <ul className={LIST}>
          {sips.map((sip) => {
            const label = `${sipAmount(sip)} SIP on day ${sip.day}`;
            const status = !sip.active
              ? "Stopped"
              : sip.due_date !== null
                ? `Due since ${formatDate(sip.due_date)}${sip.due.length > 1 ? ` (${sip.due.length} months)` : ""}`
                : "Up to date";
            const details = [
              sip.account_name,
              `from ${formatDate(sip.start_date)}`,
              `${sip.instalments} ${sip.instalments === 1 ? "instalment" : "instalments"}`,
            ];
            return (
              <li key={sip.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-32 flex-1">
                  <p className="text-sm font-extrabold [overflow-wrap:anywhere]">
                    {label}
                    <span
                      className={`ml-2 text-xs font-bold ${
                        !sip.active
                          ? "text-zinc-600"
                          : sip.due_date !== null
                            ? "text-orange-700"
                            : "text-zinc-600"
                      }`}
                    >
                      {status}
                    </span>
                  </p>
                  <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{details.join(" · ")}</p>
                </div>
                <div className="flex shrink-0 justify-end gap-1">
                  <button type="button" className={ROW_ACTION} aria-label={`Edit the ${label}`} disabled={busy !== null} onClick={() => onEdit(sip)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className={ROW_ACTION}
                    aria-label={`${sip.active ? "Stop" : "Restart"} the ${label}`}
                    disabled={busy !== null}
                    onClick={() => onActive(sip, !sip.active)}
                  >
                    {busy === sip.id ? "Saving..." : sip.active ? "Stop" : "Restart"}
                  </button>
                  {sip.instalments === 0 && (
                    <button
                      type="button"
                      className={ROW_ACTION}
                      aria-label={`Delete the ${label}`}
                      disabled={busy !== null}
                      onClick={() => onDelete(sip)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Transactions({
  data,
  onAdd,
  onEdit,
  onDelete,
}: {
  data: Data;
  onAdd: () => void;
  onEdit: (trade: FundTrade) => void;
  onDelete: (trade: FundTrade) => void;
}) {
  const locked = archivedIds(data.archived);
  return (
    <section aria-labelledby="fund-trades-title">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 id="fund-trades-title" className="text-xs font-black tracking-wider uppercase">
          Transactions
        </h2>
        {data.trades.length > 0 && (
          <button type="button" className={ROW_ACTION} onClick={onAdd}>
            Add existing units
          </button>
        )}
      </div>
      {data.trades.length === 0 ? (
        <div className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-4 py-6 text-center text-sm font-extrabold text-zinc-700">
          <p>No purchases yet. Start with the units you already own.</p>
          <button type="button" className={`${QUIET} mt-2`} onClick={onAdd}>
            Add existing units
          </button>
        </div>
      ) : (
        <TradesTable caption="Transactions">
          {data.trades.map((trade) => (
            <FundTradeRow
              key={trade.id}
              trade={trade}
              archived={locked.has(trade.account_id)}
              onEdit={() => onEdit(trade)}
              onDelete={() => onDelete(trade)}
            />
          ))}
        </TradesTable>
      )}
    </section>
  );
}

function NavHistory({ navs, trades, onDelete }: { navs: Nav[]; trades: FundTrade[]; onDelete: (nav: Nav) => void }) {
  const sides = new Map(trades.map((t) => [t.id, t.side]));
  return (
    <section aria-labelledby="navs-title">
      <h2 id="navs-title" className={SECTION_TITLE}>
        NAV history
      </h2>
      {navs.length === 0 ? (
        <p className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-4 py-6 text-center text-sm font-extrabold text-zinc-700">
          No NAV yet. Until there is one, your units are valued at what you paid.
        </p>
      ) : (
        <ul className={LIST}>
          {navs.map((nav, index) => (
            <li key={nav.id} className="flex items-center gap-x-4 px-4 py-2">
              <p className="flex-1 text-sm">
                {formatDate(nav.date)}
                {index === 0 && <span className="ml-2 text-xs font-bold text-zinc-600">current</span>}
                {nav.source === "auto" && <AutoBadge />}
                {nav.trade_id !== null && (
                  <span className="ml-2 text-xs font-bold text-zinc-600">
                    {sides.get(nav.trade_id) === "sell" ? "from a redemption" : "from a purchase"}
                  </span>
                )}
              </p>
              <p className="text-sm font-extrabold tabular-nums">{formatNav(nav.nav)}</p>
              <div className="flex w-24 shrink-0 justify-end">
                <button
                  type="button"
                  className={ROW_ACTION}
                  aria-label={`Delete the NAV on ${formatDate(nav.date)}`}
                  onClick={() => onDelete(nav)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
