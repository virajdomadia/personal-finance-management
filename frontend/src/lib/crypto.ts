import { type GoalTag, cleanMoney, formatRupees } from "./accounts.ts";

// Like the server: a coin can be priced at a fraction of a paisa.
export const PRICE_DECIMALS = 10;

// These mirror the response models in backend/app/api/routes/{coins,crypto_trades,portfolio}.py.
export type Coin = {
  id: number;
  symbol: string;
  name: string;
  price: string | null;
  price_date: string | null;
  source_code: string | null;
};

export type CoinPrice = { id: number; date: string; price: string; source: "manual" | "auto" };

export type CryptoTrade = {
  id: number;
  coin_id: number;
  symbol: string;
  account_id: number;
  account_name: string;
  side: "buy" | "sell";
  date: string;
  quantity: string;
  price: string;
  charges: string;
  amount: string;
  opening: boolean;
  note: string | null;
  realised: string | null;
};

type CoinFigures = {
  coin_id: number;
  symbol: string;
  name: string;
  quantity: string;
  invested: string;
  average_price: string;
  price: string | null;
  price_date: string | null;
  value: string;
  at_cost: boolean;
  unrealised: string;
  unrealised_percent: string;
};

export type CoinHolding = CoinFigures & { account_id: number; account_name: string; in_goal: GoalTag | null };
export type CoinTotal = CoinFigures;

export type CoinClosed = {
  coin_id: number;
  symbol: string;
  name: string;
  account_id: number;
  account_name: string;
  realised: string;
};

export type CryptoPortfolio = {
  holdings: CoinHolding[];
  by_coin: CoinTotal[];
  closed: CoinClosed[];
  totals: {
    invested: string;
    value: string;
    unrealised: string;
    unrealised_percent: string;
    realised: string;
  };
};

export type CryptoTradeMode = "buy" | "sell" | "opening";

export type CryptoTradeForm = {
  coin_id: string;
  account_id: string;
  mode: CryptoTradeMode;
  date: string;
  quantity: string;
  price: string;
  charges: string;
  amount: string;
  note: string;
};

// A plain number with at most `max` decimals, scaled to an integer. Null for anything else.
function scaled(value: string, max: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2] ?? "").length > max) return null;
  return BigInt(match[1] + (match[2] ?? "").padEnd(max, "0"));
}

// Like the server: a number above 0 with at most `decimals` decimals (trailing zeros don't count)
// and at most `wholeDigits` digits before the point (leading zeros don't count).
export function validNumber(text: string, decimals: number, wholeDigits: number): boolean {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return false;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const whole = match[1].replace(/^0+/, "");
  return fraction.length <= decimals && whole.length <= wholeDigits && (whole !== "" || fraction !== "");
}

// Charges are blank for none.
function chargesPaise(raw: string): bigint | null {
  const cleaned = cleanMoney(raw);
  return cleaned === "" ? BigInt(0) : scaled(cleaned, 2);
}

// The server refuses a non-opening trade whose quantity x price is further from amount - charges
// (buy) or amount + charges (sell) than Rs 1.00 or quantity x Rs 0.00005, whichever is more: an
// exchange may show a price rounded to 4 decimals, so quantity x price can be off by that much.
export function qtyMismatch(form: CryptoTradeForm): boolean {
  if (form.mode === "opening") return false;
  const quantity = scaled(form.quantity.trim(), 8);
  const price = scaled(form.price.trim(), PRICE_DECIMALS);
  const gross = scaled(cleanMoney(form.amount), 2);
  const fee = chargesPaise(form.charges);
  if (quantity === null || price === null || gross === null || fee === null) return false;
  const expected = form.mode === "buy" ? gross - fee : gross + fee;
  // Quantity (10^-8) x price (10^-10) is in 10^-18 of a rupee; paise are 10^-2. Quantity x
  // Rs 0.00005 is then quantity x 500000.
  const diff = quantity * price - expected * BigInt(10) ** BigInt(16);
  const rupee = BigInt(10) ** BigInt(18);
  const rounding = quantity * BigInt(500000);
  const tolerance = rounding > rupee ? rounding : rupee;
  return (diff < BigInt(0) ? -diff : diff) > tolerance;
}

export function blankCryptoTradeForm(mode: CryptoTradeMode, date: string): CryptoTradeForm {
  return { coin_id: "", account_id: "", mode, date, quantity: "", price: "", charges: "", amount: "", note: "" };
}

export function cryptoTradeFormFrom(trade: CryptoTrade): CryptoTradeForm {
  return {
    coin_id: String(trade.coin_id),
    account_id: String(trade.account_id),
    mode: trade.opening ? "opening" : trade.side,
    date: trade.date,
    quantity: trade.quantity,
    price: trade.price,
    charges: trade.charges,
    amount: trade.amount,
    note: trade.note ?? "",
  };
}

// Quantity and price go as text, like money: the server rejects JSON numbers for them.
export function cryptoTradePayload(form: CryptoTradeForm, mode: "create" | "edit"): Record<string, unknown> {
  const charges = cleanMoney(form.charges);
  const note = form.note.trim();
  const payload: Record<string, unknown> = {
    coin_id: Number(form.coin_id),
    account_id: Number(form.account_id),
  };
  if (mode === "create") payload.side = form.mode === "sell" ? "sell" : "buy";
  payload.date = form.date;
  payload.quantity = form.quantity.trim();
  if (form.mode !== "opening") payload.price = form.price.trim();
  payload.charges = charges === "" ? "0" : charges;
  payload.amount = cleanMoney(form.amount);
  if (mode === "create") payload.opening = form.mode === "opening";
  payload.note = note === "" ? null : note;
  return payload;
}

function groupDecimal(value: string): string {
  const [whole, fraction] = value.split(".");
  const grouped = formatRupees(whole).slice(1);
  return fraction !== undefined ? `${grouped}.${fraction}` : grouped;
}

export function formatCoinQty(quantity: string): string {
  const [whole, fraction = ""] = quantity.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return groupDecimal(trimmed === "" ? whole : `${whole}.${trimmed}`);
}

// A recorded or typed price (current price, price history, a trade's "@ price") shows as entered:
// up to 4 decimals (10 below Rs 1, so a fraction of a paisa shows), trailing zeros trimmed but
// never fewer than 2.
export function formatCoinPrice(price: string): string {
  const [whole, fraction = ""] = price.split(".");
  const places = BigInt(whole) === BigInt(0) ? PRICE_DECIMALS : 4;
  const trimmed = fraction.slice(0, places).replace(/0+$/, "").padEnd(2, "0");
  return `₹${groupDecimal(`${whole}.${trimmed}`)}`;
}

// A derived average (average price, an existing-coins trade's "avg"). From ₹1 up it shows rupees and
// paise, rounded half up from the 4-decimal figure. Below ₹1 it shows up to 10 decimals, trimmed
// but never fewer than 2.
export function formatCoinAverage(price: string): string {
  const [whole, fraction = ""] = price.split(".");
  if (BigInt(whole) === BigInt(0)) {
    const trimmed = fraction.slice(0, PRICE_DECIMALS).replace(/0+$/, "").padEnd(2, "0");
    return `₹${whole}.${trimmed}`;
  }
  const padded = fraction.padEnd(4, "0").slice(0, 4);
  const hundredths = BigInt(whole + padded.slice(0, 2)) + BigInt(Number(padded[2]) >= 5 ? 1 : 0);
  const text = hundredths.toString();
  return `₹${groupDecimal(`${text.slice(0, -2)}.${text.slice(-2)}`)}`;
}
