// A month's cash flow from `GET /cash-flow`, and the transactions search filters. Every figure is
// worked out by the server; these helpers only word and format them.

import { formatRupees } from "./accounts.ts";

export type Change = { amount: string; percent: number | null };

export type CategorySlice = {
  id: number | null;
  name: string;
  icon: string | null;
  colour: string | null;
  amount: string;
  percent: number;
  direct: string;
  children: CategorySlice[];
};

export type CashFlowMonth = {
  month: string;
  is_current: boolean;
  start: string;
  through: string;
  income: string;
  spending: string;
  net: string;
  previous: { month: string; start: string; through: string; income: string; spending: string; net: string };
  income_change: Change;
  spending_change: Change;
  net_change: Change;
  spending_by_category: CategorySlice[];
  income_by_category: CategorySlice[];
  top_spending: CategorySlice[];
  daily: { date: string; spent: string | null; height: number | null }[];
  transaction_count: number;
  earliest_month: string | null;
  previous_month: string | null;
  next_month: string | null;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-12" -> "12 Oct"
export function shortDate(iso: string): string {
  return `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

const isZero = (amount: string) => /^-?0+(\.0+)?$/.test(amount);

// How this month's spending compares: "₹6,200.00 more than 1–12 Oct (+155%)".
// `kind` words it for spending (more is bad) or income.
export function changeText(change: Change, previous: CashFlowMonth["previous"], whole: boolean): string {
  const when = whole ? MONTHS[Number(previous.month.slice(5)) - 1] : `1–${shortDate(previous.through)}`;
  if (isZero(change.amount)) return `Same as ${when}`;
  const less = change.amount.startsWith("-");
  const amount = formatRupees(less ? change.amount.slice(1) : change.amount);
  const percent = change.percent === null ? "" : ` (${less ? "" : "+"}${change.percent}%)`;
  return `${amount} ${less ? "less" : "more"} than ${when}${percent}`;
}

// Whether a change is good news: spending going down, income or net going up.
export function changeTone(change: Change, kind: "spending" | "income"): "good" | "bad" | "same" {
  if (isZero(change.amount)) return "same";
  const down = change.amount.startsWith("-");
  return down === (kind === "spending") ? "good" : "bad";
}

export type SearchFilters = {
  month: string; // "YYYY-MM"; ignored while a date range is set
  q: string;
  accountId: number | null;
  type: "income" | "expense" | "transfer" | "emi" | null;
  category: string;
  from: string; // "YYYY-MM-DD" or ""
  to: string;
  min: string; // amounts as typed, cleaned by the caller
  max: string;
};

export function blankFilters(month: string): SearchFilters {
  return { month, q: "", accountId: null, type: null, category: "", from: "", to: "", min: "", max: "" };
}

export const usesRange = (f: SearchFilters) => f.from !== "" || f.to !== "";

// The API query for one page of matches.
export function searchQuery(f: SearchFilters, limit: number, offset: number): string {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (usesRange(f)) {
    if (f.from) params.set("date_from", f.from);
    if (f.to) params.set("date_to", f.to);
  } else {
    params.set("month", f.month);
  }
  if (f.q.trim()) params.set("q", f.q.trim());
  if (f.accountId !== null) params.set("account_id", String(f.accountId));
  if (f.type !== null) params.set("type", f.type);
  if (f.category) params.set("category", f.category);
  if (f.min.trim()) params.set("amount_min", f.min.trim());
  if (f.max.trim()) params.set("amount_max", f.max.trim());
  return `/transactions?${params}`;
}

const TYPES = new Set(["income", "expense", "transfer", "emi"]);
const MONTH = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

// Filters kept in the page's address, so a search can be bookmarked or linked to from a report.
export function filtersFromParams(params: URLSearchParams, thisMonth: string): SearchFilters {
  const f = blankFilters(thisMonth);
  const month = params.get("month") ?? "";
  if (MONTH.test(month) && month <= thisMonth) f.month = month;
  const account = params.get("account") ?? "";
  if (/^[1-9]\d{0,9}$/.test(account)) f.accountId = Number(account);
  const type = params.get("type") ?? "";
  if (TYPES.has(type)) f.type = type as SearchFilters["type"];
  f.q = (params.get("q") ?? "").slice(0, 100);
  f.category = (params.get("category") ?? "").slice(0, 40);
  for (const key of ["from", "to"] as const) {
    const value = params.get(key) ?? "";
    if (DAY.test(value)) f[key] = value;
  }
  for (const key of ["min", "max"] as const) {
    const value = params.get(key) ?? "";
    if (AMOUNT.test(value)) f[key] = value;
  }
  return f;
}

export function paramsFromFilters(f: SearchFilters, thisMonth: string): string {
  const params = new URLSearchParams();
  if (f.month !== thisMonth && !usesRange(f)) params.set("month", f.month);
  if (f.accountId !== null) params.set("account", String(f.accountId));
  if (f.type !== null) params.set("type", f.type);
  if (f.q.trim()) params.set("q", f.q.trim());
  if (f.category) params.set("category", f.category);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.min.trim()) params.set("min", f.min.trim());
  if (f.max.trim()) params.set("max", f.max.trim());
  const text = params.toString();
  return text ? `?${text}` : "";
}

// A link from the month report to that category's transactions in the month.
export function categoryLink(month: string, category: string, kind: "income" | "expense"): string {
  const params = new URLSearchParams({ month, category });
  if (kind === "income") params.set("type", "income");
  return `/transactions?${params}`;
}

// How many of the extra filters are on (the month and the search box don't count).
export function activeFilterCount(f: SearchFilters): number {
  return [f.accountId !== null, f.type !== null, f.category !== "", usesRange(f), f.min !== "" || f.max !== ""].filter(
    Boolean,
  ).length;
}
