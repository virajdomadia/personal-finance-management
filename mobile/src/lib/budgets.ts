// Monthly budgets: GET /budgets, PUT and DELETE /budgets/{category_id}. These mirror
// backend/app/api/routes/budgets.py. The server works out every figure (spent, left, percent, bar);
// this file only words and arranges them.

import { cleanMoney, splitErrors } from "./accounts.ts";
import { amountError, whole } from "./recurring.ts";
import { formatMonth } from "./transactions.ts";

export type Totals = {
  amount: string;
  spent: string;
  left: string; // amount − spent; negative when over
  remaining: string; // never below 0
  over_by: string;
  percent: number | null; // can pass 100; null for a zero total
  bar: number | null; // percent, capped at 100
  over: boolean;
};

export type BudgetLine = Totals & {
  category_id: number;
  name: string;
  icon: string | null;
  colour: string | null;
  parent_id: number | null;
  parent_name: string | null;
  active: boolean;
  note: string | null; // why it's inactive
  counted: boolean; // in the total
  since: string; // "YYYY-MM"
};

export type Unbudgeted = {
  category_id: number;
  name: string;
  icon: string | null;
  colour: string | null;
  parent_id: number | null;
  parent_name: string | null;
  spent: string;
};

export type BudgetMonth = {
  month: string; // "YYYY-MM"
  is_current: boolean;
  start: string;
  through: string;
  budgets: BudgetLine[];
  total: Totals;
  unbudgeted: Unbudgeted[];
};

export const BUDGETS_PATH = "/budgets";

// The current month when `month` is null.
export function budgetsPath(month: string | null): string {
  return month === null ? BUDGETS_PATH : `${BUDGETS_PATH}?month=${month}`;
}

export const budgetPath = (categoryId: number | string) => `${BUDGETS_PATH}/${categoryId}`;

// "November 2026".
export const budgetMonthLabel = formatMonth;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

// Whether `text` is a "YYYY-MM" month the API would take.
export function isMonth(text: string | undefined): text is string {
  return text !== undefined && MONTH.test(text) && text >= "1000-01";
}

// The month before "2026-01" is "2025-12".
export function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5));
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, "0")}`;
}

// The month after; the screen only asks for it when the shown month isn't the current one.
export function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5));
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
}

export type BudgetGroup = { line: BudgetLine; children: BudgetLine[] };

// Budgets in the server's order, with a subcategory's budget under its parent's when the parent has
// one too. A subcategory whose parent has no budget stands on its own.
export function budgetGroups(budgets: BudgetLine[]): BudgetGroup[] {
  const ids = new Set(budgets.map((b) => b.category_id));
  const groups: BudgetGroup[] = [];
  const byId = new Map<number, BudgetGroup>();
  for (const b of budgets) {
    if (b.parent_id !== null && ids.has(b.parent_id)) continue;
    const group = { line: b, children: [] };
    groups.push(group);
    byId.set(b.category_id, group);
  }
  for (const b of budgets) {
    if (b.parent_id !== null && ids.has(b.parent_id)) byId.get(b.parent_id)?.children.push(b);
  }
  return groups;
}

// "₹7,200 of ₹8,000".
export function spentOfText(t: Pick<Totals, "spent" | "amount">): string {
  return `${whole(t.spent)} of ${whole(t.amount)}`;
}

// "₹800 left" or "Over by ₹200".
export function leftText(t: Pick<Totals, "over" | "over_by" | "remaining">): string {
  return t.over ? `Over by ${whole(t.over_by)}` : `${whole(t.remaining)} left`;
}

// "90%", or "–" when there is no percentage (a zero total).
export function percentText(t: Pick<Totals, "percent">): string {
  return t.percent === null ? "–" : `${t.percent}%`;
}

// A bar's fill, from the server's capped `bar`, kept within 0–100.
export function barFill(t: Pick<Totals, "bar">): number {
  if (t.bar === null || !Number.isFinite(t.bar)) return 0;
  return Math.max(0, Math.min(100, Math.round(t.bar)));
}

// What a screen reader hears for one budget.
export function budgetSpoken(b: BudgetLine): string {
  return [
    b.name,
    b.parent_name && b.parent_id !== null ? `in ${b.parent_name}` : null,
    `${spentOfText(b)} spent`,
    leftText(b),
    b.percent === null ? null : `${b.percent}% used`,
    b.active ? null : (b.note ?? "inactive"),
  ]
    .filter(Boolean)
    .join(", ");
}

// "₹1,200 spent this month", "Nothing spent this month", or for a past month "in October".
export function unbudgetedSpentText(u: Pick<Unbudgeted, "spent">, isCurrent: boolean): string {
  const when = isCurrent ? "this month" : "that month";
  return /^[+-]?0*(\.0*)?$/.test(u.spent.trim()) ? `Nothing spent ${when}` : `${whole(u.spent)} spent ${when}`;
}

// A budget amount as typed, checked the way the server checks it, or null when it is fine.
export function budgetAmountError(raw: string): string | null {
  return amountError(raw, "Enter the budget amount.");
}

export function budgetPayload(raw: string): { amount: string } {
  return { amount: cleanMoney(raw) };
}

// The server's words for a rejected budget: the amount's own message, or the first other one.
export function budgetErrorText(detail: unknown): { amount: string | null; general: string[] } {
  const { fields, general } = splitErrors(detail, ["amount"]);
  return { amount: fields.amount ?? null, general };
}

// What the form starts with: "8000" for "8000.00", "8000.5" kept as "8000.50".
export function amountInput(amount: string | undefined): string {
  if (amount === undefined || amount === "") return "";
  return amount.replace(/\.00$/, "");
}
