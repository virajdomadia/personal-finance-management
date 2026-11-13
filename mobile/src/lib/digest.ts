// The weekly digest (GET /digest), mirroring backend/app/api/routes/digest.py, and the weekly
// summary notification's settings. The server works out every figure, the budgets at risk and the
// headline; this file only words them. Nothing here touches a native module, so it is testable.

import { formatDueDate } from "./accounts.ts";
import { whole } from "./recurring.ts";
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

export const DIGEST_PATH = "/digest";

// The last whole week (the server's default) or this week so far.
export function digestPath(soFar: boolean): string {
  return soFar ? `${DIGEST_PATH}?week=current` : DIGEST_PATH;
}

// A SecureStore key (letters, digits, ".", "-", "_"), per signed-in user and per week.
export function hiddenKey(userId: number, weekStart: string): string {
  return `gullak.digest-hidden.${userId}.${weekStart}`;
}

// "2–8 Nov", or "30 Nov – 6 Dec" across a month.
export function weekRange(start: string, end: string): string {
  const [from, to] = [formatDueDate(start), formatDueDate(end)];
  const [fromDay, fromMonth] = from.split(" ");
  return fromMonth === to.split(" ")[1] ? `${fromDay}–${to}` : `${from} – ${to}`;
}

export type Tone = "more" | "less" | "same";

// The badge from the server's tone (never re-derived from the rounded percent): "▲ ₹600 · 16%",
// "▼ ₹650 · 18%", "≈ usual", or null with nothing to compare.
export function changeBadge(d: Pick<Digest, "change" | "tone">): string | null {
  if (d.change === null || d.tone === null) return null;
  if (d.tone === "same") return "≈ usual";
  const amount = whole(d.change.amount.trim().replace(/^-/, ""));
  const percent = d.change.percent === null ? "" : ` · ${Math.abs(d.change.percent)}%`;
  return `${d.tone === "more" ? "▲" : "▼"} ${amount}${percent}`;
}

// The first tab of the digest screen: "Last week", or "This week" from Sunday 6 pm, when the
// server's default week is this one and "This week so far" would show the same days.
export function weekTabLabel(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function usualText(d: Pick<Digest, "usual" | "usual_weeks">): string {
  if (d.usual === null) return "Not enough history to compare yet";
  const weeks = d.usual_weeks === 1 ? "the week before" : `${d.usual_weeks}-week average`;
  return `Usually ${whole(d.usual)} (${weeks})`;
}

export function riskText(r: Pick<AtRisk, "status" | "amount" | "over_by" | "projected">): string {
  return r.status === "over" ? `Over by ${whole(r.over_by)}` : `On pace for ${whole(r.projected)} of ${whole(r.amount)}`;
}

// The dashboard card's one-liners.
export function riskSummary(d: { budgets: { at_risk: Pick<AtRisk, "status">[] } }): string {
  const n = d.budgets.at_risk.length;
  if (n === 0) return "Budgets on track";
  const over = d.budgets.at_risk.filter((r) => r.status === "over").length;
  const noun = n === 1 ? "budget" : "budgets";
  return over === n ? `${n} ${noun} over` : `${n} ${noun} at risk`;
}

export function dueSummary(d: { due: { through: string; total: string; items: unknown[] } }): string {
  const n = d.due.items.length;
  if (n === 0) return `Nothing due by ${formatDueDate(d.due.through)}`;
  return `${n} due by ${formatDueDate(d.due.through)} · ${whole(d.due.total)} out`;
}

// The weekly summary notification: local, repeating, Sunday 7 pm on the phone's clock. Its text is
// generic because a local notification can't fetch figures; tapping it opens the digest screen.
export const WEEKLY_SUMMARY = {
  id: "weekly-summary",
  channelId: "weekly-summary",
  channelName: "Weekly summary",
  weekday: 1, // expo-notifications counts 1 = Sunday
  hour: 19,
  minute: 0,
  title: "Your week in money is ready",
  body: "See what you spent, budgets at risk and what's due next.",
  url: "/digest",
} as const;

// Whether the user turned the summary on, kept per phone.
export const SUMMARY_PREF_KEY = "gullak.weekly-summary";
export const parseSummaryPref = (raw: string | null): boolean => raw === "on";
export const summaryPrefValue = (on: boolean): string => (on ? "on" : "off");

// Where a tapped notification should go: only our own digest route, whatever else is in `data`.
export function notificationTarget(data: unknown): "/digest" | null {
  if (typeof data !== "object" || data === null) return null;
  return (data as { url?: unknown }).url === WEEKLY_SUMMARY.url ? WEEKLY_SUMMARY.url : null;
}
