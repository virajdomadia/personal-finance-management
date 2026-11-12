"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, type GoalTag, formatFullDate, formatRupees } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import {
  type Coin,
  type CoinTotal,
  type CryptoTradeForm,
  type CryptoTradeMode,
  blankCryptoTradeForm,
  formatCoinAverage,
  formatCoinPrice,
  formatCoinQty,
} from "@/lib/crypto";
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
  type Unlinked,
  holdingKinds,
  settle,
} from "@/lib/investments";
import { todayIndia } from "@/lib/transactions";
import { investmentEmoji, investmentSticker } from "@/lib/fun";
import { EmojiSquare, PageHeader, StackedBar, TABLE, TD, TD_NUM, TH, Tile } from "@/components/ui/chunky";

import {
  ConfirmDelete,
  GoalTagLink,
  LIST,
  Notice,
  BUY,
  SELL,
  PlainSigned,
  QUIET,
  SECONDARY,
  SECTION_TITLE,
  Signed,
  TradeRow,
  TradesTable,
  archivedIds,
  goalsByInstrument,
  isUnauthorized,
  tradeDeleteText,
} from "./shared";
import { CryptoTradeDialog } from "./crypto-trade-dialog";
import { FundTradeDialog } from "./fund-trade-dialog";
import { DueSips } from "./fund-view";
import { LinkPrompt } from "./link-prompt";
import { SipDialog } from "./sip-dialog";
import { TradeDialog, type TradeKind } from "./trade-dialog";

// The portfolio is what the page can't do without. Everything else loads and fails on its own, so a
// failing fund request leaves Stocks and Deposits showing.
type Data = {
  portfolio: Portfolio;
  stocks: Part<{ stocks: Stock[]; trades: Trade[] | null }>; // trades: the broker's, when viewing one
  funds: Part<{ funds: Fund[]; sips: Sip[] }>;
  coins: Part<{ coins: Coin[] }>;
  accounts: Part<{ active: Account[]; archived: Account[] }>;
  unlinked: Part<Unlinked>;
};
type StocksExtra = { stocks: Stock[]; trades: Trade[] | null; active: Account[]; archived: Account[] };
type FundsExtra = { funds: Fund[]; sips: Sip[] };
type CoinsExtra = { coins: Coin[] };
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: Data };
type Dialog =
  | { kind: "none" }
  | { kind: "trade"; trade: Trade | null; tradeKind: TradeKind }
  | { kind: "delete"; trade: Trade }
  | { kind: "fundTrade"; initial: FundTradeForm; focusNav: boolean }
  | { kind: "cryptoTrade"; initial: CryptoTradeForm }
  | { kind: "sip" };

async function fetchData(brokerId: number | null): Promise<Data> {
  const [portfolio, stocks, funds, coins, accounts, unlinked] = await Promise.all([
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
      apiFetch<{ coins: Coin[] }>("/investments/coins").then((c) => ({ coins: c.coins })),
      isUnauthorized,
    ),
    settle(
      Promise.all([apiFetch<AccountList>("/accounts"), apiFetch<AccountList>("/accounts?archived=true")]).then(([a, b]) => ({
        active: a.accounts,
        archived: b.accounts,
      })),
      isUnauthorized,
    ),
    // The prompt is a nicety: if this fails the page carries on without it.
    settle(apiFetch<Unlinked>("/investments/unlinked"), isUnauthorized),
  ]);
  return { portfolio, stocks, funds, coins, accounts, unlinked };
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

  // Once per visit, ask for fresh coin prices (the server only fetches if they are stale). It never
  // blocks the page, and any failure is ignored: the prices already shown stay.
  const refreshedCoins = useRef(false);
  useEffect(() => {
    if (refreshedCoins.current) return;
    refreshedCoins.current = true;
    apiFetch<{ refreshed: boolean }>("/investments/coins/refresh", { method: "POST" })
      .then((res) => {
        if (res.refreshed) reload();
      })
      .catch(() => {});
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
  const coinsData: CoinsExtra | null = data?.coins.status === "ready" ? data.coins.data : null;
  const coinsExtra: CoinsExtra | null = accounts ? coinsData : null;
  const accountsFailed = data?.accounts.status === "error";
  const brokers = accounts?.active.filter((a) => a.type === "broker") ?? [];
  const banks = accounts?.active.filter((a) => a.type === "bank") ?? [];
  const openFundTrade = (mode: FundTradeMode) =>
    setDialog({ kind: "fundTrade", initial: blankFundTradeForm(mode, todayIndia()), focusNav: false });
  const openCryptoTrade = (mode: CryptoTradeMode) =>
    setDialog({ kind: "cryptoTrade", initial: blankCryptoTradeForm(mode, todayIndia()) });
  const recordSip = (sip: Sip) =>
    setDialog({ kind: "fundTrade", initial: sipTradeForm(sip, sip.due_date ?? todayIndia()), focusNav: true });
  const done = (message: string | null) => {
    setNotice(message);
    closeDialog();
    reload();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Investments" />
      {data && <Overall portfolio={data.portfolio} />}

      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your investments...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <p>We couldn&apos;t load your investments.</p>
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
        <div className="flex flex-col gap-10">
          {data.unlinked.status === "ready" && <LinkPrompt unlinked={data.unlinked.data} />}
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
          <Crypto
            portfolio={data.portfolio}
            coins={coinsData}
            canAdd={accounts !== null}
            accountsFailed={accountsFailed}
            retrying={retrying}
            onRetry={retry}
            onAdd={openCryptoTrade}
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

      {dialog.kind === "cryptoTrade" && data && coinsExtra && (
        <CryptoTradeDialog
          trade={null}
          initial={dialog.initial}
          coins={coinsExtra.coins}
          brokers={brokers}
          holdings={data.portfolio.crypto.holdings}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
          onCoinCreated={reload}
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
    <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
      <p>We couldn&apos;t load your {what}.</p>
      <button type="button" className={`${QUIET} mt-2`} disabled={retrying} onClick={onRetry}>
        {retrying ? "Trying again..." : "Try again"}
      </button>
    </div>
  );
}

// Shown where the buttons and dialogs would be when the accounts they need didn't load.
function NeedsAccounts({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return (
    <p className="text-sm font-bold text-zinc-600">
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
        <h2 id="stocks-title" className="text-lg font-black">
          <span aria-hidden="true">{investmentEmoji("stock")} </span>Stocks
        </h2>
        {extra && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => onAdd("opening")}>
              Add existing shares
            </button>
            {hasHoldings && (
              <button type="button" className={SELL} onClick={() => onAdd("sell")}>
                Sell
              </button>
            )}
            <button type="button" className={BUY} onClick={() => onAdd("buy")}>
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
        <div className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-6 py-12 text-center">
          <p className="font-black">Add your shares</p>
          <p className="mx-auto mt-1 max-w-md text-sm font-bold text-zinc-600">
            Enter shares you already own, or record a buy. Buys and sells move your broker account&apos;s cash.
          </p>
          {extra && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button type="button" className={SECONDARY} onClick={() => onAdd("opening")}>
                Add existing shares
              </button>
              <button type="button" className={BUY} onClick={() => onAdd("buy")}>
                Buy
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <Summary totals={portfolio.totals} />
          <Holdings rows={portfolio.by_stock} goals={goalsByInstrument(portfolio.holdings, (h) => h.stock_id)} />
          {portfolio.closed.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer rounded px-1 py-1 text-xs font-black tracking-wider uppercase hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded">
                Sold ({portfolio.closed.length})
              </summary>
              <ul className={`${LIST} mt-1`}>
                {portfolio.closed.map((c) => (
                  <li key={`${c.stock_id}-${c.account_id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-32 flex-1">
                      <Link
                        href={`/investments/${c.stock_id}`}
                        className="text-sm font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded"
                      >
                        {c.symbol}
                      </Link>
                      <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">
                        {c.name} · {c.account_name}
                      </p>
                    </div>
                    <p className="text-right text-sm">
                      <span className="mr-1.5 text-xs font-bold text-zinc-600">Realised</span>
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
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Invested" value={formatRupees(totals.invested)} />
      <Tile label="Current value" value={formatRupees(totals.value)} />
      <Tile label="Unrealised P&L">
        <span className="mt-0.5 block text-[22px] leading-tight font-black tabular-nums break-words">
          <Signed value={totals.unrealised} />
        </span>
        <span className="block text-xs font-extrabold">
          <Signed value={totals.unrealised_percent} percentOnly />
        </span>
      </Tile>
      <Tile label="Realised P&L">
        <span className="mt-0.5 block text-[22px] leading-tight font-black tabular-nums break-words">
          <Signed value={totals.realised} />
        </span>
      </Tile>
    </div>
  );
}

function Holdings({ rows, goals }: { rows: StockTotal[]; goals: Map<number, GoalTag> }) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="holdings-title">
      <h3 id="holdings-title" className={SECTION_TITLE}>
        Holdings
      </h3>
      <div className="overflow-x-auto pb-1">
        <table className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
          <thead>
            <tr>
              <th scope="col" className={`${TH} text-left`}>Stock</th>
              <th scope="col" className={`${TH} text-right`}>Shares</th>
              <th scope="col" className={`${TH} hidden text-right lg:table-cell`}>Avg cost</th>
              <th scope="col" className={`${TH} hidden text-right lg:table-cell`}>Invested</th>
              <th scope="col" className={`${TH} text-right`}>Value</th>
              <th scope="col" className={`${TH} text-right`}>Unrealised P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.stock_id} className="hover:bg-due/30">
                <th scope="row" className={`${TD} text-left`}>
                  <EmojiSquare emoji={investmentEmoji("stock")} tone="blue" />
                  <Link
                    href={`/investments/${row.stock_id}`}
                    className="font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded"
                  >
                    {row.symbol}
                  </Link>
                  <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{row.name}</p>
                  <GoalTagLink tag={goals.get(row.stock_id)} />
                </th>
                <td className={`${TD_NUM}`}>{row.shares}</td>
                <td className={`${TD_NUM} hidden lg:table-cell`}>{formatRupees(row.average_cost)}</td>
                <td className={`${TD_NUM} hidden lg:table-cell`}>{formatRupees(row.invested)}</td>
                <td className={`${TD_NUM}`}>
                  {formatRupees(row.value)}
                  <p className="text-xs font-bold text-zinc-600 lg:hidden">
                    <span className="whitespace-nowrap">Invested {formatRupees(row.invested)}</span>{" · "}<span className="whitespace-nowrap">Avg {formatRupees(row.average_cost)}</span>
                  </p>
                  {row.at_cost ? (
                    <p className="text-xs font-bold text-zinc-600">at cost</p>
                  ) : row.price !== null ? (
                    <p className="text-xs font-bold text-zinc-600">@ {formatRupees(row.price)}</p>
                  ) : null}
                </td>
                <td className={`${TD} text-right`}>
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
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h3 id="broker-trades-title" className="text-lg font-black [overflow-wrap:anywhere]">
          {broker ? `Trades in ${broker.name}` : "Broker account not found"}
        </h3>
        <Link
          href="/investments"
          className="rounded text-sm font-extrabold text-zinc-700 underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded"
        >
          Show all investments
        </Link>
      </div>
      {broker && trades.length > 0 ? (
        <TradesTable caption={`Trades in ${broker.name}`}>
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
        </TradesTable>
      ) : (
        <p className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-4 py-6 text-center text-sm font-extrabold text-zinc-700">
          {broker ? `No trades in ${broker.name} yet.` : "This broker account doesn't exist, or isn't yours."}
        </p>
      )}
    </section>
  );
}

// Stocks, funds, deposits and crypto together, when there are two or more to add up.
function Overall({ portfolio }: { portfolio: Portfolio }) {
  const { overall } = portfolio;
  if (holdingKinds(portfolio) < 2) return null;
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="sm:col-span-2">
        <Tile
          tone="blue"
          size="huge"
          emoji="💎"
          label="All investments, worth today"
          value={formatRupees(overall.value)}
          sticker={investmentSticker(overall.unrealised_percent)}
        >
          <span className="mt-0.5 block text-xs font-extrabold break-words">
            <span className="uppercase">Unrealised</span> <PlainSigned value={overall.unrealised} percent={overall.unrealised_percent} />
          </span>
        </Tile>
      </div>
      <Tile tone="yellow" emoji="💰" label="You put in" value={formatRupees(overall.invested)} />
      <Tile label="Realised">
        <span className="mt-0.5 block text-[22px] leading-tight font-black tabular-nums break-words">
          <Signed value={overall.realised} />
        </span>
      </Tile>
      <div className="sm:col-span-2 lg:col-span-4">
        <Tile label="Split (stocks, funds, crypto)">
          <StackedBar
            label="Split by kind"
            items={[
              { label: "Stocks", value: Number(portfolio.totals.value) },
              { label: "Funds", value: Number(portfolio.funds.totals.value) },
              { label: "Crypto", value: Number(portfolio.crypto.totals.value) },
            ]}
          />
        </Tile>
      </div>
    </div>
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
        <h2 id="funds-title" className="text-lg font-black">
          <span aria-hidden="true">{investmentEmoji("mutual_fund")} </span>Mutual funds
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
              <button type="button" className={SELL} onClick={() => onAdd("sell")}>
                Redeem
              </button>
            )}
            <button type="button" className={BUY} onClick={() => onAdd("buy")}>
              Buy
            </button>
          </div>
        )}
      </div>

      {accountsFailed && fundsData && <NeedsAccounts retrying={retrying} onRetry={onRetry} />}

      {!fundsData ? (
        <SectionError onRetry={onRetry} what="mutual funds" retrying={retrying} />
      ) : empty && unheld.length === 0 ? (
        <div className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-6 py-12 text-center">
          <p className="font-black">Add your mutual funds</p>
          <p className="mx-auto mt-1 max-w-md text-sm font-bold text-zinc-600">
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
          <FundRows rows={funds.by_fund} goals={goalsByInstrument(funds.holdings, (h) => h.fund_id)} />
          {unheld.length > 0 && (
            <div>
              <h3 className={SECTION_TITLE}>No units yet</h3>
              <ul className={LIST}>
                {unheld.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                    <Link
                      href={`/investments/funds/${f.id}`}
                      className="text-sm font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded [overflow-wrap:anywhere]"
                    >
                      {f.name}
                    </Link>
                    <p className="text-xs font-bold text-zinc-600">{f.symbol}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {funds.closed.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer rounded px-1 py-1 text-xs font-black tracking-wider uppercase hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded">
                Redeemed ({funds.closed.length})
              </summary>
              <ul className={`${LIST} mt-1`}>
                {funds.closed.map((c) => (
                  <li key={`${c.fund_id}-${c.account_id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-32 flex-1">
                      <Link
                        href={`/investments/funds/${c.fund_id}`}
                        className="text-sm font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded [overflow-wrap:anywhere]"
                      >
                        {c.name}
                      </Link>
                      <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">
                        {c.symbol} · {c.account_name}
                      </p>
                    </div>
                    <p className="text-right text-sm">
                      <span className="mr-1.5 text-xs font-bold text-zinc-600">Realised</span>
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

function FundRows({ rows, goals }: { rows: FundTotal[]; goals: Map<number, GoalTag> }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 id="fund-holdings-title" className={SECTION_TITLE}>
        Holdings
      </h3>
      <div className="overflow-x-auto pb-1">
        <table aria-labelledby="fund-holdings-title" className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
          <thead>
            <tr>
              <th scope="col" className={`${TH} text-left`}>Fund</th>
              <th scope="col" className={`${TH} text-right`}>Units</th>
              <th scope="col" className={`${TH} hidden text-right lg:table-cell`}>Avg NAV</th>
              <th scope="col" className={`${TH} hidden text-right lg:table-cell`}>Invested</th>
              <th scope="col" className={`${TH} text-right`}>Value</th>
              <th scope="col" className={`${TH} text-right`}>Unrealised P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.fund_id} className="hover:bg-due/30">
                <th scope="row" className={`${TD} text-left`}>
                  <EmojiSquare emoji={investmentEmoji("mutual_fund")} tone="yellow" />
                  <Link
                    href={`/investments/funds/${row.fund_id}`}
                    className="font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded [overflow-wrap:anywhere]"
                  >
                    {row.name}
                  </Link>
                  <p className="text-xs font-bold text-zinc-600">{row.symbol}</p>
                  <GoalTagLink tag={goals.get(row.fund_id)} />
                </th>
                <td className={`${TD_NUM}`}>{formatUnits(row.units)}</td>
                <td className={`${TD_NUM} hidden lg:table-cell`}>{formatNav(row.average_nav)}</td>
                <td className={`${TD_NUM} hidden lg:table-cell`}>{formatRupees(row.invested)}</td>
                <td className={`${TD_NUM}`}>
                  {formatRupees(row.value)}
                  <p className="text-xs font-bold text-zinc-600 lg:hidden">
                    <span className="whitespace-nowrap">Invested {formatRupees(row.invested)}</span>{" · "}<span className="whitespace-nowrap">Avg NAV {formatNav(row.average_nav)}</span>
                  </p>
                  {row.at_cost ? (
                    <p className="text-xs font-bold text-zinc-600">at cost</p>
                  ) : row.nav !== null ? (
                    <p className="text-xs font-bold text-zinc-600">@ {formatNav(row.nav)}</p>
                  ) : null}
                </td>
                <td className={`${TD} text-right`}>
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

function Crypto({
  portfolio,
  coins: coinsData,
  canAdd,
  accountsFailed,
  retrying,
  onRetry,
  onAdd,
}: {
  portfolio: Portfolio;
  coins: CoinsExtra | null;
  canAdd: boolean;
  accountsFailed: boolean;
  retrying: boolean;
  onRetry: () => void;
  onAdd: (mode: CryptoTradeMode) => void;
}) {
  const crypto = portfolio.crypto;
  const empty = crypto.by_coin.length === 0 && crypto.closed.length === 0;
  const hasHoldings = crypto.holdings.length > 0;
  // A coin with no quantity and no past (one just added) still gets a row to reach it by.
  const listed = new Set([...crypto.by_coin.map((c) => c.coin_id), ...crypto.closed.map((c) => c.coin_id)]);
  const unheld = (coinsData?.coins ?? []).filter((c) => !listed.has(c.id));

  return (
    <section aria-labelledby="crypto-title" className="flex flex-col gap-8">
      <div className="-mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="crypto-title" className="text-lg font-black">
          <span aria-hidden="true">{investmentEmoji("crypto")} </span>Crypto
        </h2>
        {coinsData && canAdd && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={QUIET} onClick={() => onAdd("opening")}>
              Add existing coins
            </button>
            {hasHoldings && (
              <button type="button" className={SELL} onClick={() => onAdd("sell")}>
                Sell
              </button>
            )}
            <button type="button" className={BUY} onClick={() => onAdd("buy")}>
              Buy
            </button>
          </div>
        )}
      </div>

      {accountsFailed && coinsData && <NeedsAccounts retrying={retrying} onRetry={onRetry} />}

      {!coinsData ? (
        <SectionError onRetry={onRetry} what="crypto" retrying={retrying} />
      ) : empty && unheld.length === 0 ? (
        <div className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-6 py-12 text-center">
          <p className="font-black">Add your crypto</p>
          <p className="mx-auto mt-1 max-w-md text-sm font-bold text-zinc-600">
            Enter coins you already own, or record a buy. Buys and sells move your exchange account&apos;s balance.
          </p>
          {canAdd && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button type="button" className={SECONDARY} onClick={() => onAdd("opening")}>
                Add existing coins
              </button>
              <button type="button" className={BUY} onClick={() => onAdd("buy")}>
                Buy
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {!empty && <Summary totals={crypto.totals} />}
          <CoinRows rows={crypto.by_coin} goals={goalsByInstrument(crypto.holdings, (h) => h.coin_id)} />
          {unheld.length > 0 && (
            <div>
              <h3 className={SECTION_TITLE}>No coins yet</h3>
              <ul className={LIST}>
                {unheld.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                    <Link
                      href={`/investments/crypto/${c.id}`}
                      className="text-sm font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded [overflow-wrap:anywhere]"
                    >
                      {c.name}
                    </Link>
                    <p className="text-xs font-bold text-zinc-600">{c.symbol}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {crypto.closed.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer rounded px-1 py-1 text-xs font-black tracking-wider uppercase hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded">
                Sold ({crypto.closed.length})
              </summary>
              <ul className={`${LIST} mt-1`}>
                {crypto.closed.map((c) => (
                  <li key={`${c.coin_id}-${c.account_id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-32 flex-1">
                      <Link
                        href={`/investments/crypto/${c.coin_id}`}
                        className="text-sm font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded [overflow-wrap:anywhere]"
                      >
                        {c.name}
                      </Link>
                      <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">
                        {c.symbol} · {c.account_name}
                      </p>
                    </div>
                    <p className="text-right text-sm">
                      <span className="mr-1.5 text-xs font-bold text-zinc-600">Realised</span>
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

function CoinRows({ rows, goals }: { rows: CoinTotal[]; goals: Map<number, GoalTag> }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 id="coin-holdings-title" className={SECTION_TITLE}>
        Holdings
      </h3>
      <div className="overflow-x-auto pb-1">
        <table aria-labelledby="coin-holdings-title" className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
          <thead>
            <tr>
              <th scope="col" className={`${TH} text-left`}>Coin</th>
              <th scope="col" className={`${TH} text-right`}>Quantity</th>
              <th scope="col" className={`${TH} hidden text-right lg:table-cell`}>Avg price</th>
              <th scope="col" className={`${TH} hidden text-right lg:table-cell`}>Invested</th>
              <th scope="col" className={`${TH} text-right`}>Value</th>
              <th scope="col" className={`${TH} text-right`}>Unrealised P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.coin_id} className="hover:bg-due/30">
                <th scope="row" className={`${TD} text-left`}>
                  <EmojiSquare emoji={investmentEmoji("crypto")} tone="orange" />
                  <Link
                    href={`/investments/crypto/${row.coin_id}`}
                    className="font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded [overflow-wrap:anywhere]"
                  >
                    {row.name}
                  </Link>
                  <p className="text-xs font-bold text-zinc-600">{row.symbol}</p>
                  <GoalTagLink tag={goals.get(row.coin_id)} />
                </th>
                <td className={`${TD_NUM}`}>{formatCoinQty(row.quantity)}</td>
                <td className={`${TD_NUM} hidden lg:table-cell`}>{formatCoinAverage(row.average_price)}</td>
                <td className={`${TD_NUM} hidden lg:table-cell`}>{formatRupees(row.invested)}</td>
                <td className={`${TD_NUM}`}>
                  {formatRupees(row.value)}
                  <p className="text-xs font-bold text-zinc-600 lg:hidden">
                    <span className="whitespace-nowrap">Invested {formatRupees(row.invested)}</span>{" · "}<span className="whitespace-nowrap">Avg {formatCoinAverage(row.average_price)}</span>
                  </p>
                  {row.at_cost ? (
                    <p className="text-xs font-bold text-zinc-600">at cost</p>
                  ) : row.price !== null ? (
                    <p className="text-xs font-bold text-zinc-600">@ {formatCoinPrice(row.price)}</p>
                  ) : null}
                </td>
                <td className={`${TD} text-right`}>
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
        <h2 id="deposits-title" className="text-lg font-black">
          <span aria-hidden="true">🐷 </span>Deposits
        </h2>
        <p className="mt-1 text-sm font-bold text-zinc-700 tabular-nums">
          <span className="text-2xl font-black text-ink">{formatRupees(deposits.value)}</span>
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
          className="text-sm font-extrabold hover:underline focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded [overflow-wrap:anywhere]"
        >
          {row.name}
        </Link>
        <p className="text-xs font-bold text-zinc-600">
          {row.type === "ppf" ? "PPF" : "RD"} · Matures {formatFullDate(row.maturity_date)}
        </p>
      </div>
      <p className="text-right text-sm tabular-nums">
        {formatRupees(row.balance)}
        <span className="block text-xs font-bold text-zinc-600">
          ≈ {formatRupees(row.interest_estimate)} interest (estimate)
        </span>
      </p>
    </li>
  );
}
