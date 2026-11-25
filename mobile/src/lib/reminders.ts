// Due reminders and budget alerts: what to notify, worked out from GET /upcoming and GET /budgets.
// Pure, so it runs under node tests; scheduling and posting them is reminder-schedule.ts. Both are
// local notifications the phone schedules itself, like the weekly summary: no push server.

import type { BudgetLine, BudgetMonth } from "./budgets.ts";
import { formatDueDate } from "./accounts.ts";
import { whole } from "./recurring.ts";
import { KIND_LABEL, type UpcomingItem, type UpcomingKind } from "./upcoming.ts";

export const DUE_CHANNEL = {
  id: "due-reminders-private",
  retiredId: "due-reminders",
  name: "Bills and dues",
  description: "Card bills, EMIs, premiums, SIPs and other payments coming up",
} as const;

export const BUDGET_CHANNEL = {
  id: "budget-alerts-private",
  retiredId: "budget-alerts",
  name: "Budget alerts",
  description: "When a budget is nearly used up or goes over",
} as const;

// Due reminders open the spending calendar. `/upcoming` is still accepted for notifications
// scheduled before it.
export const CALENDAR_URL = "/calendar";
export const UPCOMING_URL = "/upcoming";
// What the calendar shows (reminders and premiums); other bills (cards, EMIs, deposits, SIPs) are on Upcoming.
const ON_CALENDAR = new Set(["recurring", "insurance"]);
export const BUDGETS_URL = "/budgets";

// Whether each kind is on, kept per phone. Off until turned on in Profile.
export const DUE_PREF_KEY = "gullak.due-reminders";
export const BUDGET_PREF_KEY = "gullak.budget-alerts";
// The budget alerts already sent this month, so each is sent once.
export const BUDGET_SENT_KEY = "gullak.budget-alerts-sent";

// Reminders go out at 9 am, phone time.
export const REMIND_HOUR = 9;
// Every due reminder carries this prefix, so a reschedule can clear the old ones without touching
// the weekly summary or SMS notices.
export const DUE_ID_PREFIX = "due-";
// Android caps scheduled alarms per app; 30 days of dues stays far below this.
export const MAX_DUE = 60;

// Goal set-asides move no money and are already on the dashboard; they aren't reminded.
const SKIPPED: ReadonlySet<UpcomingKind> = new Set(["goal"]);
// A premium is reminded a week ahead too: a missed one can lapse the policy.
const WEEK_AHEAD: ReadonlySet<UpcomingKind> = new Set(["insurance"]);

export type DueReminder = { id: string; at: Date; title: string; body: string; url: string };

function addDays(iso: string, days: number): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d + days, REMIND_HOUR, 0, 0, 0);
}

const unsigned = (amount: string) => amount.trim().replace(/^[+-]/, "");

// "₹12,000", or "₹8,400 so far" for a card bill with no statement yet.
function amountText(item: Pick<UpcomingItem, "amount" | "varies">): string {
  const amount = whole(unsigned(item.amount));
  return item.varies ? `${amount} so far` : amount;
}

function when(lead: number, date: string): string {
  if (lead === 0) return "today";
  if (lead === 1) return "tomorrow";
  return `on ${formatDueDate(date)}`;
}

// The title and body for one item, `lead` days before it.
export function dueText(item: UpcomingItem, lead: number): { title: string; body: string } {
  const label = KIND_LABEL[item.kind];
  const day = when(lead, item.date);
  const from = item.account_name ? ` from ${item.account_name}` : "";
  const into = item.account_name ? ` into ${item.account_name}` : "";
  const amount = amountText(item);
  switch (item.kind) {
    case "fd":
      return { title: `${item.name} matures ${day}`, body: `${amount} due back. Close or renew it in the app.` };
    case "fd_interest":
      return { title: `FD interest ${day}`, body: `${amount} from ${item.name}${into}.` };
    case "card_bill":
      return { title: `${item.name} bill due ${day}`, body: item.varies ? `${whole(unsigned(item.amount))} owed so far. Pay it before the due date.` : `${amount} to pay.` };
    case "insurance":
      return { title: `${item.name} premium due ${day}`, body: `${amount}. Pay on time so the policy doesn't lapse.` };
    default:
      if (item.direction === "in") return { title: `${item.name} expected ${day}`, body: `${amount}${into}.` };
      return { title: `${label} due ${day}: ${item.name}`, body: `${amount}${from}. Keep the balance ready.` };
  }
}

// One id per item and lead time, stable across reschedules.
export function dueId(item: Pick<UpcomingItem, "kind" | "ref_id" | "date">, lead: number): string {
  return `${DUE_ID_PREFIX}${item.kind}-${item.ref_id}-${item.date}-${lead}`;
}

// The reminders to schedule from the next 30 days, soonest first: at 9 am the day before and on the
// day, and a week before for a premium. Overdue items and times already past are left out; the
// dashboard shows what is overdue.
export function planDueReminders(items: UpcomingItem[], now: Date): DueReminder[] {
  const out: DueReminder[] = [];
  for (const item of items) {
    if (item.overdue || SKIPPED.has(item.kind)) continue;
    const leads = WEEK_AHEAD.has(item.kind) ? [7, 1, 0] : [1, 0];
    for (const lead of leads) {
      const at = addDays(item.date, -lead);
      if (at.getTime() <= now.getTime()) continue;
      out.push({ id: dueId(item, lead), at, ...dueText(item, lead), url: ON_CALENDAR.has(item.kind) ? CALENDAR_URL : UPCOMING_URL });
    }
  }
  out.sort((a, b) => a.at.getTime() - b.at.getTime());
  return out.slice(0, MAX_DUE);
}

// ---- Budget alerts ----

export const NEAR_PERCENT = 80;

export type BudgetLevel = "near" | "over";
export type BudgetAlert = { id: string; key: string; title: string; body: string; url: string };
export type SentBudgetAlerts = { month: string; keys: string[] };

export function budgetLevel(line: Pick<BudgetLine, "over" | "percent" | "active">): BudgetLevel | null {
  if (!line.active || line.percent === null) return null;
  if (line.over) return "over";
  return line.percent >= NEAR_PERCENT ? "near" : null;
}

// "12:near": the category and the level, once per month.
export const alertKey = (categoryId: number, level: BudgetLevel) => `${categoryId}:${level}`;

function daysLeft(through: string, now: Date): number {
  const [y, m, d] = through.split("-").map(Number);
  const end = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((end.getTime() - today.getTime()) / 86_400_000));
}

export function budgetText(line: BudgetLine, level: BudgetLevel, through: string, now: Date): { title: string; body: string } {
  if (level === "over") {
    return { title: `${line.name} is over budget`, body: `Over by ${whole(line.over_by)}: ${whole(line.spent)} spent of ${whole(line.amount)} this month.` };
  }
  const days = daysLeft(through, now);
  const rest = days === 0 ? "today" : `${days} ${days === 1 ? "day" : "days"}`;
  return { title: `${line.name}: ${line.percent}% of budget used`, body: `${whole(line.remaining)} left for ${rest}.` };
}

// The sent list for `month`: last month's keys are dropped when a new month starts.
export function sentFor(sent: SentBudgetAlerts | null, month: string): SentBudgetAlerts {
  return sent !== null && sent.month === month ? sent : { month, keys: [] };
}

// New alerts for the current month, and the sent list to keep after posting them. "Over" covers
// "near": a budget that jumped straight past 100% gets only the over alert, and won't get the
// near one later. Only the current month is alerted.
export function planBudgetAlerts(
  book: Pick<BudgetMonth, "month" | "is_current" | "through" | "budgets">,
  sent: SentBudgetAlerts | null,
  now: Date,
): { alerts: BudgetAlert[]; sent: SentBudgetAlerts } {
  const current = sentFor(sent, book.month);
  if (!book.is_current) return { alerts: [], sent: current };
  const keys = new Set(current.keys);
  const alerts: BudgetAlert[] = [];
  for (const line of book.budgets) {
    const level = budgetLevel(line);
    if (level === null) continue;
    const key = alertKey(line.category_id, level);
    if (keys.has(key)) continue;
    keys.add(key);
    if (level === "over") keys.add(alertKey(line.category_id, "near"));
    alerts.push({
      id: `budget-${book.month}-${key.replace(":", "-")}`,
      key,
      ...budgetText(line, level, book.through, now),
      url: BUDGETS_URL,
    });
  }
  return { alerts, sent: { month: book.month, keys: [...keys] } };
}

export function parseSent(raw: string | null): SentBudgetAlerts | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<SentBudgetAlerts>;
    if (typeof value.month !== "string" || !Array.isArray(value.keys)) return null;
    return { month: value.month, keys: value.keys.filter((k): k is string => typeof k === "string") };
  } catch {
    return null;
  }
}

export const parsePref = (raw: string | null): boolean => raw === "on";
export const prefValue = (on: boolean): string => (on ? "on" : "off");

// Where a tapped reminder or alert goes: only these two routes, whatever else is in `data`.
export function reminderTarget(data: unknown): typeof CALENDAR_URL | typeof UPCOMING_URL | typeof BUDGETS_URL | null {
  if (typeof data !== "object" || data === null) return null;
  const url = (data as { url?: unknown }).url;
  return url === CALENDAR_URL || url === UPCOMING_URL || url === BUDGETS_URL ? url : null;
}
