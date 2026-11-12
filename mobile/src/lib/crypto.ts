import { type GoalTag, cleanMoney, formatRupees } from "./accounts.ts";
import { formatDate, realDate } from "./dates.ts";

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

// Charges are blank for none.
function chargesPaise(raw: string): bigint | null {
  const cleaned = cleanMoney(raw);
  return cleaned === "" ? BigInt(0) : scaled(cleaned, 2);
}

// The server refuses a non-opening trade whose quantity x price is further from amount - charges
// (buy) or amount + charges (sell) than Rs 1.00 or quantity x Rs 0.00005, whichever is more: a
// price has at most 4 decimals, so rounding it can move quantity x price by up to that much.
export function qtyMismatch(form: CryptoTradeForm): boolean {
  if (form.mode === "opening") return false;
  const quantity = scaled(form.quantity.trim(), 8);
  const price = scaled(form.price.trim(), 4);
  const gross = scaled(cleanMoney(form.amount), 2);
  const fee = chargesPaise(form.charges);
  if (quantity === null || price === null || gross === null || fee === null) return false;
  const expected = form.mode === "buy" ? gross - fee : gross + fee;
  // Quantity x price is in 10^-12 of a rupee; paise are 10^-2. Compared ten times over, so
  // quantity (10^-8) x 0.00005 is a whole number: quantity x 5 in 10^-13.
  const diff = (quantity * price - expected * BigInt(10) ** BigInt(10)) * BigInt(10);
  const rupee = BigInt(10) ** BigInt(13);
  const rounding = quantity * BigInt(5);
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
// up to 4 decimals, trailing zeros trimmed but never fewer than 2.
export function formatCoinPrice(price: string): string {
  const [whole, fraction = ""] = price.split(".");
  const trimmed = fraction.slice(0, 4).replace(/0+$/, "").padEnd(2, "0");
  return `₹${groupDecimal(`${whole}.${trimmed}`)}`;
}

// A derived average (average price, an existing-coins trade's "avg"). From ₹1 up it shows rupees and
// paise, rounded half up from the 4-decimal figure. Below ₹1 it shows up to 4 decimals, trimmed but
// never fewer than 2.
export function formatCoinAverage(price: string): string {
  const [whole, fraction = ""] = price.split(".");
  const padded = fraction.padEnd(4, "0").slice(0, 4);
  if (BigInt(whole) === BigInt(0)) {
    const trimmed = padded.replace(/0+$/, "").padEnd(2, "0");
    return `₹${whole}.${trimmed}`;
  }
  const hundredths = BigInt(whole + padded.slice(0, 2)) + BigInt(Number(padded[2]) >= 5 ? 1 : 0);
  const text = hundredths.toString();
  return `₹${groupDecimal(`${text.slice(0, -2)}.${text.slice(-2)}`)}`;
}

const MONEY = /^\d+(?:\.\d{1,2})?$/;
const MAX_AMOUNT = BigInt(10) ** BigInt(14); // Rs 10^12 in paise
const QTY_RULE = "Enter a quantity above 0, with up to 8 decimals, like 0.00014067.";
const PRICE_RULE = "Enter a price above 0, with up to 4 decimals, like 7504827.5.";
const MONEY_RULE = "Enter an amount, like 1234.50.";

// Like the server: trailing zeros don't count as decimals; above 0 and below 10^whole digits.
function validNumber(text: string, decimals: number, wholeDigits: number): boolean {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return false;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const whole = match[1].replace(/^0+/, "");
  return fraction.length <= decimals && whole.length <= wholeDigits && (whole !== "" || fraction !== "");
}

// The server's rules for a crypto transaction, with its messages, checked before saving.
// `today` is "YYYY-MM-DD" in India.
export function cryptoTradeErrors(form: CryptoTradeForm, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.coin_id === "") errors.coin_id = "Choose a coin.";
  if (form.account_id === "") errors.account_id = "Choose a broker or exchange account.";
  const date = form.date.trim();
  if (date === "") errors.date = "Choose a date.";
  else if (!realDate(date)) errors.date = "Enter a date like 2026-11-08.";
  else if (date > today) errors.date = "The date can't be in the future.";
  if (!validNumber(form.quantity.trim(), 8, 16)) errors.quantity = QTY_RULE;
  if (form.mode !== "opening" && !validNumber(form.price.trim(), 4, 10)) errors.price = PRICE_RULE;
  const amount = cleanMoney(form.amount);
  let gross: bigint | null = null;
  if (amount === "") errors.amount = "Enter the amount.";
  else if (!MONEY.test(amount)) errors.amount = MONEY_RULE;
  else {
    gross = scaled(amount, 2);
    if (gross === null || gross <= BigInt(0)) errors.amount = "Amount must be greater than 0.";
    else if (gross >= MAX_AMOUNT) errors.amount = "Amount must be under ₹10,00,00,00,00,000.";
  }
  const charges = cleanMoney(form.charges);
  if (charges !== "") {
    if (/^-\d/.test(charges)) errors.charges = "Charges can't be negative.";
    else if (!MONEY.test(charges)) errors.charges = MONEY_RULE;
    else if (gross !== null && !errors.amount && (scaled(charges, 2) ?? BigInt(0)) >= gross) {
      errors.charges = "Charges can't be more than the amount.";
    }
  }
  return errors;
}

// What an edit sends: only what changed. Never `side` or `opening`.
export function changedCryptoTrade(form: CryptoTradeForm, original: CryptoTrade): Record<string, unknown> {
  const before = cryptoTradePayload(cryptoTradeFormFrom(original), "edit");
  const after = cryptoTradePayload(form, "edit");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) result[key] = after[key];
  }
  return result;
}

export function cryptoTradeTitle(trade: Pick<CryptoTrade, "opening" | "side" | "quantity" | "symbol">): string {
  const quantity = `${formatCoinQty(trade.quantity)} ${trade.symbol}`;
  if (trade.opening) return `Existing ${quantity}`;
  return `${trade.side === "buy" ? "Bought" : "Sold"} ${quantity}`;
}

export function cryptoTradeDeleteText(trade: CryptoTrade): { title: string; body: string } {
  const body = trade.opening
    ? "It's removed for good, and the holding shrinks. This can't be undone."
    : `It's removed for good, and ${trade.account_name}'s cash moves back. This can't be undone.`;
  return { title: `Delete ${cryptoTradeTitle(trade)} on ${formatDate(trade.date)}?`, body };
}
