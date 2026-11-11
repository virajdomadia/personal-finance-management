"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { Holding, Portfolio, Price, Stock, Trade } from "@/lib/investments";
import { formatDate } from "@/lib/transactions";
import { Select } from "@/components/ui/select";

import { PriceDialog } from "./price-dialog";
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
  TradeRow,
  archivedIds,
  isUnauthorized,
  tradeDeleteText,
  GoalTagLink,
} from "./shared";
import { StockDialog } from "./stock-dialog";
import { TradeDialog, type TradeKind } from "./trade-dialog";

type Data = {
  stock: Stock;
  stocks: Stock[];
  portfolio: Portfolio;
  trades: Trade[];
  prices: Price[];
  active: Account[];
  archived: Account[];
};
type Load = { status: "loading" } | { status: "error" } | { status: "missing" } | { status: "ready"; data: Data };
type Dialog =
  | { kind: "none" }
  | { kind: "trade"; trade: Trade | null; tradeKind: TradeKind; accountId: number | null }
  | { kind: "deleteTrade"; trade: Trade }
  | { kind: "price" }
  | { kind: "deletePrice"; price: Price }
  | { kind: "rename" }
  | { kind: "deleteStock" };

async function fetchData(stockId: number): Promise<Data | null> {
  const [stocks, portfolio, trades, prices, active, archived] = await Promise.all([
    apiFetch<{ stocks: Stock[] }>("/investments/stocks"),
    apiFetch<Portfolio>("/investments/portfolio"),
    apiFetch<{ trades: Trade[] }>(`/investments/trades?stock_id=${stockId}`),
    apiFetch<{ prices: Price[] }>(`/investments/stocks/${stockId}/prices`),
    apiFetch<AccountList>("/accounts"),
    apiFetch<AccountList>("/accounts?archived=true"),
  ]);
  const stock = stocks.stocks.find((s) => s.id === stockId);
  if (!stock) return null;
  return {
    stock,
    stocks: stocks.stocks,
    portfolio,
    trades: trades.trades,
    prices: prices.prices,
    active: active.accounts,
    archived: archived.accounts,
  };
}

export function StockView({ stockId }: { stockId: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [brokerFilter, setBrokerFilter] = useState("");
  const latest = useRef(0);
  const router = useRouter();

  const reload = useCallback(() => {
    const request = ++latest.current;
    fetchData(stockId)
      .then((data) => {
        if (request === latest.current) setLoad(data ? { status: "ready", data } : { status: "missing" });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request !== latest.current) return;
        else if (err instanceof ApiError && err.status === 404) setLoad({ status: "missing" });
        else setLoad({ status: "error" });
      });
  }, [stockId]);

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
  const holdings = data?.portfolio.holdings.filter((h) => h.stock_id === stockId) ?? [];
  const openTrade = (tradeKind: TradeKind, accountId: number | null = null) =>
    setDialog({ kind: "trade", trade: null, tradeKind, accountId });

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
            <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{data.stock.symbol}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 [overflow-wrap:anywhere]">{data.stock.name}</p>
            <GoalTagLink tag={holdings.find((h) => h.in_goal)?.in_goal} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "rename" })}>
              Rename
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "deleteStock" })}>
              Delete stock
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "price" })}>
              Update price
            </button>
            {holdings.length > 0 && (
              <button type="button" className={SECONDARY} onClick={() => openTrade("sell", holdings.length === 1 ? holdings[0].account_id : null)}>
                Sell
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
          Loading this stock...
        </p>
      )}

      {load.status === "missing" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <h1 className="font-medium">Stock not found</h1>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">It may have been deleted.</p>
        </div>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load this stock.</p>
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
          <StockSummary data={data} />
          <BrokerHoldings holdings={holdings} onSell={(h) => openTrade("sell", h.account_id)} />
          <Trades
            data={data}
            filter={brokerFilter}
            onFilter={setBrokerFilter}
            onAdd={() => openTrade("opening")}
            onEdit={(trade) => setDialog({ kind: "trade", trade, tradeKind: trade.opening ? "opening" : trade.side, accountId: null })}
            onDelete={(trade) => setDialog({ kind: "deleteTrade", trade })}
          />
          <PriceHistory prices={data.prices} onDelete={(price) => setDialog({ kind: "deletePrice", price })} />
        </div>
      )}

      {dialog.kind === "trade" && data && (
        <TradeDialog
          key={dialog.trade?.id ?? `new-${dialog.tradeKind}`}
          trade={dialog.trade}
          kind={dialog.tradeKind}
          stocks={data.stocks}
          brokers={data.active.filter((a) => a.type === "broker")}
          holdings={data.portfolio.holdings}
          defaultStockId={stockId}
          defaultAccountId={dialog.accountId}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
          onStockCreated={reload}
        />
      )}

      {dialog.kind === "deleteTrade" && (
        <ConfirmDelete {...tradeDeleteText(dialog.trade)} path={`/investments/trades/${dialog.trade.id}`} onClose={closeDialog} onDone={done} />
      )}

      {dialog.kind === "price" && data && (
        <PriceDialog stock={data.stock} onClose={closeDialog} onSaved={() => done(null)} onConflict={done} />
      )}

      {dialog.kind === "rename" && data && (
        <StockDialog stock={data.stock} onClose={closeDialog} onSaved={() => done(null)} onConflict={done} />
      )}

      {dialog.kind === "deleteStock" && data && (
        <ConfirmDelete
          title={`Delete ${data.stock.symbol}?`}
          body="Only a stock with no trades and no prices can be deleted. This can't be undone."
          path={`/investments/stocks/${data.stock.id}`}
          onClose={closeDialog}
          onDone={(message) => {
            if (message === null) router.push("/investments");
            else done(message);
          }}
        />
      )}

      {dialog.kind === "deletePrice" && (
        <ConfirmDelete
          title={`Delete the price of ${formatRupees(dialog.price.price)} on ${formatDate(dialog.price.date)}?`}
          body="It's removed for good, and holdings are valued at the price before it (or at cost if there is none). This can't be undone."
          path={`/investments/prices/${dialog.price.id}`}
          onClose={closeDialog}
          onDone={done}
        />
      )}
    </div>
  );
}

function StockSummary({ data }: { data: Data }) {
  const total = data.portfolio.by_stock.find((s) => s.stock_id === data.stock.id);
  const { stock } = data;
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Figure label="Current price" sub={stock.price_date ? `as of ${formatDate(stock.price_date)}` : "No price recorded yet"}>
        {stock.price !== null ? formatRupees(stock.price) : "—"}
      </Figure>
      <Figure label="Shares held" sub={total ? `avg cost ${formatRupees(total.average_cost)}` : undefined}>
        {total ? total.shares : 0}
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

function BrokerHoldings({ holdings, onSell }: { holdings: Holding[]; onSell: (h: Holding) => void }) {
  if (holdings.length === 0) return null;
  return (
    <section aria-labelledby="by-broker-title">
      <h2 id="by-broker-title" className={SECTION_TITLE}>
        Held in
      </h2>
      <ul className={LIST}>
        {holdings.map((h) => (
          <li key={h.account_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-32 flex-1">
              <p className="text-sm font-medium [overflow-wrap:anywhere]">{h.account_name}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {h.shares} shares · avg cost {formatRupees(h.average_cost)} · {formatRupees(h.invested)} invested
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
              <button type="button" className={ROW_ACTION} aria-label={`Sell ${h.symbol} from ${h.account_name}`} onClick={() => onSell(h)}>
                Sell
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Trades({
  data,
  filter,
  onFilter,
  onAdd,
  onEdit,
  onDelete,
}: {
  data: Data;
  filter: string;
  onFilter: (value: string) => void;
  onAdd: () => void;
  onEdit: (trade: Trade) => void;
  onDelete: (trade: Trade) => void;
}) {
  const locked = archivedIds(data.archived);
  // The brokers this stock was traded in, in the order they first appear.
  const brokers = [...new Map(data.trades.map((t) => [t.account_id, t.account_name])).entries()];
  // A filter on a broker with no trades left here (its last one deleted or moved) falls back to all,
  // since the picker that could clear it may no longer be shown.
  const effective = brokers.some(([id]) => String(id) === filter) ? filter : "";
  const filterName = brokers.find(([id]) => String(id) === effective)?.[1];
  const shown = effective === "" ? data.trades : data.trades.filter((t) => String(t.account_id) === effective);
  return (
    <section aria-labelledby="trades-title">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 id="trades-title" className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
          Trades
        </h2>
        {brokers.length > 1 && (
          <Select
            ariaLabel="Filter trades by broker"
            className="w-48"
            value={effective}
            options={[{ value: "", label: "All brokers" }, ...brokers.map(([id, name]) => ({ value: String(id), label: name }))]}
            onChange={onFilter}
          />
        )}
      </div>
      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          <p>{filterName ? `No trades in ${filterName} yet.` : "No trades yet."}</p>
          <button type="button" className={`${QUIET} mt-2`} onClick={onAdd}>
            Add existing shares
          </button>
        </div>
      ) : (
        <ul className={LIST}>
          {shown.map((trade) => (
            <TradeRow
              key={trade.id}
              trade={trade}
              archived={locked.has(trade.account_id)}
              showAccount
              onEdit={() => onEdit(trade)}
              onDelete={() => onDelete(trade)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PriceHistory({ prices, onDelete }: { prices: Price[]; onDelete: (price: Price) => void }) {
  return (
    <section aria-labelledby="prices-title">
      <h2 id="prices-title" className={SECTION_TITLE}>
        Price history
      </h2>
      {prices.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          No prices recorded. Until you add one, holdings are valued at cost.
        </p>
      ) : (
        <ul className={LIST}>
          {prices.map((price, index) => (
            <li key={price.id} className="flex items-center gap-x-4 px-4 py-2">
              <p className="flex-1 text-sm">
                {formatDate(price.date)}
                {index === 0 && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">current</span>}
              </p>
              <p className="text-sm font-medium tabular-nums">{formatRupees(price.price)}</p>
              <div className="flex w-24 shrink-0 justify-end">
                <button
                  type="button"
                  className={ROW_ACTION}
                  aria-label={`Delete the price on ${formatDate(price.date)}`}
                  onClick={() => onDelete(price)}
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
