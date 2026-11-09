"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, formatFullDate, formatRupees } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import {
  type Fund,
  type FundTotal,
  type FundTradeForm,
  type FundTradeMode,
  type Sip,
  blankFundTradeForm,
  formatNav,
  formatUnits,
  sipTradeForm,
} from "@/lib/funds";
import {
  type DepositRow,
  type Part,
  type Portfolio,
  type Stock,
  type StockTotal,
  type Totals,
  type Trade,
  holdingKinds,
  settle,
} from "@/lib/investments";
import { todayIndia } from "@/lib/transactions";

import {
  ConfirmDelete,
  LIST,
  Notice,
  PRIMARY,
  QUIET,
  SECONDARY,
  SECTION_TITLE,
  Signed,
  TradeRow,
  archivedIds,
  isUnauthorized,
  tradeDeleteText,
} from "./shared";
import { FundTradeDialog } from "./fund-trade-dialog";
import { DueSips } from "./fund-view";
import { SipDialog } from "./sip-dialog";
import { TradeDialog, type TradeKind } from "./trade-dialog";

// The portfolio is what the page can't do without. Everything else loads and fails on its own, so a
// failing fund request leaves Stocks and Deposits showing.
type Data = {
  portfolio: Portfolio;
  stocks: Part<{ stocks: Stock[]; trades: Trade[] | null }>; // trades: the broker's, when viewing one
  funds: Part<{ funds: Fund[]; sips: Sip[] }>;
  accounts: Part<{ active: Account[]; archived: Account[] }>;
};
type StocksExtra = { stocks: Stock[]; trades: Trade[] | null; active: Account[]; archived: Account[] };
type FundsExtra = { funds: Fund[]; sips: Sip[] };
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: Data };
type Dialog =
  | { kind: "none" }
  | { kind: "trade"; trade: Trade | null; tradeKind: TradeKind }
  | { kind: "delete"; trade: Trade }
  | { kind: "fundTrade"; initial: FundTradeForm; focusNav: boolean }
  | { kind: "sip" };

async function fetchData(brokerId: number | null): Promise<Data> {
  const [portfolio, stocks, funds, accounts] = await Promise.all([
    apiFetch<Portfolio>("/investments/portfolio"),
    settle(
      Promise.all([
        apiFetch<{ stocks: Stock[] }>("/investments/stocks"),
        brokerId === null ? null : apiFetch<{ trades: Trade[] }>(`/investments/trades?account_id=${brokerId}`),
      ]).then(([list, trades]) => ({ stocks: list.stocks, trades: trades?.trades ?? null })),
      isUnauthorized,
    ),
    settle(
      Promise.all([apiFetch<{ funds: Fund[] }>("/investments/funds"), apiFetch<{ sips: Sip[] }>("/investments/sips")]).then(
        ([f, s]) => ({ funds: f.funds, sips: s.sips }),
      ),
      isUnauthorized,
    ),
    settle(
      Promise.all([apiFetch<AccountList>("/accounts"), apiFetch<AccountList>("/accounts?archived=true")]).then(([a, b]) => ({
        active: a.accounts,
        archived: b.accounts,
      })),
      isUnauthorized,
    ),
  ]);
  return { portfolio, stocks, funds, accounts };
}

export function InvestmentsView({ brokerId }: { brokerId: number | null }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const request = ++latest.current;
    fetchData(brokerId)
      .then((data) => {
        if (request === latest.current) {
          setLoad({ status: "ready", data });
          setRetrying(false);
        }
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) {
          setLoad({ status: "error" });
          setRetrying(false);
        }
      });
  }, [brokerId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // A section's "Try again" reloads everything; it shows that it is working until the data lands.
  const retry = () => {
    setRetrying(true);
    reload();
  };
  const closeDialog = () => setDialog({ kind: "none" });
  const openTrade = (tradeKind: TradeKind) => setDialog({ kind: "trade", trade: null, tradeKind });
  const data = load.status === "ready" ? load.data : null;
  const accounts = data?.accounts.status === "ready" ? data.accounts.data : null;
  const stocksExtra: StocksExtra | null = data && accounts && data.stocks.status === "ready" ? { ...data.stocks.data, ...accounts } : null;
  const fundsData: FundsExtra | null = data?.funds.status === "ready" ? data.funds.data : null;
  const fundsExtra: FundsExtra | null = accounts ? fundsData : null;
  const accountsFailed = data?.accounts.status === "error";
  const brokers = accounts?.active.filter((a) => a.type === "broker") ?? [];
  const banks = accounts?.active.filter((a) => a.type === "bank") ?? [];
  const openFundTrade = (mode: FundTradeMode) =>
    setDialog({ kind: "fundTrade", initial: blankFundTradeForm(mode, todayIndia()), focusNav: false });
  const recordSip = (sip: Sip) =>
    setDialog({ kind: "fundTrade", initial: sipTradeForm(sip, sip.due_date ?? todayIndia()), focusNav: true });
  const done = (message: string | null) => {
    setNotice(message);
    closeDialog();
    reload();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Investments</h1>
        {data && <Overall portfolio={data.portfolio} />}
      </div>

      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading your investments...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load your investments.</p>
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
        <div className="flex flex-col gap-10">
          {fundsExtra && <DueSips sips={data.portfolio.funds.due_sips} onRecord={recordSip} />}
          <Content
            portfolio={data.portfolio}
            stocksLoaded={data.stocks.status === "ready"}
            extra={stocksExtra}
            accountsFailed={accountsFailed}
            retrying={retrying}
            onRetry={retry}
            brokerId={brokerId}
            onAdd={openTrade}
            onEdit={(trade) => setDialog({ kind: "trade", trade, tradeKind: trade.opening ? "opening" : trade.side })}
            onDelete={(trade) => setDialog({ kind: "delete", trade })}
          />
          <Funds
            portfolio={data.portfolio}
            funds={fundsData}
            canAdd={accounts !== null}
            accountsFailed={accountsFailed}
            retrying={retrying}
            onRetry={retry}
            onAdd={openFundTrade}
            onAddSip={() => setDialog({ kind: "sip" })}
          />
          <DepositsSection deposits={data.portfolio.deposits} />
        </div>
      )}

      {dialog.kind === "fundTrade" && data && fundsExtra && (
        <FundTradeDialog
          trade={null}
          initial={dialog.initial}
          funds={fundsExtra.funds}
          banks={banks}
          holdings={data.portfolio.funds.holdings}
          sips={fundsExtra.sips}
          focusNav={dialog.focusNav}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
          onFundCreated={reload}
        />
      )}

      {dialog.kind === "sip" && fundsExtra && (
        <SipDialog
          sip={null}
          funds={fundsExtra.funds}
          banks={banks}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
          onFundCreated={reload}
        />
      )}

      {dialog.kind === "trade" && stocksExtra && data && (
        <TradeDialog
          key={dialog.trade?.id ?? `new-${dialog.tradeKind}`}
          trade={dialog.trade}
          kind={dialog.tradeKind}
          stocks={stocksExtra.stocks}
          brokers={brokers}
          holdings={data.portfolio.holdings}
          defaultAccountId={brokerId}
          onClose={closeDialog}
          onSaved={() => {
            setNotice(null);
            closeDialog();
            reload();
          }}
          onConflict={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
          onStockCreated={reload}
        />
      )}

      {dialog.kind === "delete" && (
        <ConfirmDelete
          {...tradeDeleteText(dialog.trade)}
          path={`/investments/trades/${dialog.trade.id}`}
          onClose={closeDialog}
          onDone={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}
    </div>
  );
}

function SectionError({ onRetry, what, retrying }: { onRetry: () => void; what: string; retrying: boolean }) {
  return (
    <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <p>We couldn&apos;t load your {what}.</p>
      <button type="button" className={`${QUIET} mt-2 -ml-3`} disabled={retrying} onClick={onRetry}>
        {retrying ? "Trying again..." : "Try again"}
      </button>
    </div>
  );
}

// Shown where the buttons and dialogs would be when the accounts they need didn't load.
function NeedsAccounts({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      Adding is unavailable until your accounts load.{" "}
      <button type="button" className={`${QUIET} -mx-1 inline`} disabled={retrying} onClick={onRetry}>
        {retrying ? "Trying again..." : "Try again"}
      </button>
    </p>
  );
}

function Content({
  portfolio,
  stocksLoaded,
  extra,
  accountsFailed,
  retrying,
  onRetry,
  brokerId,
  onAdd,
  onEdit,
  onDelete,
}: {
  portfolio: Portfolio;
  stocksLoaded: boolean;
  extra: StocksExtra | null;
  accountsFailed: boolean;
  retrying: boolean;
  onRetry: () => void;
  brokerId: number | null;
  onAdd: (kind: TradeKind) => void;
  onEdit: (trade: Trade) => void;
  onDelete: (trade: Trade) => void;
}) {
  const empty = portfolio.by_stock.length === 0 && portfolio.closed.length === 0;
  const hasHoldings = portfolio.holdings.length > 0;

  return (
    <section aria-labelledby="stocks-title" className="flex flex-col gap-8">
      <div className="-mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="stocks-title" className="text-base font-semibold">
          Stocks
        </h2>
        {extra && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => onAdd("opening")}>
              Add existing shares
            </button>
            {hasHoldings && (
              <button type="button" className={SECONDARY} onClick={() => onAdd("sell")}>
                Sell
              </button>
            )}
            <button type="button" className={PRIMARY} onClick={() => onAdd("buy")}>
              Buy
            </button>
          </div>
        )}
      </div>

      {accountsFailed && stocksLoaded && <NeedsAccounts retrying={retrying} onRetry={onRetry} />}

      {extra && brokerId !== null && <BrokerTrades extra={extra} brokerId={brokerId} onEdit={onEdit} onDelete={onDelete} />}

      {!stocksLoaded ? (
        <SectionError onRetry={onRetry} what="stocks" retrying={retrying} />
      ) : empty ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
          <p className="font-medium">Add your shares</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            Enter shares you already own, or record a buy. Buys and sells move your broker account&apos;s cash.
          </p>
          {extra && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button type="button" className={SECONDARY} onClick={() => onAdd("opening")}>
                Add existing shares
              </button>
              <button type="button" className={PRIMARY} onClick={() => onAdd("buy")}>
                Buy
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <Summary totals={portfolio.totals} />
          <Holdings rows={portfolio.by_stock} />
          {portfolio.closed.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer rounded px-1 py-1 text-xs font-medium tracking-wide text-zinc-500 uppercase hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none dark:text-zinc-400 dark:hover:text-zinc-100">
                Sold ({portfolio.closed.length})
              </summary>
              <ul className={`${LIST} mt-1`}>
                {portfolio.closed.map((c) => (
                  <li key={`${c.stock_id}-${c.account_id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-32 flex-1">
                      <Link
                        href={`/investments/${c.stock_id}`}
                        className="text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none"
                      >
                        {c.symbol}
                      </Link>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">
                        {c.name} · {c.account_name}
                      </p>
                    </div>
                    <p className="text-right text-sm">
                      <span className="mr-1.5 text-xs text-zinc-500 dark:text-zinc-400">Realised</span>
                      <Signed value={c.realised} />
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function Summary({ totals }: { totals: Totals }) {
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Figure label="Invested">{formatRupees(totals.invested)}</Figure>
      <Figure label="Current value">{formatRupees(totals.value)}</Figure>
      <Figure label="Unrealised P&L" sub={<Signed value={totals.unrealised_percent} percentOnly />}>
        <Signed value={totals.unrealised} />
      </Figure>
      <Figure label="Realised P&L">
        <Signed value={totals.realised} />
      </Figure>
    </dl>
  );
}

function Figure({ label, sub, children }: { label: string; sub?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <dt className="text-sm text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums [overflow-wrap:anywhere]">{children}</dd>
      {sub ? <dd className="text-sm tabular-nums">{sub}</dd> : null}
    </div>
  );
}

const TH = "px-4 py-2 text-xs font-medium text-zinc-500 dark:text-zinc-400";

function Holdings({ rows }: { rows: StockTotal[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="holdings-title">
      <h3 id="holdings-title" className={SECTION_TITLE}>
        Holdings
      </h3>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th scope="col" className={`${TH} text-left`}>Stock</th>
              <th scope="col" className={`${TH} text-right`}>Shares</th>
              <th scope="col" className={`${TH} text-right`}>Avg cost</th>
              <th scope="col" className={`${TH} text-right`}>Invested</th>
              <th scope="col" className={`${TH} text-right`}>Current value</th>
              <th scope="col" className={`${TH} text-right`}>Unrealised P&amp;L</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((row) => (
              <tr key={row.stock_id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <Link
                    href={`/investments/${row.stock_id}`}
                    className="font-medium hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none"
                  >
                    {row.symbol}
                  </Link>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">{row.name}</p>
                </th>
                <td className="px-4 py-3 text-right tabular-nums">{row.shares}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatRupees(row.average_cost)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatRupees(row.invested)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatRupees(row.value)}
                  {row.at_cost ? (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">at cost</p>
                  ) : row.price !== null ? (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">@ {formatRupees(row.price)}</p>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <Signed value={row.unrealised} />
                  <p className="text-xs">
                    <Signed value={row.unrealised_percent} percentOnly />
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BrokerTrades({
  extra,
  brokerId,
  onEdit,
  onDelete,
}: {
  extra: StocksExtra;
  brokerId: number;
  onEdit: (trade: Trade) => void;
  onDelete: (trade: Trade) => void;
}) {
  const broker = [...extra.active, ...extra.archived].find((a) => a.id === brokerId && a.type === "broker");
  const locked = archivedIds(extra.archived);
  const trades = extra.trades ?? [];
  return (
    <section aria-labelledby="broker-trades-title">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h3 id="broker-trades-title" className="text-base font-semibold [overflow-wrap:anywhere]">
          {broker ? `Trades in ${broker.name}` : "Broker account not found"}
        </h3>
        <Link
          href="/investments"
          className="rounded text-sm text-zinc-600 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none dark:text-zinc-400"
        >
          Show all investments
        </Link>
      </div>
      {broker && trades.length > 0 ? (
        <ul className={LIST}>
          {trades.map((trade) => (
            <TradeRow
              key={trade.id}
              trade={trade}
              archived={locked.has(trade.account_id)}
              showAccount={false}
              onEdit={() => onEdit(trade)}
              onDelete={() => onDelete(trade)}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          {broker ? `No trades in ${broker.name} yet.` : "This broker account doesn't exist, or isn't yours."}
        </p>
      )}
    </section>
  );
}

// Stocks, funds and deposits together, when there are two or more to add up.
function Overall({ portfolio }: { portfolio: Portfolio }) {
  const { overall } = portfolio;
  if (holdingKinds(portfolio) < 2) return null;
  return (
    <p className="mt-1 text-sm text-zinc-600 tabular-nums dark:text-zinc-400">
      All investments <span className="font-semibold text-zinc-900 dark:text-zinc-100">{formatRupees(overall.value)}</span>
      {" · "}
      {formatRupees(overall.invested)} invested
      {" · unrealised "}
      <Signed value={overall.unrealised} /> (<Signed value={overall.unrealised_percent} percentOnly />)
      {" · realised "}
      <Signed value={overall.realised} />
    </p>
  );
}

function Funds({
  portfolio,
  funds: fundsData,
  canAdd,
  accountsFailed,
  retrying,
  onRetry,
  onAdd,
  onAddSip,
}: {
  portfolio: Portfolio;
  funds: FundsExtra | null;
  canAdd: boolean;
  accountsFailed: boolean;
  retrying: boolean;
  onRetry: () => void;
  onAdd: (mode: FundTradeMode) => void;
  onAddSip: () => void;
}) {
  const funds = portfolio.funds;
  const empty = funds.by_fund.length === 0 && funds.closed.length === 0;
  const hasHoldings = funds.holdings.length > 0;
  // A fund with no units and no past (one just added with its SIP) still gets a row to reach it by.
  const listed = new Set([...funds.by_fund.map((f) => f.fund_id), ...funds.closed.map((c) => c.fund_id)]);
  const unheld = (fundsData?.funds ?? []).filter((f) => !listed.has(f.id));

  return (
    <section aria-labelledby="funds-title" className="flex flex-col gap-8">
      <div className="-mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="funds-title" className="text-base font-semibold">
          Mutual funds
        </h2>
        {fundsData && canAdd && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={onAddSip}>
              Add SIP
            </button>
            <button type="button" className={QUIET} onClick={() => onAdd("opening")}>
              Add existing units
            </button>
            {hasHoldings && (
              <button type="button" className={SECONDARY} onClick={() => onAdd("sell")}>
                Redeem
              </button>
            )}
            <button type="button" className={PRIMARY} onClick={() => onAdd("buy")}>
              Buy
            </button>
          </div>
        )}
      </div>

      {accountsFailed && fundsData && <NeedsAccounts retrying={retrying} onRetry={onRetry} />}

      {!fundsData ? (
        <SectionError onRetry={onRetry} what="mutual funds" retrying={retrying} />
      ) : empty && unheld.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
          <p className="font-medium">Add your mutual funds</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            Enter units you already own, or add a SIP and record each instalment with its NAV. Purchases and redemptions move your
            bank balance.
          </p>
          {canAdd && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button type="button" className={SECONDARY} onClick={() => onAdd("opening")}>
                Add existing units
              </button>
              <button type="button" className={SECONDARY} onClick={onAddSip}>
                Add SIP
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {!empty && <Summary totals={funds.totals} />}
          <FundRows rows={funds.by_fund} />
          {unheld.length > 0 && (
            <div>
              <h3 className={SECTION_TITLE}>No units yet</h3>
              <ul className={LIST}>
                {unheld.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                    <Link
                      href={`/investments/funds/${f.id}`}
                      className="text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none [overflow-wrap:anywhere]"
                    >
                      {f.name}
                    </Link>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{f.symbol}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {funds.closed.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer rounded px-1 py-1 text-xs font-medium tracking-wide text-zinc-500 uppercase hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none dark:text-zinc-400 dark:hover:text-zinc-100">
                Redeemed ({funds.closed.length})
              </summary>
              <ul className={`${LIST} mt-1`}>
                {funds.closed.map((c) => (
                  <li key={`${c.fund_id}-${c.account_id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-32 flex-1">
                      <Link
                        href={`/investments/funds/${c.fund_id}`}
                        className="text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none [overflow-wrap:anywhere]"
                      >
                        {c.name}
                      </Link>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">
                        {c.symbol} · {c.account_name}
                      </p>
                    </div>
                    <p className="text-right text-sm">
                      <span className="mr-1.5 text-xs text-zinc-500 dark:text-zinc-400">Realised</span>
                      <Signed value={c.realised} />
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function FundRows({ rows }: { rows: FundTotal[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 id="fund-holdings-title" className={SECTION_TITLE}>
        Holdings
      </h3>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table aria-labelledby="fund-holdings-title" className="w-full min-w-[40rem] text-sm">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th scope="col" className={`${TH} text-left`}>Fund</th>
              <th scope="col" className={`${TH} text-right`}>Units</th>
              <th scope="col" className={`${TH} text-right`}>Avg NAV</th>
              <th scope="col" className={`${TH} text-right`}>Invested</th>
              <th scope="col" className={`${TH} text-right`}>Current value</th>
              <th scope="col" className={`${TH} text-right`}>Unrealised P&amp;L</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((row) => (
              <tr key={row.fund_id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <Link
                    href={`/investments/funds/${row.fund_id}`}
                    className="font-medium hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none [overflow-wrap:anywhere]"
                  >
                    {row.name}
                  </Link>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{row.symbol}</p>
                </th>
                <td className="px-4 py-3 text-right tabular-nums">{formatUnits(row.units)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatNav(row.average_nav)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatRupees(row.invested)}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatRupees(row.value)}
                  {row.at_cost ? (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">at cost</p>
                  ) : row.nav !== null ? (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">@ {formatNav(row.nav)}</p>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right">
                  <Signed value={row.unrealised} />
                  <p className="text-xs">
                    <Signed value={row.unrealised_percent} percentOnly />
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DepositsSection({ deposits }: { deposits: Portfolio["deposits"] }) {
  if (deposits.accounts.length === 0) return null;
  return (
    <section aria-labelledby="deposits-title" className="flex flex-col gap-4">
      <div>
        <h2 id="deposits-title" className="text-base font-semibold">
          Deposits
        </h2>
        <p className="mt-1 text-sm text-zinc-600 tabular-nums dark:text-zinc-400">
          <span className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{formatRupees(deposits.value)}</span>
          {" · ≈ "}
          {formatRupees(deposits.interest_estimate)} interest (estimate)
        </p>
      </div>
      <ul className={LIST}>
        {deposits.accounts.map((row) => (
          <DepositItem key={row.account_id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function DepositItem({ row }: { row: DepositRow }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <div className="min-w-32 flex-1">
        <Link
          href="/accounts"
          className="text-sm font-medium hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none [overflow-wrap:anywhere]"
        >
          {row.name}
        </Link>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {row.type === "ppf" ? "PPF" : "RD"} · Matures {formatFullDate(row.maturity_date)}
        </p>
      </div>
      <p className="text-right text-sm tabular-nums">
        {formatRupees(row.balance)}
        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
          ≈ {formatRupees(row.interest_estimate)} interest (estimate)
        </span>
      </p>
    </li>
  );
}
