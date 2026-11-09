"use client";

import Link from "next/link";
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
import type { Portfolio } from "@/lib/investments";
import { formatDate, todayIndia } from "@/lib/transactions";

import { FundDialog } from "./fund-dialog";
import { FundTradeDialog } from "./fund-trade-dialog";
import { NavDialog } from "./nav-dialog";
import {
  ConfirmDelete,
  LIST,
  Notice,
  PRIMARY,
  QUIET,
  ROW_ACTION,
  SECONDARY,
  SECTION_TITLE,
  Signed,
  archivedIds,
  isUnauthorized,
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
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900 dark:bg-amber-950/40"
        >
          <p className="min-w-0 flex-1 text-sm text-amber-950 dark:text-amber-100 [overflow-wrap:anywhere]">{dueText(sip)}</p>
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
  const details = [
    formatDate(trade.date),
    trade.account_name,
    trade.opening ? `avg NAV ${formatNav(trade.nav)}` : `NAV ${formatNav(trade.nav)}`,
    trade.charges !== "0.00" ? `${formatRupees(trade.charges)} ${trade.side === "buy" ? "stamp duty" : "charges"}` : null,
    trade.note,
  ].filter(Boolean);
  const cash = trade.opening ? "Cost" : trade.side === "buy" ? "Paid" : "Received";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-32 flex-1">
        <p className="text-sm font-medium tabular-nums [overflow-wrap:anywhere]">{title}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">{details.join(" · ")}</p>
      </div>
      <div className="min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]">
        <p className="text-sm font-medium">
          <span className="mr-1.5 text-xs font-normal text-zinc-500 dark:text-zinc-400">{cash}</span>
          {formatRupees(trade.amount)}
        </p>
        {trade.realised !== null && (
          <p className="text-xs">
            <span className="text-zinc-500 dark:text-zinc-400">P&amp;L </span>
            <Signed value={trade.realised} />
          </p>
        )}
      </div>
      <div className="flex w-24 shrink-0 justify-end gap-1">
        {archived ? (
          <span className="px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400">Archived</span>
        ) : (
          <>
            <button type="button" className={ROW_ACTION} aria-label={`Edit ${title}, ${trade.date}`} onClick={onEdit}>
              Edit
            </button>
            <button type="button" className={ROW_ACTION} aria-label={`Delete ${title}, ${trade.date}`} onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </div>
    </li>
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
      <Link
        href="/investments"
        className="mb-3 inline-block rounded text-sm text-zinc-600 hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none dark:text-zinc-400"
      >
        ‹ Investments
      </Link>

      {data && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{data.fund.name}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 [overflow-wrap:anywhere]">{data.fund.symbol} · mutual fund</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "rename" })}>
              Rename
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "deleteFund" })}>
              Delete fund
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "nav" })}>
              Update NAV
            </button>
            {holdings.length > 0 && (
              <button type="button" className={SECONDARY} onClick={() => openTrade("sell", holdings.length === 1 ? holdings[0].account_id : null)}>
                Redeem
              </button>
            )}
            <button type="button" className={PRIMARY} onClick={() => openTrade("buy")}>
              Buy
            </button>
          </div>
        </div>
      )}

      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading this fund...
        </p>
      )}

      {load.status === "missing" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <h1 className="font-medium">Fund not found</h1>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">It may have been deleted.</p>
        </div>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load this fund.</p>
          <button
            type="button"
            className={`${QUIET} mt-2 -ml-3`}
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
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Figure label="Current NAV" sub={fund.nav_date ? `as of ${formatDate(fund.nav_date)}` : "No NAV recorded yet"}>
        {fund.nav !== null ? formatNav(fund.nav) : "—"}
      </Figure>
      <Figure label="Units held" sub={total ? `avg NAV ${formatNav(total.average_nav)}` : undefined}>
        {total ? formatUnits(total.units) : "0.000"}
      </Figure>
      <Figure label="Current value" sub={total ? `${formatRupees(total.invested)} invested${total.at_cost ? " · at cost" : ""}` : undefined}>
        {formatRupees(total?.value ?? "0.00")}
      </Figure>
      <Figure label="Unrealised P&L" sub={total ? <Signed value={total.unrealised_percent} percentOnly /> : undefined}>
        <Signed value={total?.unrealised ?? "0.00"} />
      </Figure>
    </dl>
  );
}

function Figure({ label, sub, children }: { label: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <dt className="text-sm text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums [overflow-wrap:anywhere]">{children}</dd>
      {sub ? <dd className="text-sm text-zinc-500 tabular-nums dark:text-zinc-400">{sub}</dd> : null}
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
              <p className="text-sm font-medium [overflow-wrap:anywhere]">{h.account_name}</p>
              <p className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                {formatUnits(h.units)} units · avg NAV {formatNav(h.average_nav)} · {formatRupees(h.invested)} invested
              </p>
            </div>
            <div className="text-right text-sm tabular-nums">
              <p className="font-medium">
                {h.at_cost && <span className="mr-1.5 text-xs font-normal text-zinc-500 dark:text-zinc-400">at cost</span>}
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
        <h2 id="sips-title" className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
          SIPs
        </h2>
        {sips.length > 0 && (
          <button type="button" className={ROW_ACTION} onClick={onAdd}>
            Add SIP
          </button>
        )}
      </div>
      {sips.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
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
                  <p className="text-sm font-medium [overflow-wrap:anywhere]">
                    {label}
                    <span
                      className={`ml-2 text-xs font-normal ${
                        !sip.active
                          ? "text-zinc-500 dark:text-zinc-400"
                          : sip.due_date !== null
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {status}
                    </span>
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">{details.join(" · ")}</p>
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
        <h2 id="fund-trades-title" className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
          Transactions
        </h2>
        {data.trades.length > 0 && (
          <button type="button" className={ROW_ACTION} onClick={onAdd}>
            Add existing units
          </button>
        )}
      </div>
      {data.trades.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          <p>No transactions yet.</p>
          <button type="button" className={`${QUIET} mt-2`} onClick={onAdd}>
            Add existing units
          </button>
        </div>
      ) : (
        <ul className={LIST}>
          {data.trades.map((trade) => (
            <FundTradeRow
              key={trade.id}
              trade={trade}
              archived={locked.has(trade.account_id)}
              onEdit={() => onEdit(trade)}
              onDelete={() => onDelete(trade)}
            />
          ))}
        </ul>
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
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          No NAV recorded. Until you add one, holdings are valued at cost.
        </p>
      ) : (
        <ul className={LIST}>
          {navs.map((nav, index) => (
            <li key={nav.id} className="flex items-center gap-x-4 px-4 py-2">
              <p className="flex-1 text-sm">
                {formatDate(nav.date)}
                {index === 0 && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">current</span>}
                {nav.trade_id !== null && (
                  <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                    {sides.get(nav.trade_id) === "sell" ? "from a redemption" : "from a purchase"}
                  </span>
                )}
              </p>
              <p className="text-sm font-medium tabular-nums">{formatNav(nav.nav)}</p>
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
