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
  type: "income" | "expense" | "transfer" | "emi" | "refund" | "adjustment" | null;
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

// The type to filter by when a category of the month is opened, so the list adds up to the
// report. Spending usually needs none (an EMI's interest counts as spending too), but when income
// has a category of the same name this month, like "Other" or "Uncategorised", "expense" keeps the
// two apart. Mirrors sliceType in mobile/src/lib/cash-flow.ts.
export function sliceType(
  kind: "income" | "expense",
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

// A link from the month report to that category's transactions in the month.
export function categoryLink(
  month: string,
  category: string,
  kind: "income" | "expense",
  data: Pick<CashFlowMonth, "income_by_category">,
): string {
  const params = new URLSearchParams({ month, category });
  const type = sliceType(kind, category, data);
  if (type !== null) params.set("type", type);
  return `/transactions?${params}`;
}

// How many of the extra filters are on (the month and the search box don't count).
export function activeFilterCount(f: SearchFilters): number {
  return [f.accountId !== null, f.type !== null, f.category !== "", usesRange(f), f.min !== "" || f.max !== ""].filter(
    Boolean,
  ).length;
}

// --- Spend calendar (`GET /calendar`) --------------------------------------------------------

export type FixedLine = {
  id: number;
  source: "reminder" | "sip";
  name: string;
  kind: "income" | "out";
  type: string;
  amount: string;
  day: number;
  account_id: number;
};

export type CalendarDay = { date: string; spent: string | null; over: boolean | null };

export type SpendCalendar = {
  month: string;
  is_current: boolean;
  through: string;
  income: string;
  fixed_out: string;
  free: string;
  per_day: string | null;
  spent: string;
  left: string;
  pace: string | null;
  fixed: FixedLine[];
  days: CalendarDay[];
  marks: Mark[];
  previous_month: string | null;
  next_month: string | null;
};

// A reminder's occurrence on a day of the month.
export type Mark = {
  date: string;
  template_id: number;
  name: string;
  amount: string;
  kind: "income" | "out";
  state: "paid" | "skipped" | "due" | "coming";
};

export function marksByDate(marks: Mark[]): Map<string, Mark[]> {
  const byDate = new Map<string, Mark[]>();
  for (const m of marks) byDate.set(m.date, [...(byDate.get(m.date) ?? []), m]);
  return byDate;
}

// "Rent ₹16,000 paid", "Salary ₹54,800 received".
export function markText(m: Mark): string {
  const amount = formatRupees(m.amount.replace(/\.00$/, ""));
  const state = m.state === "paid" && m.kind === "income" ? "received" : m.state;
  return `${m.name} ${amount} ${state}`;
}

const URGENCY: Record<Mark["state"], number> = { due: 0, coming: 1, paid: 2, skipped: 3 };

// The one mark a narrow day cell shows (the most urgent) and how many more there are.
export function leadMark(marks: Mark[]): { mark: Mark; more: number } | null {
  if (marks.length === 0) return null;
  const mark = marks.reduce((best, m) => (URGENCY[m.state] < URGENCY[best.state] ? m : best));
  return { mark, more: marks.length - 1 };
}

// The calendar's two reminder lists: fixed money (active monthly) and the rest (yearly or stopped).
export function splitTemplates<T extends { frequency: string; active: boolean }>(templates: T[]): { fixed: T[]; other: T[] } {
  const isFixed = (t: T) => t.active && t.frequency === "monthly";
  return { fixed: templates.filter(isFixed), other: templates.filter((t) => !isFixed(t)) };
}

export const calendarPath = (month: string | null) => (month ? `/calendar?month=${month}` : "/calendar");

// The month as Monday-first weeks of seven, padded with nulls before the 1st and after the last.
export function calendarWeeks(days: CalendarDay[]): (CalendarDay | null)[][] {
  if (days.length === 0) return [];
  const [y, m, d] = days[0].date.split("-").map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  const cells: (CalendarDay | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (CalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// A short amount for a narrow cell: ₹420, ₹1.2k, ₹1.3L. Rounded half up.
export function shortRupees(amount: string): string {
  const negative = amount.startsWith("-");
  const value = Math.abs(Number(amount));
  const one = (n: number) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");
  let text: string;
  if (value >= 100000) text = `₹${one(value / 100000)}L`;
  else if (value >= 1000) text = `₹${one(value / 1000)}k`;
  else text = formatRupees(String(Math.round(value)));
  return `${negative ? "−" : ""}${text}`;
}

export function dayTone(day: CalendarDay): "over" | "under" | "plain" | "future" {
  if (day.spent === null) return "future";
  if (day.over === null) return "plain";
  return day.over ? "over" : "under";
}

export const dayTransactionsHref = (date: string) => `/transactions?from=${date}&to=${date}`;

export function paceText(pace: string | null): string | null {
  if (pace === null) return null;
  if (isZero(pace)) return "Right on pace";
  const over = pace.startsWith("-");
  const amount = formatRupees(String(Math.round(Math.abs(Number(pace)))));
  return `${amount} ${over ? "over" : "under"} pace`;
}
