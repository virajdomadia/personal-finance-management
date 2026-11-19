import { type GoalTag, cleanMoney, formatRupees } from "./accounts.ts";
import type { CryptoPortfolio } from "./crypto.ts";
import type { FundsPortfolio } from "./funds.ts";
import { formatDate, realDate } from "./dates.ts";

// realDate lives in dates.ts (a module with no imports); re-exported for the screens that import it from here.
export { realDate };

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

// "Not now" on a link card remembers the unlinked ids it hid; a card comes back only for a new
// one. Stocks, funds and coins share one id space.
export function shouldShowLinkPrompt(unlinked: number[], dismissed: number[]): boolean {
  const hidden = new Set(dismissed);
  return unlinked.some((id) => !hidden.has(id));
}

// Each kind has its own card, so a dismissal adds its ids to those already hidden. Sorted.
export function dismissIds(dismissed: number[], shown: number[]): number[] {
  return [...new Set([...dismissed, ...shown])].sort((a, b) => a - b);
}

// What was stored, or nothing if it is missing or not a list of ids.
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
  dividends: string; // all time, applied dividends whose ex-date has come
  dividends_fy: string; // this Indian financial year
  total_return: string; // unrealised + realised + dividends
};

// One active PPF, RD or FD. The estimate comes from the server; the app never works out interest.
export type DepositRow = {
  account_id: number;
  name: string;
  type: "ppf" | "rd" | "fd";
  balance: string;
  maturity_date: string | null;
  interest_estimate: string;
};

export type DepositsPortfolio = { value: string; interest_estimate: string; accounts: DepositRow[] };

export type Portfolio = {
  holdings: Holding[];
  by_stock: StockTotal[];
  closed: ClosedPosition[];
  totals: Totals;
  funds: FundsPortfolio;
  crypto: CryptoPortfolio;
  deposits: DepositsPortfolio;
  overall: Totals;
};

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

const QUANTITY_RULE = "Enter a whole number of shares, from 1 to 10,00,00,000.";
const MAX_QUANTITY = 100_000_000;
const MONEY = /^\d+(?:\.\d{1,2})?$/;

// The server's rules for the fields every trade needs, with its messages. Checked before saving,
// because tradePayload sends NaN for a bad quantity and a new stock must not be created for a
// trade that is bound to be refused. `today` is "YYYY-MM-DD" in India.
export function tradeErrors(form: TradeForm, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.account_id === "") errors.account_id = "Choose a broker account.";
  const date = form.date.trim();
  if (date === "") errors.date = "Choose a date.";
  else if (!realDate(date)) errors.date = "Enter a date like 2026-11-08.";
  else if (date > today) errors.date = "The date can't be in the future.";
  const quantity = form.quantity.trim();
  if (!/^\d+$/.test(quantity) || Number(quantity) < 1 || Number(quantity) > MAX_QUANTITY) errors.quantity = QUANTITY_RULE;
  const price = cleanMoney(form.price);
  if (!MONEY.test(price)) errors.price = "Enter a price, like 1234.50.";
  else if (Number(price) <= 0) errors.price = "Price must be greater than 0.";
  const charges = cleanMoney(form.charges);
  if (charges !== "" && !MONEY.test(charges)) errors.charges = "Enter an amount, like 1234.50.";
  return errors;
}

// What an edit sends: only what changed, so a stale form can't overwrite a change made elsewhere.
export function changedTrade(form: TradeForm, original: Trade): Record<string, unknown> {
  const before = tradePayload(tradeFormFrom(original), "edit");
  const after = tradePayload(form, "edit");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) result[key] = after[key];
  }
  return result;
}

export function tradeTitle(trade: Pick<Trade, "opening" | "side" | "quantity" | "symbol">): string {
  if (trade.opening) return `Existing ${trade.quantity} ${trade.symbol}`;
  return `${trade.side === "buy" ? "Bought" : "Sold"} ${trade.quantity} ${trade.symbol}`;
}

export function sideLabel(trade: { side: TradeSide; opening: boolean }): string {
  return trade.opening ? "Add existing shares" : trade.side === "buy" ? "Buy" : "Sell";
}

export function tradeDeleteText(trade: Trade): { title: string; body: string } {
  return {
    title: `Delete ${tradeTitle(trade)} on ${formatDate(trade.date)}?`,
    body: trade.opening
      ? "It's removed for good, and the holding shrinks. This can't be undone."
      : `It's removed for good, and ${trade.account_name}'s cash moves back. This can't be undone.`,
  };
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

export type Prefill = { name: string; symbol: string };

// What a new pick (or clearing it, `match` null) does to the typed name and symbol. A field takes the
// match's value when it is empty or still holds what the last pick filled in; anything typed by hand
// stays. Clearing empties what the last pick filled in. `filled` is what to remember for the next pick.
export function applyPick(
  kind: MarketKind,
  current: Prefill,
  previous: Prefill | null,
  match: MarketMatch | null,
): { fields: Prefill; filled: Prefill | null } {
  const auto = (key: keyof Prefill) => current[key].trim() === "" || (previous !== null && current[key] === previous[key]);
  if (match === null) {
    return {
      fields: {
        name: previous !== null && current.name === previous.name ? "" : current.name,
        symbol: previous !== null && current.symbol === previous.symbol ? "" : current.symbol,
      },
      filled: null,
    };
  }
  const fill = prefillFromMatch(kind, match);
  return {
    fields: { name: auto("name") ? fill.name : current.name, symbol: auto("symbol") ? fill.symbol : current.symbol },
    filled: fill,
  };
}

// These mirror the response models in backend/app/api/routes/corporate_actions.py.
export type ActionKind = "split" | "consolidation" | "bonus" | "merger" | "demerger" | "dividend" | "other";
export type ActionStatus = "pending" | "applied" | "dismissed";

export type Preview = { shares_before: number; shares_after: number; average_before: string; average_after: string };
export type DividendAccount = { account_id: number; account_name: string; gross: string; links: number[] };
export type DividendFigures = { gross: string; by_account: DividendAccount[] };

export type CorporateAction = {
  id: number;
  stock_id: number;
  symbol: string;
  kind: ActionKind;
  ex_date: string;
  ratio_new: string | null;
  ratio_old: string | null;
  amount_per_share: string | null;
  status: ActionStatus;
  purpose: string | null;
  target_stock_id: number | null;
  cost_share_pct: string | null;
  preview: Preview | null;
  dividend: DividendFigures | null;
};

export type ActionList = { actions: CorporateAction[]; pending_count: number };
export type StockActions = { actions: CorporateAction[]; suspect_drop_on: string | null; backfilled: boolean };

// A per-share amount with at least two decimals: "2.5" -> "₹2.50".
function perShare(amount: string): string {
  const [whole, fraction = ""] = amount.split(".");
  return formatRupees(`${whole}.${fraction.padEnd(2, "0")}`);
}

const KIND_LABEL: Record<ActionKind, string> = {
  split: "Split",
  consolidation: "Consolidation",
  bonus: "Bonus",
  merger: "Merger",
  demerger: "Demerger",
  dividend: "Dividend",
  other: "Other action",
};

// "Split 1:5 on 12 Mar 2026". A 1:5 split turns one share into five. Same wording as the web app.
export function describeAction(a: CorporateAction): string {
  const date = formatDate(a.ex_date);
  if (a.kind === "dividend") {
    return `Dividend ${a.amount_per_share !== null ? `${perShare(a.amount_per_share)}/share` : ""} on ${date}`.replace("Dividend  on", "Dividend on");
  }
  if (a.kind === "other") return `${a.purpose ?? KIND_LABEL.other} on ${date}`;
  // A bonus is quoted as new:old ("2:1" is two free shares per one held); a split as old:new.
  const pair = a.kind === "bonus" ? [a.ratio_new, a.ratio_old] : [a.ratio_old, a.ratio_new];
  const ratio = a.ratio_old !== null && a.ratio_new !== null ? ` ${pair[0]}:${pair[1]}` : "";
  return `${KIND_LABEL[a.kind]}${ratio} on ${date}`;
}

// "40 → 200 shares · avg ₹1,500.00 → ₹300.00"; empty when there is nothing to preview.
export function describePreview(p: Preview | null): string {
  if (p === null) return "";
  return `${p.shares_before} → ${p.shares_after} shares · avg ${formatRupees(p.average_before)} → ${formatRupees(p.average_after)}`;
}

export function isUpcoming(a: { ex_date: string }, today: string): boolean {
  return a.ex_date > today;
}

// What a dividend paid (or will pay). Empty for any other kind.
export function dividendLabel(a: CorporateAction, today: string): string {
  if (a.kind !== "dividend" || a.dividend === null) return "";
  const { gross, by_account } = a.dividend;
  if (a.status === "applied" && by_account.length === 0 && Number(gross) === 0) return "Not held on record date";
  const money = formatRupees(gross);
  if (a.status !== "applied") return `Would pay ${money}`;
  return isUpcoming(a, today) ? `Expected ${money}` : `Received ${money}`;
}

// A merger or demerger can only be confirmed once it names the stock the shares move into.
export function needsTarget(a: Pick<CorporateAction, "kind">): boolean {
  return a.kind === "merger" || a.kind === "demerger";
}

// Cost-share percent as typed: digits and one dot, or empty.
export function cleanPercent(value: string): string {
  return value.replace(/[^\d.]/g, "");
}

const RATIO_RULE = "Enter how many new shares you get for how many you hold, like 1 for 2.";

// A merger's or demerger's "new shares : shares held", as typed: null when both are numbers above 0.
export function ratioProblem(newShares: string, held: string): string | null {
  const positive = (v: string) => /^\d+(\.\d+)?$/.test(v.trim()) && Number(v) > 0;
  return positive(newShares) && positive(held) ? null : RATIO_RULE;
}

// An action of no known kind ("other") is kept for history only; the server never confirms one.
export function canConfirm(a: Pick<CorporateAction, "kind">): boolean {
  return a.kind !== "other";
}
