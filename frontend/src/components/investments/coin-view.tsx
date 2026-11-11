"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Coin,
  type CoinHolding,
  type CoinPrice,
  type CryptoTrade,
  type CryptoTradeForm,
  type CryptoTradeMode,
  blankCryptoTradeForm,
  formatCoinAverage,
  formatCoinPrice,
  formatCoinQty,
} from "@/lib/crypto";
import type { Portfolio } from "@/lib/investments";
import { formatDate, todayIndia } from "@/lib/transactions";

import { CoinDialog } from "./coin-dialog";
import { CoinPriceDialog } from "./coin-price-dialog";
import { CryptoTradeDialog } from "./crypto-trade-dialog";
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
  GoalTagLink,
} from "./shared";

type Data = {
  coin: Coin;
  coins: Coin[];
  portfolio: Portfolio;
  trades: CryptoTrade[];
  prices: CoinPrice[];
  active: Account[];
  archived: Account[];
};
type Load = { status: "loading" } | { status: "error" } | { status: "missing" } | { status: "ready"; data: Data };
type Dialog =
  | { kind: "none" }
  | { kind: "trade"; trade: CryptoTrade | null; initial: CryptoTradeForm }
  | { kind: "deleteTrade"; trade: CryptoTrade }
  | { kind: "price" }
  | { kind: "deletePrice"; price: CoinPrice }
  | { kind: "rename" }
  | { kind: "deleteCoin" };

async function fetchData(coinId: number): Promise<Data | null> {
  const [coins, portfolio, trades, prices, active, archived] = await Promise.all([
    apiFetch<{ coins: Coin[] }>("/investments/coins"),
    apiFetch<Portfolio>("/investments/portfolio"),
    apiFetch<{ trades: CryptoTrade[] }>(`/investments/crypto-trades?coin_id=${coinId}`),
    apiFetch<{ prices: CoinPrice[] }>(`/investments/coins/${coinId}/prices`),
    apiFetch<AccountList>("/accounts"),
    apiFetch<AccountList>("/accounts?archived=true"),
  ]);
  const coin = coins.coins.find((c) => c.id === coinId);
  if (!coin) return null;
  return {
    coin,
    coins: coins.coins,
    portfolio,
    trades: trades.trades,
    prices: prices.prices,
    active: active.accounts,
    archived: archived.accounts,
  };
}

export function cryptoTradeTitle(trade: CryptoTrade): string {
  const quantity = `${formatCoinQty(trade.quantity)} ${trade.symbol}`;
  if (trade.opening) return `Existing ${quantity}`;
  return `${trade.side === "sell" ? "Sold" : "Bought"} ${quantity}`;
}

function CryptoTradeRow({
  trade,
  archived,
  onEdit,
  onDelete,
}: {
  trade: CryptoTrade;
  archived: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const title = cryptoTradeTitle(trade);
  const details = [
    formatDate(trade.date),
    trade.account_name,
    trade.opening ? `avg ${formatCoinAverage(trade.price)}` : `@ ${formatCoinPrice(trade.price)}`,
    trade.charges !== "0.00" ? `${formatRupees(trade.charges)} charges` : null,
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

export function CoinView({ coinId }: { coinId: number }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  const router = useRouter();

  const reload = useCallback(() => {
    const request = ++latest.current;
    fetchData(coinId)
      .then((data) => {
        if (request === latest.current) setLoad(data ? { status: "ready", data } : { status: "missing" });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request !== latest.current) return;
        else if (err instanceof ApiError && err.status === 404) setLoad({ status: "missing" });
        else setLoad({ status: "error" });
      });
  }, [coinId]);

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
  const holdings = data?.portfolio.crypto.holdings.filter((h) => h.coin_id === coinId) ?? [];

  const openTrade = (mode: CryptoTradeMode, accountId: number | null = null) => {
    const initial = { ...blankCryptoTradeForm(mode, todayIndia()), coin_id: String(coinId) };
    if (accountId !== null) initial.account_id = String(accountId);
    setDialog({ kind: "trade", trade: null, initial });
  };

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
            <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{data.coin.name}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 [overflow-wrap:anywhere]">{data.coin.symbol} · crypto</p>
            <GoalTagLink tag={holdings.find((h) => h.in_goal)?.in_goal} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "rename" })}>
              Rename
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "deleteCoin" })}>
              Delete coin
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
          Loading this coin...
        </p>
      )}

      {load.status === "missing" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <h1 className="font-medium">Coin not found</h1>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">It may have been deleted.</p>
        </div>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load this coin.</p>
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
          <CoinSummary data={data} />
          <AccountHoldings holdings={holdings} onSell={(h) => openTrade("sell", h.account_id)} />
          <Trades
            data={data}
            onAdd={() => openTrade("opening")}
            onEdit={(trade) => setDialog({ kind: "trade", trade, initial: blankCryptoTradeForm("buy", trade.date) })}
            onDelete={(trade) => setDialog({ kind: "deleteTrade", trade })}
          />
          <PriceHistory prices={data.prices} onDelete={(price) => setDialog({ kind: "deletePrice", price })} />
        </div>
      )}

      {dialog.kind === "trade" && data && (
        <CryptoTradeDialog
          key={dialog.trade?.id ?? `new-${dialog.initial.mode}`}
          trade={dialog.trade}
          initial={dialog.initial}
          coins={data.coins}
          brokers={data.active.filter((a) => a.type === "broker")}
          holdings={data.portfolio.crypto.holdings}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
          onCoinCreated={reload}
        />
      )}

      {dialog.kind === "deleteTrade" && (
        <ConfirmDelete
          title={`Delete ${cryptoTradeTitle(dialog.trade)} on ${formatDate(dialog.trade.date)}?`}
          body={
            dialog.trade.opening
              ? "It's removed for good, and the holding shrinks. This can't be undone."
              : `It's removed for good, ${dialog.trade.account_name}'s balance moves back. This can't be undone.`
          }
          path={`/investments/crypto-trades/${dialog.trade.id}`}
          onClose={closeDialog}
          onDone={done}
        />
      )}

      {dialog.kind === "price" && data && (
        <CoinPriceDialog coin={data.coin} onClose={closeDialog} onSaved={() => done(null)} onConflict={done} />
      )}

      {dialog.kind === "deletePrice" && (
        <ConfirmDelete
          title={`Delete the price of ${formatCoinPrice(dialog.price.price)} on ${formatDate(dialog.price.date)}?`}
          body="It's removed for good, and holdings are valued at the price before it (or at cost if there is none). This can't be undone."
          path={`/investments/coin-prices/${dialog.price.id}`}
          onClose={closeDialog}
          onDone={done}
        />
      )}

      {dialog.kind === "rename" && data && <CoinDialog coin={data.coin} onClose={closeDialog} onSaved={() => done(null)} onConflict={done} />}

      {dialog.kind === "deleteCoin" && data && (
        <ConfirmDelete
          title={`Delete ${data.coin.name}?`}
          body="Only a coin with no trades can be deleted. Its prices are deleted with it. This can't be undone."
          path={`/investments/coins/${data.coin.id}`}
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

function CoinSummary({ data }: { data: Data }) {
  const total = data.portfolio.crypto.by_coin.find((c) => c.coin_id === data.coin.id);
  const { coin } = data;
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Figure label="Current price" sub={coin.price_date ? `as of ${formatDate(coin.price_date)}` : "No price recorded yet"}>
        {coin.price !== null ? formatCoinPrice(coin.price) : "—"}
      </Figure>
      <Figure label="Quantity held" sub={total ? `avg ${formatCoinAverage(total.average_price)}` : undefined}>
        {total ? formatCoinQty(total.quantity) : "0"}
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

function AccountHoldings({ holdings, onSell }: { holdings: CoinHolding[]; onSell: (h: CoinHolding) => void }) {
  if (holdings.length === 0) return null;
  return (
    <section aria-labelledby="by-exchange-title">
      <h2 id="by-exchange-title" className={SECTION_TITLE}>
        Held through
      </h2>
      <ul className={LIST}>
        {holdings.map((h) => (
          <li key={h.account_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-32 flex-1">
              <p className="text-sm font-medium [overflow-wrap:anywhere]">{h.account_name}</p>
              <p className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                {formatCoinQty(h.quantity)} {h.symbol} · avg {formatCoinAverage(h.average_price)} · {formatRupees(h.invested)} invested
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
              <button type="button" className={ROW_ACTION} aria-label={`Sell ${h.name} from ${h.account_name}`} onClick={() => onSell(h)}>
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
  onAdd,
  onEdit,
  onDelete,
}: {
  data: Data;
  onAdd: () => void;
  onEdit: (trade: CryptoTrade) => void;
  onDelete: (trade: CryptoTrade) => void;
}) {
  const locked = archivedIds(data.archived);
  return (
    <section aria-labelledby="coin-trades-title">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 id="coin-trades-title" className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
          Trades
        </h2>
        {data.trades.length > 0 && (
          <button type="button" className={ROW_ACTION} onClick={onAdd}>
            Add existing coins
          </button>
        )}
      </div>
      {data.trades.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          <p>No trades yet.</p>
          <button type="button" className={`${QUIET} mt-2`} onClick={onAdd}>
            Add existing coins
          </button>
        </div>
      ) : (
        <ul className={LIST}>
          {data.trades.map((trade) => (
            <CryptoTradeRow
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

function PriceHistory({ prices, onDelete }: { prices: CoinPrice[]; onDelete: (price: CoinPrice) => void }) {
  return (
    <section aria-labelledby="prices-title">
      <h2 id="prices-title" className={SECTION_TITLE}>
        Price history
      </h2>
      {prices.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          No price recorded. Until you add one, holdings are valued at cost.
        </p>
      ) : (
        <ul className={LIST}>
          {prices.map((price, index) => (
            <li key={price.id} className="flex items-center gap-x-4 px-4 py-2">
              <p className="flex-1 text-sm">
                {formatDate(price.date)}
                {index === 0 && <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">current</span>}
              </p>
              <p className="text-sm font-medium tabular-nums">{formatCoinPrice(price.price)}</p>
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
