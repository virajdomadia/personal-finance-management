// The month's cash flow: GET /cash-flow. These mirror backend/app/api/routes/cash_flow.py. The server
// does every sum and percentage; this file only words and arranges its figures.

import { formatRupees } from "./accounts.ts";
import { MONTHS } from "./dates.ts";
import { whole } from "./recurring.ts";
import { formatMonth } from "./transactions.ts";

export type Change = {
  amount: string; // signed: this month minus the month before at the same day
  percent: number | null; // signed; null when the month before was 0
};

export type Period = {
  month: string; // "YYYY-MM"
  start: string;
  through: string;
  income: string;
  spending: string;
  net: string;
};

export type CategorySlice = {
  id: number | null; // null for "Uncategorised"
  name: string;
  icon: string | null;
  colour: string | null;
  amount: string;
  percent: number; // of the kind's total
  direct: string; // in the category itself, not a subcategory
  children: CategorySlice[];
};

export type DaySpend = {
  date: string;
  spent: string | null; // null for a day after today
  height: number | null; // percent of the month's biggest day
};

export type CashFlowMonth = {
  month: string;
  is_current: boolean;
  start: string;
  through: string;
  income: string;
  spending: string;
  net: string;
  previous: Period;
  income_change: Change;
  spending_change: Change;
  net_change: Change;
  spending_by_category: CategorySlice[];
  income_by_category: CategorySlice[];
  top_spending: CategorySlice[];
  daily: DaySpend[];
  transaction_count: number;
  earliest_month: string | null;
  previous_month: string | null;
  next_month: string | null;
};

// The current month when `month` is null.
export function cashFlowPath(month: string | null): string {
  return month === null ? "/cash-flow" : `/cash-flow?month=${month}`;
}

// "November 2026".
export const monthLabel = formatMonth;

const ZERO = /^[+-]?0*(\.0*)?$/;

export function isZero(amount: string): boolean {
  return ZERO.test(amount.trim());
}

const unsigned = (amount: string) => amount.trim().replace(/^[+-]/, "");
const negative = (amount: string) => amount.trim().startsWith("-") && !isZero(amount);

// "₹45,000" or "-₹1,200": a signed figure such as the net, without paise when they are .00.
export function signedWhole(amount: string): string {
  return negative(amount) ? `-${whole(unsigned(amount))}` : whole(unsigned(amount));
}

export type ChangeKind = "spending" | "income" | "net";

const NOUN: Record<ChangeKind, string> = { spending: "spending", income: "income", net: "money left" };

// "₹1,200 more than last month by this day", "Same as last month by this day", or, when the month
// before had nothing, "No spending last month by this day".
export function changeText(change: Change, kind: ChangeKind): string {
  if (isZero(change.amount)) return "Same as last month by this day";
  if (change.percent === null && kind !== "net") return `No ${NOUN[kind]} last month by this day`;
  const direction = negative(change.amount) ? "less" : "more";
  return `${whole(unsigned(change.amount))} ${direction} than last month by this day`;
}

// "+12%", "-8%", or null when there is no percentage to show.
export function percentText(change: Change): string | null {
  if (change.percent === null || isZero(change.amount)) return null;
  return change.percent > 0 ? `+${change.percent}%` : `${change.percent}%`;
}

// Whether the change is good news: less spending, more income or more left over. Null for no change.
export function changeTone(change: Change, kind: ChangeKind): "gain" | "loss" | null {
  if (isZero(change.amount)) return null;
  const up = !negative(change.amount);
  return (kind === "spending" ? !up : up) ? "gain" : "loss";
}

// A bar's width, from the server's percent, kept within 0–100.
export function barWidth(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

// "12 Nov": the day under a bar.
export function shortDay(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1].slice(0, 3)}`;
}

// The month's biggest day (the server gives it height 100), or null when nothing was spent.
export function biggestDay(daily: DaySpend[]): DaySpend | null {
  return daily.find((d) => d.height === 100 && d.spent !== null && !isZero(d.spent)) ?? null;
}

// What a screen reader hears for the daily strip.
export function dailySummary(daily: DaySpend[]): string {
  const top = biggestDay(daily);
  if (top === null || top.spent === null) return "Daily spending: nothing spent yet";
  return `Daily spending. Biggest day: ${shortDay(top.date)}, ${formatRupees(top.spent)}`;
}

// The month card's top categories line: "Food and dining · ₹4,500 · 32%".
export function sliceText(slice: CategorySlice): string {
  return `${slice.name} · ${whole(slice.amount)} · ${slice.percent}%`;
}

// Nothing was earned or spent in the month so far.
export function isEmptyMonth(month: Pick<CashFlowMonth, "income" | "spending">): boolean {
  return isZero(month.income) && isZero(month.spending);
}

// The transaction type to filter by when a category of the month is opened. A spending category
// usually needs none (an EMI's interest counts as spending too), but when income has a category of
// the same name, like "Other", the type keeps the two apart.
export function sliceType(
  kind: "spending" | "income",
  name: string,
  data: Pick<CashFlowMonth, "income_by_category">,
): "income" | "expense" | null {
  if (kind === "income") return "income";
  const lower = name.toLowerCase();
  const clash = data.income_by_category.some(
    (s) => s.name.toLowerCase() === lower || s.children.some((c) => c.name.toLowerCase() === lower),
  );
  return clash ? "expense" : null;
}
