// Monthly budgets from `GET /budgets?month=`. Every figure (spent, left, over by, percent, bar) is
// worked out by the server; these helpers only word, order and format them.

import { cleanMoney, formatRupees, splitErrors } from "./accounts.ts";
import { shiftMonth } from "./transactions.ts";

export type BudgetTotals = {
  amount: string;
  spent: string;
  left: string; // amount − spent; negative when over
  remaining: string; // never below 0
  over_by: string;
  percent: number | null; // can pass 100; null for a zero total
  bar: number | null; // percent, capped at 100
  over: boolean;
};

export type BudgetLine = BudgetTotals & {
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
  month: string;
  is_current: boolean;
  start: string;
  through: string;
  budgets: BudgetLine[];
  total: BudgetTotals;
  unbudgeted: Unbudgeted[];
};

// "₹7,200.00 of ₹8,000.00"
export function spentOfText(t: Pick<BudgetTotals, "spent" | "amount">): string {
  return `${formatRupees(t.spent)} of ${formatRupees(t.amount)}`;
}

// "₹800.00 left" or "Over by ₹200.00".
export function leftText(t: Pick<BudgetTotals, "over" | "remaining" | "over_by">): string {
  return t.over ? `Over by ${formatRupees(t.over_by)}` : `${formatRupees(t.remaining)} left`;
}

// What the bar says to a screen reader: "90% used" (the server's percent).
export function usedText(t: Pick<BudgetTotals, "percent">): string {
  return t.percent === null ? "No budget amount" : `${t.percent}% used`;
}

export type BudgetGroup = { line: BudgetLine; children: BudgetLine[] };

// Subcategory budgets sit under their parent's budget; one whose parent has no budget stands on its
// own (and shows its parent's name). Active budgets come first, each part in the server's order.
export function groupBudgets(lines: BudgetLine[]): BudgetGroup[] {
  const tops = new Set(lines.filter((l) => l.parent_id === null).map((l) => l.category_id));
  const groups: BudgetGroup[] = [];
  const byId = new Map<number, BudgetGroup>();
  for (const line of lines) {
    if (line.parent_id !== null && tops.has(line.parent_id)) continue;
    const group = { line, children: [] };
    groups.push(group);
    if (line.parent_id === null) byId.set(line.category_id, group);
  }
  for (const line of lines) {
    if (line.parent_id !== null && tops.has(line.parent_id)) byId.get(line.parent_id)?.children.push(line);
  }
  return [...groups.filter((g) => g.line.active), ...groups.filter((g) => !g.line.active)];
}

// "Food and dining › Dining" for a subcategory, so it's clear which one it is.
export function fullName(c: { name: string; parent_name: string | null }): string {
  return c.parent_name ? `${c.parent_name} › ${c.name}` : c.name;
}

// The "Add a budget" choices: each category not budgeted yet, with what it has spent this month.
export function unbudgetedOptions(list: Unbudgeted[]): { value: string; label: string }[] {
  return list.map((c) => ({ value: String(c.category_id), label: `${fullName(c)} · ${formatRupees(c.spent)} spent` }));
}

// The body of `PUT /budgets/{id}`: the amount as typed, cleaned of ₹ and digit-group commas.
// A blank amount goes as null, so the server's own message says what's missing.
export function budgetPayload(raw: string): { amount: string | null } {
  const cleaned = cleanMoney(raw);
  return { amount: cleaned === "" ? null : cleaned };
}

// The amount as it goes into the edit box: "8000.00" -> "8000".
export function amountInput(amount: string): string {
  return amount.replace(/\.00$/, "");
}

const SAVE_FALLBACK = "We couldn't save that budget. Try again.";

// The API's message for a failed save (a 422's `msg`s, or a 404's `detail`).
export function saveErrorText(body: string): string {
  try {
    const detail = JSON.parse(body)?.detail;
    if (typeof detail === "string") return detail;
  } catch {
    return SAVE_FALLBACK;
  }
  return splitErrors(body, [], SAVE_FALLBACK).general.join(" ");
}

// The month before and after, for the page's navigation. There are no future months.
export function monthNav(data: Pick<BudgetMonth, "month" | "is_current">): { previous: string; next: string | null } {
  return { previous: shiftMonth(data.month, -1), next: data.is_current ? null : shiftMonth(data.month, 1) };
}

export function budgetsHref(month: string, thisMonth: string): string {
  return month === thisMonth ? "/budgets" : `/budgets?month=${month}`;
}

// A budget's spending in that month (a parent's link includes its subcategories). Always
// type=expense, so income under the same name never mixes into the list.
export function budgetLink(month: string, line: Pick<BudgetLine, "name">): string {
  return `/transactions?${new URLSearchParams({ month, category: line.name, type: "expense" })}`;
}

// The month report's category rows look up their active budget by category id.
export function budgetsById(data: BudgetMonth | null): Map<number, BudgetLine> {
  return new Map((data?.budgets ?? []).filter((b) => b.active).map((b) => [b.category_id, b]));
}
