export type AccountType = "bank" | "credit_card" | "cash" | "broker" | "wallet";

export type Account = {
  id: number;
  type: AccountType;
  name: string;
  balance: string;
  institution: string | null;
  bank_kind: string | null;
  last4: string | null;
  credit_limit: string | null;
  available_credit: string | null;
  statement_day: number | null;
  due_day: number | null;
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
};

export const TYPE_LABELS: Record<AccountType, string> = {
  bank: "Bank account",
  credit_card: "Credit card",
  cash: "Cash in hand",
  broker: "Broker balance",
  wallet: "Wallet or prepaid card",
};

export const TYPE_ORDER: AccountType[] = ["bank", "credit_card", "cash", "broker", "wallet"];

// Mirrors APPLICABLE in backend/app/api/routes/accounts.py.
const APPLICABLE: Record<AccountType, (keyof AccountForm)[]> = {
  bank: ["institution", "bank_kind", "last4"],
  credit_card: ["institution", "last4", "credit_limit", "statement_day", "due_day"],
  cash: [],
  broker: ["institution"],
  wallet: ["institution"],
};

const MONEY_FIELDS = new Set<keyof AccountForm>(["balance", "credit_limit"]);
const DAY_FIELDS = new Set<keyof AccountForm>(["statement_day", "due_day"]);

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
    return DAY_FIELDS.has(key) ? Number(trimmed) : trimmed;
  };

  payload.name = form.name.trim();
  payload.balance = field("balance");
  for (const key of APPLICABLE[form.type]) payload[key] = field(key);
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
  return changed;
}

const FALLBACK = "Something went wrong. Try again.";
const DAY_MESSAGE = "Enter a day from 1 to 31.";

// toPayload turns a non-numeric day into NaN, which JSON sends as null and so silently clears it.
// Blank is fine (the day is optional); anything else must be a whole number from 1 to 31.
export function dayError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return DAY_MESSAGE;
  const day = Number(trimmed);
  return day >= 1 && day <= 31 ? null : DAY_MESSAGE;
}

export type SplitErrors = { fields: Record<string, string>; general: string[] };

// Every message in a 422 lands somewhere: next to its field when that field is rendered (first
// message per field), otherwise in `general`. With no parseable message, `general` is [fallback].
// `detail` is ApiError.detail, the parsed JSON body's `detail` (undefined if the body wasn't JSON).
export function splitErrors(detail: unknown, rendered: readonly string[], fallback = FALLBACK): SplitErrors {
  const fields: Record<string, string> = {};
  const general: string[] = [];
  if (Array.isArray(detail)) {
    for (const item of detail) {
      if (typeof item?.msg !== "string") continue;
      const key = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : undefined;
      if (typeof key === "string" && rendered.includes(key) && !(key in fields)) fields[key] = item.msg;
      else general.push(item.msg);
    }
  }
  if (Object.keys(fields).length === 0 && general.length === 0) general.push(fallback);
  return { fields, general };
}

// The form fields the form shows for a type, which is where field errors can be displayed.
export function renderedFields(type: AccountType, mode: "create" | "edit"): (keyof AccountForm)[] {
  return [...(mode === "create" ? (["type"] as const) : []), "name", "balance", ...APPLICABLE[type]];
}

// Duck-typed on `detail` so this file doesn't import ApiError.
export function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string") {
    return error.detail;
  }
  return FALLBACK;
}
