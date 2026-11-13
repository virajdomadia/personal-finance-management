// The next 30 days (GET /upcoming) and safe to spend (GET /safe-to-spend). These mirror
// backend/app/api/routes/upcoming.py. The server works out every figure, the running balance
// included; this file only words and arranges them.

import { formatDueDate } from "./accounts.ts";
import { isZero, signedWhole } from "./cash-flow.ts";
import { whole } from "./recurring.ts";

export type UpcomingKind = "recurring" | "insurance" | "emi" | "sip" | "rd" | "card_bill" | "goal";

export type UpcomingItem = {
  date: string;
  kind: UpcomingKind;
  name: string;
  account_id: number | null;
  account_name: string | null;
  amount: string;
  varies: boolean; // a card bill with no statement yet: `amount` is what is owed now
  direction: "out" | "in" | "none";
  overdue: boolean;
  balance_after: string;
  ref_id: number;
};

export type Upcoming = {
  start: string;
  through: string;
  starting_balance: string;
  ending_balance: string;
  items: UpcomingItem[];
};

export type Part = { name: string; amount: string };
export type DuePart = Part & { date: string; kind: UpcomingKind; overdue: boolean; varies: boolean };
export type BudgetPart = Part & { category_id: number; remaining: string; due: string };

export type SafeToSpend = {
  amount: string; // can be negative: money short
  until: string;
  reason: "salary" | "month_end";
  payday: { name: string; date: string } | null;
  note: string | null; // e.g. "Today's salary isn't recorded yet."
  money: string;
  due: string;
  goals: string;
  budgets: string;
  money_items: Part[];
  due_items: DuePart[];
  goal_items: Part[];
  budget_items: BudgetPart[];
};

export const UPCOMING_PATH = "/upcoming";
export const SAFE_TO_SPEND_PATH = "/safe-to-spend";

export const KIND_EMOJI: Record<UpcomingKind, string> = {
  recurring: "🔁",
  insurance: "🛡️",
  emi: "🏦",
  sip: "📈",
  rd: "🐷",
  card_bill: "💳",
  goal: "🎯",
};

export const KIND_LABEL: Record<UpcomingKind, string> = {
  recurring: "Reminder",
  insurance: "Premium",
  emi: "EMI",
  sip: "SIP",
  rd: "RD instalment",
  card_bill: "Card bill",
  goal: "Goal set-aside",
};

const negative = (amount: string) => amount.trim().startsWith("-") && !isZero(amount);
const unsigned = (amount: string) => amount.trim().replace(/^[+-]/, "");

// Whether safe to spend is below zero.
export const isShort = (amount: string) => negative(amount);

// "₹16,200", or "₹3,000 short" for a negative figure.
export function safeText(amount: string): string {
  return negative(amount) ? `${whole(unsigned(amount))} short` : whole(unsigned(amount));
}

// "Until payday, 1 Dec" or "Until 30 Nov, the end of the month".
export function untilText(s: Pick<SafeToSpend, "until" | "reason" | "payday">): string {
  if (s.reason === "salary" && s.payday !== null) return `Until payday on ${formatDueDate(s.payday.date)}`;
  return `Until ${formatDueDate(s.until)}, the end of the month`;
}

// The heading over the dues: payday when there is a salary reminder, else the month end.
export function dueHeading(s: Pick<SafeToSpend, "reason">): string {
  return s.reason === "salary" ? "Due before payday" : "Due before the month ends";
}

export type DayGroup = { date: string; items: UpcomingItem[] };

// The items in the server's order, one group per day.
export function groupByDay(items: UpcomingItem[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.date === item.date) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }
  return groups;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// A day's heading: "Today", "Tomorrow", or "Sat, 21 Nov"; an earlier day says it is overdue.
export function dayHeading(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  const [y, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const label = `${weekday}, ${formatDueDate(date)}`;
  return date < today ? `${label} · overdue` : label;
}

// The amount column: "-₹12,000" out, "+₹50,000" in, "₹5,000" for what moves no money now, and
// "Varies" for a card bill with no statement yet.
export function itemAmountText(item: Pick<UpcomingItem, "amount" | "varies" | "direction">): string {
  if (item.varies) return "Varies";
  const amount = whole(unsigned(item.amount));
  if (item.direction === "out") return `-${amount}`;
  if (item.direction === "in") return `+${amount}`;
  return amount;
}

// The line under an item: what it is, the account, and what it means for the balance.
export function itemDetail(item: UpcomingItem): string[] {
  const lines = [[KIND_LABEL[item.kind], item.account_name].filter(Boolean).join(" · ")];
  if (item.varies) lines.push(`Amount varies: ${whole(unsigned(item.amount))} owed so far`);
  if (item.direction === "none") lines.push("Doesn't change your balance now");
  return lines;
}

// "Balance ₹48,000" (or "-₹2,000") after the item.
export const balanceText = (amount: string) => `Balance ${signedWhole(amount)}`;

export const isNegative = negative;

// What a screen reader hears for one item.
export function itemSpoken(item: UpcomingItem): string {
  return [
    item.name,
    item.overdue ? "overdue" : null,
    ...itemDetail(item),
    item.varies ? null : item.direction === "in" ? `in ${whole(unsigned(item.amount))}` : item.direction === "out" ? `out ${whole(unsigned(item.amount))}` : whole(unsigned(item.amount)),
    balanceText(item.balance_after),
  ]
    .filter(Boolean)
    .join(", ");
}

// A due line of the safe-to-spend breakdown: "Rent · 15 Nov", with overdue and varies said.
export function duePartMeta(d: DuePart): string {
  return [KIND_LABEL[d.kind], formatDueDate(d.date), d.overdue ? "overdue" : null, d.varies ? "amount varies, owed so far" : null]
    .filter(Boolean)
    .join(" · ");
}

// A budget line of the breakdown: "₹20,000 left, less ₹20,000 in bills above", or just what is left.
export function budgetPartMeta(b: BudgetPart): string {
  return isZero(b.due) ? `${whole(b.remaining)} left this month` : `${whole(b.remaining)} left, less ${whole(b.due)} in bills above`;
}
