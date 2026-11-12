import { type GoalTag, cleanMoney, formatDueDate, formatRupees } from "./accounts.ts";

// These mirror the response models in backend/app/api/routes/{funds,fund_trades,sips,portfolio}.py.
export type Fund = {
  id: number;
  symbol: string;
  name: string;
  nav: string | null;
  nav_date: string | null;
  source_code: string | null;
};

export type Nav = { id: number; date: string; nav: string; trade_id: number | null; source: "manual" | "auto" };

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

export type FundHolding = FundFigures & { account_id: number; account_name: string; in_goal: GoalTag | null };
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
