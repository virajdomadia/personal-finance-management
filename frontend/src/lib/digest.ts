// The weekly digest (`GET /digest`). The server works out every figure, the budgets at risk and the
// headline sentence; these helpers only word, format and remember a dismissal.

import { formatDueDate, formatRupees } from "./accounts.ts";
import type { UpcomingItem } from "./upcoming.ts";

export type DigestSlice = {
  id: number | null;
  name: string;
  icon: string | null;
  colour: string | null;
  amount: string;
  percent: number;
};

export type AtRisk = {
  category_id: number;
  name: string;
  icon: string | null;
  colour: string | null;
  amount: string;
  spent: string;
  percent: number | null;
  bar: number | null;
  status: "over" | "on_pace";
  over_by: string;
  projected: string;
};

export type Digest = {
  user_id: number;
  week_start: string;
  week_end: string;
  through: string;
  is_current: boolean;
  is_complete: boolean;
  label: string;
  spending: string;
  usual: string | null;
  usual_weeks: number;
  change: { amount: string; percent: number | null } | null;
  tone: Tone | null; // the server's exact ±5% comparison; null with no usual figure
  top_spending: DigestSlice[];
  budgets: {
    month: string;
    through: string;
    days: number;
    days_in_month: number;
    elapsed_percent: number;
    at_risk: AtRisk[];
  };
  due: { start: string; through: string; total: string; items: UpcomingItem[] };
  headline: string;
};

// Kept per signed-in user and per week, so next week's digest shows again and family members
// sharing a browser each keep their own.
export function digestKey(userId: number, weekStart: string): string {
  return `gullak.digest-hidden.${userId}.${weekStart}`;
}

// "2–8 Nov", or "30 Nov – 6 Dec" across a month.
export function weekRange(start: string, end: string): string {
  const [from, to] = [formatDueDate(start), formatDueDate(end)];
  const [fromDay, fromMonth] = from.split(" ");
  return fromMonth === to.split(" ")[1] ? `${fromDay}–${to}` : `${from} – ${to}`;
}

export type Tone = "more" | "less" | "same";

// "₹600.00 more than usual (16%)", "₹650.00 less than usual (18%)" or "About the same as usual",
// worded from the server's tone (never re-derived from the rounded percent).
export function changeLine(d: Pick<Digest, "change" | "tone">): string | null {
  if (d.change === null || d.tone === null) return null;
  if (d.tone === "same") return "About the same as usual";
  const amount = formatRupees(d.change.amount.replace(/^-/, ""));
  const percent = d.change.percent === null ? "" : ` (${Math.abs(d.change.percent)}%)`;
  return `${amount} ${d.tone} than usual${percent}`;
}

// "Usual: ₹3,650.00 (4-week average)", fewer weeks said as they are.
export function usualLine(d: Pick<Digest, "usual" | "usual_weeks">): string {
  if (d.usual === null) return "Not enough history to compare yet";
  const weeks = d.usual_weeks === 1 ? "last week" : `${d.usual_weeks}-week average`;
  return `Usual: ${formatRupees(d.usual)} (${weeks})`;
}

export function riskText(r: AtRisk): string {
  return r.status === "over"
    ? `Over by ${formatRupees(r.over_by)}`
    : `On pace for ${formatRupees(r.projected)} of ${formatRupees(r.amount)}`;
}

// The month report for the month the budgets were judged in.
export function monthHref(d: Pick<Digest, "budgets">): string {
  return `/cash-flow?month=${d.budgets.month}`;
}

export function dueLine(d: Pick<Digest, "due">): string {
  const n = d.due.items.length;
  if (n === 0) return `Nothing due by ${formatDueDate(d.due.through)}`;
  return `${n} ${n === 1 ? "thing" : "things"} due by ${formatDueDate(d.due.through)}, ${formatRupees(d.due.total)} going out`;
}
