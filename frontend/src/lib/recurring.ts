import { cleanMoney, formatDueDate, formatRupees } from "./accounts.ts";
import type { GoalDue } from "./goals.ts";
import { type TransactionForm, blankForm } from "./transactions.ts";

export type Frequency = "monthly" | "yearly";
export type TemplateType = "expense" | "income" | "transfer";

// Mirrors TemplateResponse in backend/app/api/routes/recurring.py.
export type Template = {
  id: number;
  name: string;
  type: TemplateType;
  amount: string;
  account_id: number;
  account_name: string;
  to_account_id: number | null;
  to_account_name: string | null;
  category: string | null;
  note: string | null;
  frequency: Frequency;
  day: number;
  month: number | null;
  start_date: string;
  end_date: string | null;
  remind_days: number;
  active: boolean;
  policy_id: number | null;
  due: string[];
  coming_up: string | null;
  recorded: number;
  skipped: string[]; // oldest first, for the un-skip button
};

export type DueItem = { template: Template; occurrence: string; state: "due" | "coming_up" };

// Mirrors DueList: reminders due or coming up, and goals with money still to set aside this month.
export type DueList = { items: DueItem[]; goals_due: GoalDue[] };

export type TemplateForm = {
  name: string;
  type: TemplateType;
  amount: string;
  account_id: string;
  to_account_id: string;
  category: string;
  note: string;
  frequency: Frequency;
  day: string;
  month: string;
  start_date: string;
  end_date: string;
  remind_days: string;
  active: boolean;
};

// How many days ahead a date starts showing; mirrors DEFAULT_REMIND on the server.
const DEFAULT_REMIND: Record<Frequency, string> = { monthly: "3", yearly: "30" };

export function templateFormBlank(frequency: Frequency): TemplateForm {
  return {
    name: "",
    type: "expense",
    amount: "",
    account_id: "",
    to_account_id: "",
    category: "",
    note: "",
    frequency,
    day: "",
    month: "",
    start_date: "",
    end_date: "",
    remind_days: DEFAULT_REMIND[frequency],
    active: true,
  };
}

const text = (value: string | null) => value ?? "";

export function templateFormFrom(t: Template): TemplateForm {
  return {
    name: t.name,
    type: t.type,
    amount: t.amount,
    account_id: String(t.account_id),
    to_account_id: t.to_account_id === null ? "" : String(t.to_account_id),
    category: text(t.category),
    note: text(t.note),
    frequency: t.frequency,
    day: String(t.day),
    month: t.month === null ? "" : String(t.month),
    start_date: t.start_date,
    end_date: text(t.end_date),
    remind_days: String(t.remind_days),
    active: t.active,
  };
}

const idOrNull = (raw: string) => (raw === "" ? null : Number(raw));
const numberOrNull = (raw: string) => (raw.trim() === "" ? null : Number(raw));
const textOrNull = (raw: string) => raw.trim() || null;

// The type is fixed once created, so an edit leaves it out. A transfer has no category and the others
// no destination. The month only means something for a yearly template.
export function templatePayload(form: TemplateForm, mode: "create" | "edit"): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (mode === "create") payload.type = form.type;
  payload.name = textOrNull(form.name);
  payload.amount = textOrNull(cleanMoney(form.amount));
  payload.account_id = idOrNull(form.account_id);
  if (form.type === "transfer") payload.to_account_id = idOrNull(form.to_account_id);
  else payload.category = textOrNull(form.category);
  payload.note = textOrNull(form.note);
  payload.frequency = form.frequency;
  payload.day = numberOrNull(form.day);
  payload.month = form.frequency === "yearly" ? numberOrNull(form.month) : null;
  payload.start_date = textOrNull(form.start_date);
  payload.end_date = textOrNull(form.end_date);
  payload.remind_days = numberOrNull(form.remind_days);
  if (mode === "edit") payload.active = form.active;
  return payload;
}

// The transaction a due item records. A late payment keeps its own occurrence's date so it settles that
// month; one only coming up is paid today.
export function transactionFormFromTemplate(t: Template, occurrence: string, today: string): TransactionForm {
  return {
    ...blankForm(t.type, occurrence <= today ? occurrence : today, t.account_id),
    amount: t.amount,
    to_account_id: t.to_account_id === null ? "" : String(t.to_account_id),
    category: t.type === "transfer" ? "" : text(t.category),
    note: text(t.note),
    recurring_template_id: t.id,
  };
}

// Whole rupees drop the ".00".
export const whole = (money: string) => formatRupees(money.replace(/\.00$/, ""));

// "Rent: ₹15,000 due since 1 Mar. Record it." or "...: ₹11,936 coming up on 6 Apr."
export function dueText(item: DueItem): string {
  const { template, occurrence, state } = item;
  const when = formatDueDate(occurrence);
  const tail = state === "due" ? `due since ${when}. Record it.` : `coming up on ${when}.`;
  return `${template.name}: ${whole(template.amount)} ${tail}`;
}

// The Stop/Restart action. A policy's reminder follows the policy (lapsing it stops the reminder), so
// it never offers either.
export function toggleLabel(t: Template): "Stop" | "Restart" | null {
  if (t.policy_id !== null) return null;
  return t.active ? "Stop" : "Restart";
}

// A policy's renewal is never skipped: it is renewed or the policy lapses.
export const canSkip = (item: DueItem) => item.template.policy_id === null;

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffixes: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
  return `${n}${teen ? "th" : (suffixes[n % 10] ?? "th")}`;
}

// "Every month on the 1st" / "Every year on 6 Apr".
export function scheduleText(t: Template): string {
  if (t.frequency === "monthly") return `Every month on the ${ordinal(t.day)}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Every year on ${formatDueDate(`2000-${pad(t.month ?? 1)}-${pad(t.day)}`)}`;
}
