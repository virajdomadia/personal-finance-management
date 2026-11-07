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
  bank: "Bank",
  credit_card: "Credit card",
  cash: "Cash",
  broker: "Broker",
  wallet: "Wallet",
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

export function maskLast4(last4: string): string {
  return `•••• ${last4}`;
}

function cleanMoney(raw: string): string {
  return raw.replace(/[₹,\s]/g, "");
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

export function fieldErrors(body: string): Record<string, string> {
  const errors: Record<string, string> = {};
  try {
    const detail = JSON.parse(body)?.detail;
    if (!Array.isArray(detail)) return errors;
    for (const item of detail) {
      const field = Array.isArray(item?.loc) ? item.loc[item.loc.length - 1] : undefined;
      if (typeof field === "string" && typeof item.msg === "string" && !(field in errors)) {
        errors[field] = item.msg;
      }
    }
  } catch {
    // Not JSON: no field errors.
  }
  return errors;
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
  return [...(mode === "create" ? (["type"] as const) : []), "name", "balance", ...APPLICABLE[type]];
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
