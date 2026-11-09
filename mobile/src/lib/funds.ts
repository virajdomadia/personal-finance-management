import { cleanMoney, formatDueDate, formatRupees } from "./accounts.ts";
import { realDate } from "./investments.ts";
import { formatDate } from "./transactions.ts";

// These mirror the response models in backend/app/api/routes/{funds,fund_trades,sips,portfolio}.py.
export type Fund = {
  id: number;
  symbol: string;
  name: string;
  nav: string | null;
  nav_date: string | null;
};

export type Nav = { id: number; date: string; nav: string; trade_id: number | null };

export type FundTrade = {
  id: number;
  fund_id: number;
  symbol: string;
  account_id: number;
  account_name: string;
  side: "buy" | "sell";
  date: string;
  units: string;
  nav: string;
  charges: string;
  amount: string;
  opening: boolean;
  sip_id: number | null;
  note: string | null;
  realised: string | null;
};

export type Sip = {
  id: number;
  fund_id: number;
  symbol: string;
  fund_name: string;
  account_id: number;
  account_name: string;
  amount: string;
  day: number;
  start_date: string;
  active: boolean;
  instalments: number;
  due: string[];
  due_date: string | null;
};

type FundFigures = {
  fund_id: number;
  symbol: string;
  name: string;
  units: string;
  invested: string;
  average_nav: string;
  nav: string | null;
  nav_date: string | null;
  value: string;
  at_cost: boolean;
  unrealised: string;
  unrealised_percent: string;
};

export type FundHolding = FundFigures & { account_id: number; account_name: string };
export type FundTotal = FundFigures;

export type FundClosed = {
  fund_id: number;
  symbol: string;
  name: string;
  account_id: number;
  account_name: string;
  realised: string;
};

export type FundsPortfolio = {
  holdings: FundHolding[];
  by_fund: FundTotal[];
  closed: FundClosed[];
  totals: {
    invested: string;
    value: string;
    unrealised: string;
    unrealised_percent: string;
    realised: string;
  };
  due_sips: Sip[];
};

export type FundTradeMode = "buy" | "sell" | "opening" | "sip";

export type FundTradeForm = {
  fund_id: string;
  account_id: string;
  mode: FundTradeMode;
  date: string;
  units: string;
  nav: string;
  charges: string;
  amount: string;
  sip_id: string;
  note: string;
};

export type SipForm = {
  fund_id: string;
  account_id: string;
  amount: string;
  day: string;
  start_date: string;
  active: boolean;
};

// A plain number with at most `max` decimals, scaled to an integer. Null for anything else.
function scaled(value: string, max: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2] ?? "").length > max) return null;
  return BigInt(match[1] + (match[2] ?? "").padEnd(max, "0"));
}

function fixed(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

// Charges are blank for none.
function chargesPaise(raw: string): bigint | null {
  const cleaned = cleanMoney(raw);
  return cleaned === "" ? BigInt(0) : scaled(cleaned, 2);
}

// 0.005% of the amount, to the paisa, half up.
export function stampDuty(amount: string): string | null {
  const paise = scaled(cleanMoney(amount), 2);
  if (paise === null) return null;
  return fixed((BigInt(2) * paise + BigInt(20000)) / BigInt(40000), 2);
}

// (amount - charges) / NAV as thousandths of a unit, exact and half up.
export function suggestedUnits(amount: string, charges: string, nav: string): string | null {
  const gross = scaled(cleanMoney(amount), 2);
  const fee = chargesPaise(charges);
  const price = scaled(nav.trim(), 4);
  if (gross === null || fee === null || price === null || price === BigInt(0)) return null;
  const net = gross - fee;
  if (net <= BigInt(0)) return null;
  return fixed((BigInt(2) * net * BigInt(100000) + price) / (BigInt(2) * price), 3);
}

// The server refuses a purchase whose units x NAV is more than Rs 1.00 from amount - charges.
export function unitsMismatch(form: FundTradeForm): boolean {
  if (form.mode !== "buy" && form.mode !== "sip") return false;
  const units = scaled(form.units.trim(), 3);
  const price = scaled(form.nav.trim(), 4);
  const gross = scaled(cleanMoney(form.amount), 2);
  const fee = chargesPaise(form.charges);
  if (units === null || price === null || gross === null || fee === null) return false;
  // Units x NAV is in 1/10^7 of a rupee; paise are 1/10^2.
  const diff = units * price - (gross - fee) * BigInt(100000);
  return (diff < BigInt(0) ? -diff : diff) > BigInt(10000000);
}

export function blankFundTradeForm(mode: FundTradeMode, date: string): FundTradeForm {
  return { fund_id: "", account_id: "", mode, date, units: "", nav: "", charges: "", amount: "", sip_id: "", note: "" };
}

export function sipTradeForm(sip: Sip, date: string): FundTradeForm {
  return {
    ...blankFundTradeForm("sip", date),
    fund_id: String(sip.fund_id),
    account_id: String(sip.account_id),
    amount: sip.amount,
    charges: stampDuty(sip.amount) ?? "",
    sip_id: String(sip.id),
  };
}

export function fundTradeFormFrom(trade: FundTrade): FundTradeForm {
  const mode: FundTradeMode = trade.opening ? "opening" : trade.sip_id !== null ? "sip" : trade.side;
  return {
    fund_id: String(trade.fund_id),
    account_id: String(trade.account_id),
    mode,
    date: trade.date,
    units: trade.units,
    nav: trade.nav,
    charges: trade.charges,
    amount: trade.amount,
    sip_id: trade.sip_id === null ? "" : String(trade.sip_id),
    note: trade.note ?? "",
  };
}

// Units and NAV go as text, like money: the server rejects JSON numbers for them.
export function fundTradePayload(form: FundTradeForm, mode: "create" | "edit"): Record<string, unknown> {
  const charges = cleanMoney(form.charges);
  const note = form.note.trim();
  const sipId = form.mode === "sip" && form.sip_id.trim() !== "" ? Number(form.sip_id) : null;
  const payload: Record<string, unknown> = {
    fund_id: Number(form.fund_id),
    account_id: Number(form.account_id),
  };
  if (mode === "create") payload.side = form.mode === "sell" ? "sell" : "buy";
  payload.date = form.date;
  payload.units = form.units.trim();
  if (form.mode !== "opening") payload.nav = form.nav.trim();
  payload.charges = charges === "" ? "0" : charges;
  payload.amount = cleanMoney(form.amount);
  if (mode === "create") payload.opening = form.mode === "opening";
  payload.sip_id = sipId;
  payload.note = note === "" ? null : note;
  return payload;
}

function groupDecimal(value: string): string {
  const [whole, fraction] = value.split(".");
  const grouped = formatRupees(whole).slice(1);
  return fraction !== undefined ? `${grouped}.${fraction}` : grouped;
}

export function formatUnits(units: string): string {
  return groupDecimal(units);
}

export function formatNav(nav: string): string {
  return `₹${groupDecimal(nav)}`;
}

export function dueText(sip: Sip): string {
  const first = sip.due_date ?? sip.due[0];
  if (!first) return "";
  const amount = formatRupees(sip.amount.replace(/\.00$/, ""));
  const months = sip.due.length > 1 ? ` (${sip.due.length} months)` : "";
  return `${sip.fund_name}: ${amount} SIP due since ${formatDueDate(first)}${months}. Record it.`;
}

export function blankSipForm(date: string): SipForm {
  return { fund_id: "", account_id: "", amount: "", day: "", start_date: date, active: true };
}

export function sipFormFrom(sip: Sip): SipForm {
  return {
    fund_id: String(sip.fund_id),
    account_id: String(sip.account_id),
    amount: sip.amount,
    day: String(sip.day),
    start_date: sip.start_date,
    active: sip.active,
  };
}

export function sipPayload(form: SipForm, mode: "create" | "edit"): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (mode === "create") payload.fund_id = Number(form.fund_id);
  payload.account_id = Number(form.account_id);
  payload.amount = cleanMoney(form.amount);
  payload.day = Number(form.day.trim());
  if (mode === "create") payload.start_date = form.start_date;
  else payload.active = form.active;
  return payload;
}

const MONEY = /^\d+(?:\.\d{1,2})?$/;
const MAX_AMOUNT = BigInt(10) ** BigInt(14); // Rs 10^12 in paise
const UNITS_RULE = "Enter units above 0, with up to 3 decimals, like 35.552.";
const NAV_RULE = "Enter a NAV above 0, with up to 4 decimals, like 84.3793.";
const MONEY_RULE = "Enter an amount, like 1234.50.";

// Like the server: trailing zeros don't count as decimals; above 0 and below 10^whole digits.
function validNumber(text: string, decimals: number, wholeDigits: number): boolean {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return false;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  const whole = match[1].replace(/^0+/, "");
  return fraction.length <= decimals && whole.length <= wholeDigits && (whole !== "" || fraction !== "");
}

// The server's rules for a fund transaction, with its messages, checked before saving.
// `today` is "YYYY-MM-DD" in India.
export function fundTradeErrors(form: FundTradeForm, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.fund_id === "") errors.fund_id = "Choose a fund.";
  if (form.account_id === "") errors.account_id = "Choose a bank account.";
  const date = form.date.trim();
  if (date === "") errors.date = "Choose a date.";
  else if (!realDate(date)) errors.date = "Enter a date like 2026-11-08.";
  else if (date > today) errors.date = "The date can't be in the future.";
  if (!validNumber(form.units.trim(), 3, 15)) errors.units = UNITS_RULE;
  if (form.mode !== "opening" && !validNumber(form.nav.trim(), 4, 10)) errors.nav = NAV_RULE;
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

// What an edit sends: only what changed. Never `side` or `opening`, and no NAV for existing units.
export function changedFundTrade(form: FundTradeForm, original: FundTrade): Record<string, unknown> {
  const before = fundTradePayload(fundTradeFormFrom(original), "edit");
  const after = fundTradePayload(form, "edit");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) result[key] = after[key];
  }
  return result;
}

export function fundTradeTitle(trade: Pick<FundTrade, "opening" | "side" | "units" | "symbol" | "sip_id">): string {
  if (trade.opening) return `Existing ${trade.units} ${trade.symbol}`;
  if (trade.sip_id !== null) return `SIP ${trade.units} ${trade.symbol}`;
  return `${trade.side === "buy" ? "Purchased" : "Redeemed"} ${trade.units} ${trade.symbol}`;
}

export function fundTradeDeleteText(trade: FundTrade): { title: string; body: string } {
  const body = trade.opening
    ? "It's removed for good, and the holding shrinks. This can't be undone."
    : `It's removed for good, and ${trade.account_name}'s cash moves back.${
        trade.sip_id !== null ? " That SIP month becomes due again." : ""
      } This can't be undone.`;
  return { title: `Delete ${fundTradeTitle(trade)} on ${formatDate(trade.date)}?`, body };
}
