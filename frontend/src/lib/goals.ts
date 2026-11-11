import { type Account, cleanMoney } from "./accounts.ts";
import { whole } from "./recurring.ts";

export type GoalKind = "custom" | "emergency";
export type EarmarkAction = "set_aside" | "release";

// These mirror the response models in backend/app/api/goals.py and backend/app/api/routes/goals.py.
export type EmergencyFigures = {
  months: number;
  monthly: string | null; // the figure used: the override if set, else the computed one
  computed: string | null;
  override: string | null;
  window: string[]; // the months averaged, "YYYY-MM", oldest first
};

export type EarmarkLine = { account_id: number; account_name: string; amount: string };

export type HoldingLine = {
  id: number;
  kind: "stock" | "mutual_fund" | "crypto" | "ppf" | "rd";
  instrument_id: number | null;
  account_id: number | null;
  name: string;
  value: string;
  status: "held" | "sold" | "closed";
  note: string | null;
};

export type Goal = {
  id: number;
  name: string;
  kind: GoalKind;
  target: string | null;
  target_date: string | null;
  note: string | null;
  archived: boolean;
  ef: EmergencyFigures | null;
  monthly_amount: string | null;
  reminder_day: number | null;
  saved: string;
  earmarked: string;
  holdings_value: string;
  percent: number | null;
  reached: boolean;
  months_left: number | null;
  per_month: string | null;
  overdue: boolean;
  earmarks: EarmarkLine[];
  holdings: HoldingLine[];
  warnings: string[];
};

export type HistoryLine = {
  id: number;
  account_id: number;
  account_name: string;
  amount: string; // negative for a release
  date: string;
  note: string | null;
};

export type GoalDetail = Goal & { history: HistoryLine[] };
export type GoalList = { goals: Goal[] };

// A goal on the dashboard.
export type GoalCard = {
  id: number;
  name: string;
  kind: string;
  saved: string;
  target: string | null;
  percent: number | null;
  reached: boolean;
};

export type GoalDue = {
  goal_id: number;
  name: string;
  amount: string; // what is left to set aside this month
  due_since: string;
};

export type GoalForm = {
  name: string;
  kind: GoalKind;
  target_amount: string;
  target_date: string;
  ef_months: string;
  ef_monthly_override: string;
  monthly_amount: string;
  reminder_day: string;
  note: string;
};

// Mirrors DEFAULT_EF_MONTHS on the server.
const DEFAULT_EF_MONTHS = "6";

export function goalFormBlank(kind: GoalKind): GoalForm {
  return {
    name: "",
    kind,
    target_amount: "",
    target_date: "",
    ef_months: kind === "emergency" ? DEFAULT_EF_MONTHS : "",
    ef_monthly_override: "",
    monthly_amount: "",
    reminder_day: "",
    note: "",
  };
}

const text = (value: string | null) => value ?? "";

export function goalFormFrom(g: Goal): GoalForm {
  const emergency = g.kind === "emergency";
  return {
    name: g.name,
    kind: g.kind,
    // The emergency fund's target is worked out, so it is not a field.
    target_amount: emergency ? "" : text(g.target),
    target_date: text(g.target_date),
    ef_months: g.ef ? String(g.ef.months) : "",
    ef_monthly_override: text(g.ef?.override ?? null),
    monthly_amount: text(g.monthly_amount),
    reminder_day: g.reminder_day === null ? "" : String(g.reminder_day),
    note: text(g.note),
  };
}

const textOrNull = (raw: string) => raw.trim() || null;
const moneyOrNull = (raw: string) => textOrNull(cleanMoney(raw));
const numberOrNull = (raw: string) => (raw.trim() === "" ? null : Number(raw));

// The kind is fixed once created, so an edit leaves it out. Only the fields that apply to the kind are
// sent: a custom goal has a target, the emergency fund months and an optional monthly figure. The
// reminder day means nothing without a monthly amount.
export function goalPayload(form: GoalForm, mode: "create" | "edit"): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (mode === "create") payload.kind = form.kind;
  payload.name = textOrNull(form.name);
  if (form.kind === "custom") payload.target_amount = moneyOrNull(form.target_amount);
  payload.target_date = textOrNull(form.target_date);
  if (form.kind === "emergency") {
    payload.ef_months = numberOrNull(form.ef_months);
    payload.ef_monthly_override = moneyOrNull(form.ef_monthly_override);
  }
  const monthly = moneyOrNull(form.monthly_amount);
  payload.monthly_amount = monthly;
  payload.reminder_day = monthly === null ? null : numberOrNull(form.reminder_day);
  payload.note = textOrNull(form.note);
  return payload;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortMonth = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1];

// "₹45,500 of ₹1,20,000 · 38%", "₹1,30,000 saved · Reached", or "₹45,500 saved" with no target.
export function progressText(g: Pick<Goal, "saved" | "target" | "reached" | "percent">): string {
  if (g.target === null) return `${whole(g.saved)} saved`;
  if (g.reached) return `${whole(g.saved)} saved · Reached`;
  return `${whole(g.saved)} of ${whole(g.target)} · ${g.percent ?? 0}%`;
}

// "6 months × ₹32,400 (average of Jun–Oct)" / "... (your figure)" / the not-enough-history prompt.
export function efText(g: Goal): string {
  const ef = g.ef;
  if (ef === null) return "";
  if (ef.monthly === null) return "Not enough history yet: enter your monthly expenses";
  const unit = ef.months === 1 ? "month" : "months";
  let source = "your figure";
  if (ef.override === null) {
    const first = shortMonth(ef.window[0]);
    const last = shortMonth(ef.window[ef.window.length - 1]);
    source = `average of ${first === last ? first : `${first}–${last}`}`;
  }
  return `${ef.months} ${unit} × ${whole(ef.monthly)} (${source})`;
}

// "Set aside ₹9,313 a month to reach it by Jun 2027", or null when there is nothing to say.
export function paceText(g: Goal): string | null {
  if (g.overdue) return "The target date has passed";
  if (g.reached || g.target_date === null || g.per_month === null) return null;
  const [year, month] = g.target_date.split("-");
  return `Set aside ${whole(g.per_month)} a month to reach it by ${MONTHS[Number(month) - 1]} ${year}`;
}

type Balances = Pick<Account, "type" | "balance" | "set_aside">;

const HELD_IN: Record<string, string> = { cash: "in cash", wallet: "in the wallet" };

// "₹80,000 in the bank · ₹50,000 set aside for goals" (cash: "in cash", wallet: "in the wallet"), or null when nothing is set aside here.
export function freeBalanceText(a: Balances): string | null {
  if (a.set_aside === "0.00") return null;
  return `${whole(a.balance)} ${HELD_IN[a.type] ?? "in the bank"} · ${whole(a.set_aside)} set aside for goals`;
}

// When more is set aside than the account holds (the free balance is negative).
export function overSetAsideText(a: Pick<Account, "name" | "free_balance">): string | null {
  if (!a.free_balance.startsWith("-")) return null;
  return `${whole(a.free_balance.slice(1))} more is set aside than ${a.name} holds.`;
}

export function goalDueText(d: GoalDue): string {
  return `Set aside ${whole(d.amount)} for ${d.name} this month.`;
}

export type EarmarkForm = {
  goal_id: number;
  action: EarmarkAction;
  account_id: string;
  amount: string;
  date: string;
  note: string;
};

export function earmarkFormBlank(goalId: number, action: EarmarkAction, today: string): EarmarkForm {
  return { goal_id: goalId, action, account_id: "", amount: "", date: today, note: "" };
}

export function earmarkPayload(form: EarmarkForm): Record<string, unknown> {
  return {
    account_id: form.account_id === "" ? null : Number(form.account_id),
    action: form.action,
    amount: moneyOrNull(form.amount),
    date: textOrNull(form.date),
    note: textOrNull(form.note),
  };
}

// "sold" or "closed" for a holding no longer held, else null.
export function statusLabel(h: Pick<HoldingLine, "status">): "sold" | "closed" | null {
  return h.status === "held" ? null : h.status;
}

// The holding's name, marked when it is sold or closed: "TCS (sold)".
export function holdingName(h: Pick<HoldingLine, "name" | "status">): string {
  const label = statusLabel(h);
  return label === null ? h.name : `${h.name} (${label})`;
}
