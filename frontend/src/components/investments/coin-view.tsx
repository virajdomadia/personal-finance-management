"use client";

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
import { type Portfolio, linkLabel } from "@/lib/investments";
import { formatDate, todayIndia } from "@/lib/transactions";

import { CoinDialog } from "./coin-dialog";
import { LinkDialog } from "./link-dialog";
import { CoinPriceDialog } from "./coin-price-dialog";
import { CryptoTradeDialog } from "./crypto-trade-dialog";
import { Tile } from "@/components/ui/chunky";
import { investmentSticker } from "@/lib/fun";
import {
  ConfirmDelete,
  LIST,
  Notice,
  QUIET,
  ROW_ACTION,
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
  CoinGeckoCredit,
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
  | { kind: "link" }
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
  const cash = trade.opening ? "Cost" : trade.side === "buy" ? "Paid" : "Received";
  return (
    <TradeTr
      title={title}
      date={trade.date}
      details={[
        trade.account_name,
        trade.opening ? `avg ${formatCoinAverage(trade.price)}` : `@ ${formatCoinPrice(trade.price)}`,
        trade.charges !== "0.00" ? `${formatRupees(trade.charges)} charges` : null,
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
      <BackLink />

      {data && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-black [overflow-wrap:anywhere]"><span aria-hidden="true">🪙 </span>{data.coin.name}</h1>
            <p className="text-sm font-bold text-zinc-700 [overflow-wrap:anywhere]">{data.coin.symbol} · crypto</p>
            <GoalTagLink tag={holdings.find((h) => h.in_goal)?.in_goal} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "rename" })}>
              Rename
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "link" })}>
              {linkLabel(data.coin.source_code)}
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "deleteCoin" })}>
              Delete coin
            </button>
            <button type="button" className={QUIET} onClick={() => setDialog({ kind: "price" })}>
              Update price
            </button>
            {holdings.length > 0 && (
              <button type="button" className={SELL} onClick={() => openTrade("sell", holdings.length === 1 ? holdings[0].account_id : null)}>
                Sell
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
          Loading this coin...
        </p>
      )}

      {load.status === "missing" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <h1 className="font-extrabold">Coin not found</h1>
          <p className="mt-1 font-bold text-zinc-600">It may have been deleted.</p>
        </div>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <p>We couldn&apos;t load this coin.</p>
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

      {dialog.kind === "link" && data && (
        <LinkDialog
          kind="crypto"
          path={`/investments/coins/${data.coin.id}`}
          title={`${data.coin.name}: live prices`}
          linkedCode={data.coin.source_code}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
        />
      )}

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
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <Tile
            tone="blue"
            size="huge"
            emoji="🪙"
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
        <Tile label="Quantity held" value={total ? formatCoinQty(total.quantity) : "0"}>
          {total ? <span className="mt-0.5 block text-xs font-bold text-zinc-600">avg {formatCoinAverage(total.average_price)}</span> : null}
        </Tile>
      </div>
      <PriceCard
        label="Current price"
        value={coin.price !== null ? formatCoinPrice(coin.price) : "—"}
        sub={coin.price_date ? `as of ${formatDate(coin.price_date)}` : "No price recorded yet"}
        points={data.prices.map((p) => ({ date: p.date, value: Number(p.price) }))}
        lineLabel="Price history"
      />
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
              <p className="text-sm font-extrabold [overflow-wrap:anywhere]">{h.account_name}</p>
              <p className="text-xs font-bold text-zinc-600 tabular-nums">
                {formatCoinQty(h.quantity)} {h.symbol} · avg {formatCoinAverage(h.average_price)} · {formatRupees(h.invested)} invested
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
        <h2 id="coin-trades-title" className="text-xs font-black tracking-wider uppercase">
          Trades
        </h2>
        {data.trades.length > 0 && (
          <button type="button" className={ROW_ACTION} onClick={onAdd}>
            Add existing coins
          </button>
        )}
      </div>
      {data.trades.length === 0 ? (
        <div className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-4 py-6 text-center text-sm font-extrabold text-zinc-700">
          <p>No buys or sells yet. Start with the coins you already own.</p>
          <button type="button" className={`${QUIET} mt-2`} onClick={onAdd}>
            Add existing coins
          </button>
        </div>
      ) : (
        <TradesTable caption="Trades">
          {data.trades.map((trade) => (
            <CryptoTradeRow
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

function PriceHistory({ prices, onDelete }: { prices: CoinPrice[]; onDelete: (price: CoinPrice) => void }) {
  return (
    <section aria-labelledby="prices-title">
      <h2 id="prices-title" className={SECTION_TITLE}>
        Price history
      </h2>
      {prices.length === 0 ? (
        <p className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-4 py-6 text-center text-sm font-extrabold text-zinc-700">
          No price yet. Until there is one, your coins are valued at what you paid.
        </p>
      ) : (
        <ul className={LIST}>
          {prices.map((price, index) => (
            <li key={price.id} className="flex items-center gap-x-4 px-4 py-2">
              <p className="flex-1 text-sm">
                {formatDate(price.date)}
                {index === 0 && <span className="ml-2 text-xs font-bold text-zinc-600">current</span>}
                {price.source === "auto" && <AutoBadge />}
              </p>
              <p className="text-sm font-extrabold tabular-nums">{formatCoinPrice(price.price)}</p>
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
      <div className="mt-2">
        <CoinGeckoCredit />
      </div>
    </section>
  );
}
