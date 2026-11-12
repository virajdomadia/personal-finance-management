import { type GoalTag, cleanMoney, formatRupees } from "./accounts.ts";
import type { CryptoPortfolio } from "./crypto.ts";
import type { FundsPortfolio } from "./funds.ts";

export type TradeSide = "buy" | "sell";

// These mirror the response models in backend/app/api/routes/{stocks,trades,portfolio}.py.
export type Stock = {
  id: number;
  symbol: string;
  name: string;
  price: string | null;
  price_date: string | null;
  source_code: string | null;
};

// "auto" prices come from the nightly fetch, "manual" ones were typed in.
export type PriceSource = "manual" | "auto";

export type Price = { id: number; date: string; price: string; source: PriceSource };

export type MarketKind = "stock" | "mutual_fund" | "crypto";
export type MarketMatch = { code: string; name: string; isin: string | null; price: string | null; price_date: string | null };
export type Unlinked = {
  stocks: { id: number; symbol: string; name: string }[];
  funds: { id: number; symbol: string; name: string }[];
  coins: { id: number; symbol: string; name: string }[];
};

export const MIN_SEARCH = 2;

export function canSearchMarket(q: string): boolean {
  return q.trim().length >= MIN_SEARCH;
}

export function marketSearchPath(kind: MarketKind, q: string): string {
  return `/investments/market-codes?kind=${kind}&q=${encodeURIComponent(q.trim())}`;
}

export function linkLabel(code: string | null): string {
  return code ? `Linked to ${code}` : "Link to live prices";
}

// A match picked in the search but not saved yet; "Linked to" is only for a saved link.
export function selectedLabel(name: string): string {
  return `Selected: ${name}`;
}

export const NO_MATCH: Record<MarketKind, string> = {
  stock: "No match. Try the company's full name.",
  mutual_fund: "No match. Try the fund's full name.",
  crypto: "No match. Try the coin's full name.",
};

// The ids of every unlinked holding, sorted. Stocks, funds and coins share one id space.
export function unlinkedIds(unlinked: Unlinked): number[] {
  return [...unlinked.stocks, ...unlinked.funds, ...unlinked.coins].map((h) => h.id).sort((a, b) => a - b);
}

// "Not now" remembers the unlinked ids it hid; the prompt comes back only for a new one.
export function shouldShowLinkPrompt(unlinked: number[], dismissed: number[]): boolean {
  const hidden = new Set(dismissed);
  return unlinked.some((id) => !hidden.has(id));
}

// What was stored at dismissal, or nothing if it is missing or not a list of ids.
export function parseDismissed(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is number => Number.isInteger(v)) : [];
  } catch {
    return [];
  }
}

export type Trade = {
  id: number;
  stock_id: number;
  symbol: string;
  account_id: number;
  account_name: string;
  side: TradeSide;
  date: string;
  quantity: number;
  price: string;
  charges: string;
  opening: boolean;
  note: string | null;
  amount: string;
  realised: string | null;
};

type Figures = {
  stock_id: number;
  symbol: string;
  name: string;
  shares: number;
  invested: string;
  average_cost: string;
  price: string | null;
  price_date: string | null;
  value: string;
  at_cost: boolean;
  unrealised: string;
  unrealised_percent: string;
};

export type Holding = Figures & { account_id: number; account_name: string; in_goal: GoalTag | null };
export type StockTotal = Figures;

export type ClosedPosition = {
  stock_id: number;
  symbol: string;
  name: string;
  account_id: number;
  account_name: string;
  realised: string;
};

export type Totals = {
  invested: string;
  value: string;
  unrealised: string;
  unrealised_percent: string;
  realised: string;
};

export type DepositRow = {
  account_id: number;
  name: string;
  type: "ppf" | "rd";
  balance: string;
  maturity_date: string;
  interest_estimate: string;
};

export type Deposits = {
  value: string;
  interest_estimate: string;
  accounts: DepositRow[];
};

export type Portfolio = {
  holdings: Holding[];
  by_stock: StockTotal[];
  closed: ClosedPosition[];
  totals: Totals;
  funds: FundsPortfolio;
  crypto: CryptoPortfolio;
  deposits: Deposits;
  overall: Totals;
};

// One independently loaded piece of the Investments page.
export type Part<T> = { status: "ready"; data: T } | { status: "error" };

// Runs a request so its failure becomes an error part instead of failing the page. Errors for
// which `fatal` is true (such as a 401, which must sign the user out) still throw.
export async function settle<T>(request: Promise<T>, fatal: (err: unknown) => boolean = () => false): Promise<Part<T>> {
  try {
    return { status: "ready", data: await request };
  } catch (err) {
    if (fatal(err)) throw err;
    return { status: "error" };
  }
}

// The kinds of holding the page has (stocks, funds, deposits, crypto): the "All investments" line is only worth showing for two or more.
export function holdingKinds(portfolio: Portfolio): number {
  const stocks = portfolio.by_stock.length + portfolio.closed.length > 0;
  const funds = portfolio.funds.by_fund.length + portfolio.funds.closed.length > 0;
  const deposits = portfolio.deposits.accounts.length > 0;
  const crypto = portfolio.crypto.by_coin.length + portfolio.crypto.closed.length > 0;
  return Number(stocks) + Number(funds) + Number(deposits) + Number(crypto);
}

export type TradeForm = {
  stock_id: string;
  account_id: string;
  side: TradeSide;
  date: string;
  quantity: string;
  price: string;
  charges: string;
  opening: boolean;
  note: string;
};

export function blankTradeForm(side: TradeSide, date: string, opening = false): TradeForm {
  return { stock_id: "", account_id: "", side, date, quantity: "", price: "", charges: "", opening, note: "" };
}

export function tradeFormFrom(trade: Trade): TradeForm {
  return {
    stock_id: String(trade.stock_id),
    account_id: String(trade.account_id),
    side: trade.side,
    date: trade.date,
    quantity: String(trade.quantity),
    price: trade.price,
    charges: trade.charges,
    opening: trade.opening,
    note: trade.note ?? "",
  };
}

export function tradePayload(form: TradeForm, mode: "create" | "edit"): Record<string, unknown> {
  const charges = cleanMoney(form.charges);
  const note = form.note.trim();
  const payload: Record<string, unknown> = {
    stock_id: Number(form.stock_id),
    account_id: Number(form.account_id),
  };
  if (mode === "create") payload.side = form.side;
  payload.date = form.date;
  payload.quantity = Number(form.quantity.trim());
  payload.price = cleanMoney(form.price);
  payload.charges = charges === "" ? "0" : charges;
  if (mode === "create") payload.opening = form.opening;
  payload.note = note === "" ? null : note;
  return payload;
}

// A plain amount with at most 2 decimals, as paise. Null for anything else.
function paise(text: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

// The preview total: buy is quantity x price + charges, sell is quantity x price - charges.
// Worked out in paise so no float rounding creeps in. Null when an input is invalid.
export function tradeTotal(form: TradeForm): string | null {
  const quantity = /^\d+$/.test(form.quantity.trim()) ? Number(form.quantity.trim()) : 0;
  const price = paise(cleanMoney(form.price));
  const rawCharges = cleanMoney(form.charges);
  const charges = rawCharges === "" ? 0 : paise(rawCharges);
  if (quantity <= 0 || price === null || price <= 0 || charges === null) return null;
  const gross = quantity * price;
  const total = form.side === "buy" ? gross + charges : gross - charges;
  const sign = total < 0 ? "-" : "";
  const abs = Math.abs(total);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const MINUS = "−";

function isZero(value: string): boolean {
  return /^[-+]?[0.]*$/.test(value.trim());
}

export function tone(value: string): "gain" | "loss" | "flat" {
  if (isZero(value)) return "flat";
  return value.trim().startsWith("-") ? "loss" : "gain";
}

export function formatSigned(value: string): string {
  if (isZero(value)) return formatRupees(value.trim().replace(/^[-+]/, ""));
  const text = value.trim();
  return text.startsWith("-") ? `${MINUS}${formatRupees(text.slice(1))}` : `+${formatRupees(text.replace(/^\+/, ""))}`;
}

export function formatPercent(value: string): string {
  const text = value.trim();
  if (isZero(text)) return `${text.replace(/^[-+]/, "")}%`;
  return text.startsWith("-") ? `${MINUS}${text.slice(1)}%` : `+${text.replace(/^\+/, "")}%`;
}

// The Sync prices button: what POST /investments/prices/sync answers.
export type SyncResult = { synced_at: string; updated: Record<string, number>; failed: Record<string, string> };
export type SyncState = { status: "idle" | "syncing" | "done" | "partial" };

export const SYNC_PARTIAL = "Some prices couldn't be fetched. Try again later.";

// The line shown beside the button; nothing before the first sync.
export function syncStatusText(state: SyncState): string {
  if (state.status === "syncing") return "Syncing…";
  if (state.status === "done") return "Updated just now";
  if (state.status === "partial") return SYNC_PARTIAL;
  return "";
}

// A source that failed, or a request that did not get through, is a partial sync.
export function syncOutcome(result: SyncResult | null): SyncState {
  return { status: result !== null && Object.keys(result.failed).length === 0 ? "done" : "partial" };
}

// The longest name a stock, fund or coin can have.
export const NAME_MAX = 60;

// What a market match fills in for a new holding. A stock's NSE code is its symbol. A coin's match
// is named like "Bitcoin (BTC)", so the ticker comes from there. A fund's symbol is made by the server.
export function prefillFromMatch(kind: MarketKind, match: MarketMatch): { name: string; symbol: string } {
  const clip = (text: string) => text.trim().slice(0, NAME_MAX).trim();
  if (kind === "stock") return { name: clip(match.name), symbol: match.code.trim().toUpperCase().slice(0, 20) };
  if (kind === "crypto") {
    const found = /^(.*\S)\s*\(([A-Za-z0-9]{1,20})\)$/.exec(match.name.trim());
    if (found) return { name: clip(found[1]), symbol: found[2].toUpperCase() };
  }
  return { name: clip(match.name), symbol: "" };
}

// Where a new stock, fund or coin is created together with its first purchase, in one save.
export function withTradePath(kind: MarketKind): string {
  return `/investments/${kind === "stock" ? "stocks" : kind === "mutual_fund" ? "funds" : "coins"}/with-trade`;
}

const NOT_IN_FIRST_TRADE = new Set(["stock_id", "fund_id", "coin_id", "side", "sip_id"]);

// A trade's create payload as the first trade of a new holding: no instrument id (it is created in
// the same save), no side (always a buy) and no SIP (a new fund has none yet).
export function asFirstTrade(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !NOT_IN_FIRST_TRADE.has(key)));
}
