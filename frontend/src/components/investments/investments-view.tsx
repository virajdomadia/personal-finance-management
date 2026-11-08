"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, formatRupees } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import type { Portfolio, Stock, StockTotal, Trade } from "@/lib/investments";

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
import { TradeDialog, type TradeKind } from "./trade-dialog";

type Data = {
  portfolio: Portfolio;
  stocks: Stock[];
  active: Account[];
  archived: Account[];
  trades: Trade[] | null; // the broker's trades, when viewing one
};
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: Data };
type Dialog =
  | { kind: "none" }
  | { kind: "trade"; trade: Trade | null; tradeKind: TradeKind }
  | { kind: "delete"; trade: Trade };

async function fetchData(brokerId: number | null): Promise<Data> {
  const [portfolio, stocks, active, archived, trades] = await Promise.all([
    apiFetch<Portfolio>("/investments/portfolio"),
    apiFetch<{ stocks: Stock[] }>("/investments/stocks"),
    apiFetch<AccountList>("/accounts"),
    apiFetch<AccountList>("/accounts?archived=true"),
    brokerId === null ? null : apiFetch<{ trades: Trade[] }>(`/investments/trades?account_id=${brokerId}`),
  ]);
  return {
    portfolio,
    stocks: stocks.stocks,
    active: active.accounts,
    archived: archived.accounts,
    trades: trades?.trades ?? null,
  };
}

export function InvestmentsView({ brokerId }: { brokerId: number | null }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const request = ++latest.current;
    fetchData(brokerId)
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, [brokerId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const closeDialog = () => setDialog({ kind: "none" });
  const openTrade = (tradeKind: TradeKind) => setDialog({ kind: "trade", trade: null, tradeKind });
  const data = load.status === "ready" ? load.data : null;
  const brokers = data?.active.filter((a) => a.type === "broker") ?? [];
  const hasHoldings = (data?.portfolio.holdings.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">Investments</h1>
        {data && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => openTrade("opening")}>
              Add existing shares
            </button>
            {hasHoldings && (
              <button type="button" className={SECONDARY} onClick={() => openTrade("sell")}>
                Sell
              </button>
            )}
            <button type="button" className={PRIMARY} onClick={() => openTrade("buy")}>
              Buy
            </button>
          </div>
        )}
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
        <Content
          data={data}
          brokerId={brokerId}
          onAdd={openTrade}
          onEdit={(trade) => setDialog({ kind: "trade", trade, tradeKind: trade.opening ? "opening" : trade.side })}
          onDelete={(trade) => setDialog({ kind: "delete", trade })}
        />
      )}

      {dialog.kind === "trade" && data && (
        <TradeDialog
          key={dialog.trade?.id ?? `new-${dialog.tradeKind}`}
          trade={dialog.trade}
          kind={dialog.tradeKind}
          stocks={data.stocks}
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

function Content({
  data,
  brokerId,
  onAdd,
  onEdit,
  onDelete,
}: {
  data: Data;
  brokerId: number | null;
  onAdd: (kind: TradeKind) => void;
  onEdit: (trade: Trade) => void;
  onDelete: (trade: Trade) => void;
}) {
  const { portfolio } = data;
  const empty = portfolio.by_stock.length === 0 && portfolio.closed.length === 0;

  return (
    <div className="flex flex-col gap-8">
      {brokerId !== null && <BrokerTrades data={data} brokerId={brokerId} onEdit={onEdit} onDelete={onDelete} />}

      {empty ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
          <p className="font-medium">Add your shares</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            Enter shares you already own, or record a buy. Buys and sells move your broker account&apos;s cash.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button type="button" className={SECONDARY} onClick={() => onAdd("opening")}>
              Add existing shares
            </button>
            <button type="button" className={PRIMARY} onClick={() => onAdd("buy")}>
              Buy
            </button>
          </div>
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
    </div>
  );
}

function Summary({ totals }: { totals: Portfolio["totals"] }) {
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
      <h2 id="holdings-title" className={SECTION_TITLE}>
        Holdings
      </h2>
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
  data,
  brokerId,
  onEdit,
  onDelete,
}: {
  data: Data;
  brokerId: number;
  onEdit: (trade: Trade) => void;
  onDelete: (trade: Trade) => void;
}) {
  const broker = [...data.active, ...data.archived].find((a) => a.id === brokerId && a.type === "broker");
  const locked = archivedIds(data.archived);
  const trades = data.trades ?? [];
  return (
    <section aria-labelledby="broker-trades-title">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h2 id="broker-trades-title" className="text-base font-semibold [overflow-wrap:anywhere]">
          {broker ? `Trades in ${broker.name}` : "Broker account not found"}
        </h2>
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
