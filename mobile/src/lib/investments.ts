import { cleanMoney, formatRupees } from "./accounts.ts";

export type TradeSide = "buy" | "sell";

// These mirror the response models in backend/app/api/routes/{stocks,trades,portfolio}.py.
export type Stock = {
  id: number;
  symbol: string;
  name: string;
  price: string | null;
  price_date: string | null;
};

export type Price = { id: number; date: string; price: string };

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

export type Holding = Figures & { account_id: number; account_name: string };
export type StockTotal = Figures;

export type ClosedPosition = {
  stock_id: number;
  symbol: string;
  name: string;
  account_id: number;
  account_name: string;
  realised: string;
};

export type Portfolio = {
  holdings: Holding[];
  by_stock: StockTotal[];
  closed: ClosedPosition[];
  totals: {
    invested: string;
    value: string;
    unrealised: string;
    unrealised_percent: string;
    realised: string;
  };
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
