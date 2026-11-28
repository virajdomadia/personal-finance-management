import type { GoalCard, GoalDue } from "./goals.ts";
import type { DueItem } from "./recurring.ts";

// The active goal a holding is in. Mirrors GoalTag in backend/app/api/routes/accounts.py.
export type GoalTag = { id: number; name: string };

export type AccountType = "bank" | "credit_card" | "cash" | "broker" | "wallet" | "ppf" | "rd" | "fd" | "loan";

// The suggested split of a loan's next EMI. Interest is null when it can't be worked out.
export type NextEmi = { amount: string; interest: string | null; principal: string | null };

export type PpfFigures = {
  kind: "ppf";
  maturity_date: string;
  deposited_this_year: string;
  year_limit: string;
  interest_this_year: string;
  interest_due: { year: string; amount: string; date: string } | null;
};

export type RdFigures = {
  kind: "rd";
  maturity_date: string;
  deposits_paid: number;
  deposits_left: number;
  deposited: string;
  interest_so_far: string;
  value_today: string;
  maturity_value: string;
  due: string[];
};

// How an FD pays its interest: all at maturity, or to the bank each month or quarter.
export type FdPayout = "cumulative" | "monthly" | "quarterly";

export type FdFigures = {
  kind: "fd";
  maturity_date: string;
  payout: FdPayout;
  principal: string;
  interest_so_far: string; // an estimate; 0 for a payout FD, whose interest goes to the bank
  value_today: string;
  maturity_value: string; // the estimate at maturity; the principal for a payout FD
  payout_amount: string | null; // interest paid to the bank each month or quarter; null for cumulative
  matured: boolean; // today is on or after the maturity date
};

export type Account = {
  id: number;
  type: AccountType;
  name: string;
  balance: string; // the real balance
  set_aside: string; // what active goals have set aside here
  free_balance: string; // balance - set_aside; negative when more is set aside than held
  in_goal: GoalTag | null; // a PPF or RD in an active goal
  bank_check: BankCheck | null;
  institution: string | null;
  bank_kind: string | null;
  last4: string | null;
  credit_limit: string | null;
  available_credit: string | null;
  statement_day: number | null;
  due_day: number | null;
  interest_rate: string | null;
  emi_amount: string | null;
  emis_left: number | null;
  pay_from_id: number | null;
  next_emi: NextEmi | null;
  opened_on: string | null;
  deposit_amount: string | null;
  tenure_months: number | null;
  matures_on: string | null; // an FD's maturity date
  fd_payout: FdPayout | null;
  deposit: PpfFigures | RdFigures | FdFigures | null;
  archived: boolean;
};

export type AccountList = {
  accounts: Account[];
  total_have: string;
  total_owe: string;
};

export type Dashboard = {
  has_accounts: boolean;
  net_worth: string;
  total_have: string;
  total_owe: string;
  next_card_due: { account_id: number; name: string; due_date: string } | null;
  credit_used: { percent: number } | null;
  investments: { value: string; unrealised: string; unrealised_percent: string } | null;
  recurring: DueItem[]; // reminders due or coming up
  goals_due: GoalDue[];
  goals: GoalCard[];
  // What is held in each group. The values need not add up to total_have: a group at or below zero is left out of the bar.
  asset_split: { group: "bank_cash" | "deposits" | "stocks" | "funds" | "crypto"; value: string }[];
  to_review?: number; // SMS messages waiting in To review
  card_bill?: { account_id: number; name: string; amount: string; due_date: string } | null; // the unpaid card bill due soonest
};

export type AccountForm = {
  type: AccountType;
  name: string;
  balance: string;
  institution: string;
  bank_kind: string;
  last4: string;
  credit_limit: string;
  statement_day: string;
  due_day: string;
  interest_rate: string;
  emi_amount: string;
  emis_left: string;
  pay_from_id: string;
  opened_on: string;
  deposit_amount: string;
  tenure_months: string;
  deposits_paid: string;
  matures_on: string;
  fd_payout: string;
  moved_from_card: "" | "yes"; // create only
  // Edit only: a changed balance is recorded as an adjustment on this day ("" means today),
  // for this reason, once the account has anything recorded.
  balance_date: string;
  balance_reason: string;
};

export const TYPE_LABELS: Record<AccountType, string> = {
  bank: "Bank account",
  credit_card: "Credit card",
  cash: "Cash in hand",
  broker: "Broker balance",
  wallet: "Wallet or prepaid card",
  ppf: "PPF",
  rd: "Recurring deposit",
  fd: "Fixed deposit",
  loan: "Loan",
};

export const TYPE_ORDER: AccountType[] = ["bank", "credit_card", "cash", "broker", "wallet", "ppf", "rd", "fd", "loan"];

export const FD_PAYOUT_LABELS: Record<FdPayout, string> = {
  cumulative: "Cumulative",
  monthly: "Monthly payout",
  quarterly: "Quarterly payout",
};

// Accounts whose balance is what's owed.
export const OWED_TYPES = new Set<AccountType>(["credit_card", "loan"]);

// Mirrors APPLICABLE in backend/app/api/routes/accounts.py.
const APPLICABLE: Record<AccountType, (keyof AccountForm)[]> = {
  bank: ["institution", "bank_kind", "last4"],
  credit_card: ["institution", "last4", "credit_limit", "statement_day", "due_day"],
  cash: [],
  broker: ["institution"],
  wallet: ["institution"],
  ppf: ["institution", "interest_rate", "opened_on", "pay_from_id"],
  rd: ["institution", "interest_rate", "opened_on", "pay_from_id", "deposit_amount", "due_day", "tenure_months", "deposits_paid"],
  fd: ["institution", "interest_rate", "opened_on", "matures_on", "fd_payout", "pay_from_id"],
  loan: ["institution", "due_day", "interest_rate", "emi_amount", "emis_left", "pay_from_id"],
};

const MONEY_FIELDS = new Set<keyof AccountForm>(["balance", "credit_limit", "interest_rate", "emi_amount", "deposit_amount"]);
const NUMBER_FIELDS = new Set<keyof AccountForm>(["statement_day", "due_day", "emis_left", "pay_from_id", "tenure_months", "deposits_paid"]);

// What an account's headline shows: the free balance, or the balance for an older response.
export const headlineBalance = (a: Pick<Account, "balance"> & Partial<Pick<Account, "free_balance">>) =>
  a.free_balance ?? a.balance;

// Groups the digits on the string itself so money never goes through a float.
export function formatRupees(value: string): string {
  const negative = value.startsWith("-");
  const [whole, fraction] = (negative ? value.slice(1) : value).split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${negative ? "-" : ""}₹${grouped}${fraction !== undefined ? `.${fraction}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-25" -> "25 Nov". Split from the text, not a Date, so no timezone can shift the day.
export function formatDueDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}

// "2036-04-01" -> "1 Apr 2036", from the text so no timezone can shift the day.
export function formatFullDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

// The next date a day-of-month falls on, from today (both "YYYY-MM-DD"), clamped to short months.
// Mirrors next_due_date in backend/app/api/routes/dashboard.py.
export function nextDueDate(day: number, today: string): string {
  const [year, month, date] = today.split("-").map(Number);
  const clamp = (y: number, m: number) => Math.min(day, new Date(Date.UTC(y, m, 0)).getUTCDate());
  const pad = (n: number) => String(n).padStart(2, "0");
  const thisMonth = clamp(year, month);
  if (thisMonth >= date) return `${year}-${pad(month)}-${pad(thisMonth)}`;
  const [y, m] = month === 12 ? [year + 1, 1] : [year, month + 1];
  return `${y}-${pad(m)}-${pad(clamp(y, m))}`;
}

export function maskLast4(last4: string): string {
  return `•••• ${last4}`;
}

// Western (1,000,000) or Indian (10,00,000) digit groups in the whole-number part.
const GROUPED = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(\.\d*)?$/;

// Drops a leading rupee sign (after an optional sign) and outer spaces, and commas only where they sit between digit groups.
// Anything else (`1500,50`, `1 2`) is left as typed, so the server rejects it.
export function cleanMoney(raw: string): string {
  const text = raw.trim().replace(/^([+-]?)\s*₹\s*/, "$1");
  const match = GROUPED.exec(text);
  return match ? `${match[1]}${match[2].replace(/,/g, "")}${match[3] ?? ""}` : text;
}

export function formFromAccount(account: Account): AccountForm {
  return {
    type: account.type,
    name: account.name,
    balance: account.balance,
    institution: account.institution ?? "",
    bank_kind: account.bank_kind ?? "",
    last4: account.last4 ?? "",
    credit_limit: account.credit_limit ?? "",
    statement_day: account.statement_day === null ? "" : String(account.statement_day),
    due_day: account.due_day === null ? "" : String(account.due_day),
    interest_rate: account.interest_rate ?? "",
    emi_amount: account.emi_amount ?? "",
    emis_left: account.emis_left === null ? "" : String(account.emis_left),
    pay_from_id: account.pay_from_id === null ? "" : String(account.pay_from_id),
    opened_on: account.opened_on ?? "",
    deposit_amount: account.deposit_amount ?? "",
    tenure_months: account.tenure_months === null ? "" : String(account.tenure_months),
    deposits_paid: account.deposit?.kind === "rd" ? String(account.deposit.deposits_paid) : "",
    matures_on: account.matures_on ?? "",
    fd_payout: account.fd_payout ?? "",
    moved_from_card: "",
    balance_date: "",
    balance_reason: "",
  };
}

export function toPayload(form: AccountForm, mode: "create" | "edit"): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (mode === "create") payload.type = form.type;

  const field = (key: keyof AccountForm): unknown => {
    const raw = form[key];
    if (MONEY_FIELDS.has(key)) {
      const cleaned = cleanMoney(raw);
      return cleaned === "" ? null : cleaned;
    }
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    return NUMBER_FIELDS.has(key) ? Number(trimmed) : trimmed;
  };

  payload.name = form.name.trim();
  payload.balance = field("balance");
  for (const key of APPLICABLE[form.type]) payload[key] = field(key);
  if (mode === "create" && form.type === "loan" && form.moved_from_card === "yes") payload.moved_from_card = true;
  return payload;
}

// What an edit sends: only the fields that differ from the loaded account (a cleared field is
// null), so a stale dialog can't overwrite a value changed elsewhere. Empty means nothing to save.
export function changedPayload(form: AccountForm, original: Account): Record<string, unknown> {
  const before = toPayload(formFromAccount(original), "edit");
  const after = toPayload(form, "edit");
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) changed[key] = after[key];
  }
  if ("balance" in changed) {
    if (form.balance_date) changed.balance_date = form.balance_date;
    changed.balance_reason = form.balance_reason.trim() || null;
  }
  return changed;
}

const FALLBACK = "Something went wrong. Try again.";

export type SplitErrors = { fields: Record<string, string>; general: string[] };

// Every message in a 422 lands somewhere: next to its field when that field is rendered (first
// message per field), otherwise in `general`. With no parseable message, `general` is [fallback].
export function splitErrors(body: string, rendered: readonly string[], fallback = FALLBACK): SplitErrors {
  const fields: Record<string, string> = {};
  const general: string[] = [];
  try {
    const detail = JSON.parse(body)?.detail;
    if (Array.isArray(detail)) {
      for (const item of detail) {
        if (typeof item?.msg !== "string") continue;
        const key = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : undefined;
        if (typeof key === "string" && rendered.includes(key) && !(key in fields)) fields[key] = item.msg;
        else general.push(item.msg);
      }
    }
  } catch {
    // Not JSON: fall through to the fallback.
  }
  if (Object.keys(fields).length === 0 && general.length === 0) general.push(fallback);
  return { fields, general };
}

// The form fields the dialog shows for a type, which is where field errors can be displayed.
export function renderedFields(type: AccountType, mode: "create" | "edit"): (keyof AccountForm)[] {
  return [
    ...(mode === "create" ? (["type"] as const) : []),
    "name",
    "balance",
    ...(mode === "edit" ? (["balance_date", "balance_reason"] as const) : []),
    ...APPLICABLE[type],
    ...(mode === "create" && type === "loan" ? (["moved_from_card"] as const) : []),
  ];
}

// Duck-typed on `body` so this file doesn't depend on ApiError.
export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "body" in error && typeof error.body === "string") {
    try {
      const detail = JSON.parse(error.body)?.detail;
      if (typeof detail === "string") return detail;
    } catch {
      // Not JSON: use the fallback.
    }
  }
  return FALLBACK;
}

// Money as whole paise, so the sum below never goes through a float.
function toPaise(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const paise = BigInt(whole || "0") * BigInt(100) + BigInt(`${fraction}00`.slice(0, 2));
  return negative ? -paise : paise;
}

// Mirrors HAVE_TYPES in backend/app/api/routes/accounts.py.
const HAVE_TYPES = new Set<AccountType>(["bank", "cash", "broker", "wallet", "ppf", "rd", "fd"]);

// "You have" is the active accounts' balances plus investments. This is the investments part,
// or null when there is none. Only meaningful for the active list, which holds every active account.
export function investmentsIn(list: AccountList): string | null {
  let accounts = BigInt(0);
  for (const a of list.accounts) if (HAVE_TYPES.has(a.type) && !a.archived) accounts += toPaise(a.balance);
  const rest = toPaise(list.total_have) - accounts;
  if (rest <= BigInt(0)) return null;
  return `${rest / BigInt(100)}.${String(rest % BigInt(100)).padStart(2, "0")}`;
}

// The balance the bank's latest SMS gave, against Gullak's at the end of that day (bank accounts).
export type BankCheck = { balance: string; on: string; gap: string }; // gap: bank − Gullak

// "Your bank's SMS on 21 Nov said ₹9,000. Gullak shows ₹400 more." Null when they match.
export function bankGapText(check: BankCheck | null): string | null {
  if (check === null || Number(check.gap) === 0) return null;
  const higher = check.gap.startsWith("-");
  const rupees = (v: string) => formatRupees(v.replace(/\.00$/, ""));
  const gap = rupees(higher ? check.gap.slice(1) : check.gap);
  return `Your bank's SMS on ${formatDueDate(check.on)} said ${rupees(check.balance)}. Gullak shows ${gap} ${higher ? "more" : "less"}.`;
}

// The PATCH body that makes Gullak's balance that day the bank's, as a dated adjustment.
export const matchBankBody = (check: BankCheck) => ({
  balance: check.balance,
  balance_date: check.on,
  balance_reason: "Matched to bank SMS",
});

// A loan's repayment schedule (`GET /accounts/{id}/schedule`), worked out from what's owed today.
export type ScheduleRow = { month: string; due: string | null; amount: string; interest: string; principal: string; left: string };
export type LoanSchedule = {
  account_id: number;
  owed: string;
  rate: string | null;
  emi: string | null;
  paid_off: boolean;
  problem: string | null;
  emis_left: number;
  ends: string | null; // "YYYY-MM" of the last EMI
  interest_left: string;
  total_left: string;
  rows: ScheduleRow[];
};

// "Ends Jan 2027 · 2 EMIs left · ₹14.10 interest still to pay"; null when paid off or it can't be worked out.
export function scheduleSummary(s: LoanSchedule): string | null {
  if (s.paid_off || s.problem !== null || s.ends === null) return null;
  const [year, month] = s.ends.split("-");
  const emis = s.emis_left === 1 ? "1 EMI left" : `${s.emis_left} EMIs left`;
  const interest = formatRupees(s.interest_left.replace(/\.00$/, ""));
  return `Ends ${MONTHS[Number(month) - 1]} ${year} · ${emis} · ${interest} interest still to pay`;
}
