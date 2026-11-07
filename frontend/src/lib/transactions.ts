import { cleanMoney, formatRupees } from "./accounts.ts";

export type TransactionType = "income" | "expense" | "transfer";

export type Transaction = {
  id: number;
  type: TransactionType;
  amount: string;
  date: string;
  account_id: number;
  account_name: string;
  to_account_id: number | null;
  to_account_name: string | null;
  category: string | null;
  note: string | null;
  editable: boolean;
};

export type TransactionList = {
  transactions: Transaction[];
  has_more: boolean;
  total_income: string;
  total_expense: string;
};

export type CategoryList = { income: string[]; expense: string[] };

export type TransactionForm = {
  type: TransactionType;
  amount: string;
  date: string;
  account_id: string;
  to_account_id: string;
  category: string;
  note: string;
};

export const TRANSACTION_TYPES: { value: TransactionType; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
];

export function blankForm(type: TransactionType, date: string, accountId: number | null): TransactionForm {
  return {
    type,
    amount: "",
    date,
    account_id: accountId === null ? "" : String(accountId),
    to_account_id: "",
    category: "",
    note: "",
  };
}

export function formFromTransaction(tx: Transaction): TransactionForm {
  return {
    type: tx.type,
    amount: tx.amount,
    date: tx.date,
    account_id: String(tx.account_id),
    to_account_id: tx.to_account_id === null ? "" : String(tx.to_account_id),
    category: tx.category ?? "",
    note: tx.note ?? "",
  };
}

const idOrNull = (raw: string) => (raw === "" ? null : Number(raw));
const textOrNull = (raw: string) => raw.trim() || null;

export function toPayload(form: TransactionForm, mode: "create" | "edit"): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (mode === "create") payload.type = form.type;
  payload.amount = textOrNull(cleanMoney(form.amount));
  payload.date = textOrNull(form.date);
  payload.account_id = idOrNull(form.account_id);
  if (form.type === "transfer") payload.to_account_id = idOrNull(form.to_account_id);
  else payload.category = textOrNull(form.category);
  payload.note = textOrNull(form.note);
  return payload;
}

// What an edit sends: only what differs from the loaded transaction. Empty means nothing to save.
export function changedPayload(form: TransactionForm, original: Transaction): Record<string, unknown> {
  const before = toPayload(formFromTransaction(original), "edit");
  const after = toPayload(form, "edit");
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) changed[key] = after[key];
  }
  return changed;
}

// The fields the dialog shows for a type, which is where field errors can be displayed.
export function renderedFields(type: TransactionType): (keyof TransactionForm)[] {
  return ["amount", "date", "account_id", type === "transfer" ? "to_account_id" : "category", "note"];
}

// A transfer is only "in" or "out" from one account's side, so without one in view it has no sign.
export function signedAmount(tx: Transaction, viewedAccountId: number | null = null): string {
  const rupees = formatRupees(tx.amount);
  if (tx.type === "income") return `+${rupees}`;
  if (tx.type === "expense") return `-${rupees}`;
  if (viewedAccountId === tx.account_id) return `-${rupees}`;
  if (viewedAccountId === tx.to_account_id) return `+${rupees}`;
  return rupees;
}

export function todayIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function shiftMonth(month: string, by: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + by;
  const year = Math.floor(total / 12);
  return `${year}-${String(total - year * 12 + 1).padStart(2, "0")}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Read from the text, not a Date, so no timezone can shift the day.
export function formatMonth(month: string): string {
  return `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}

export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1].slice(0, 3)} ${year}`;
}

export function groupByDate(transactions: Transaction[]): { date: string; transactions: Transaction[] }[] {
  const groups: { date: string; transactions: Transaction[] }[] = [];
  for (const tx of transactions) {
    const last = groups[groups.length - 1];
    if (last?.date === tx.date) last.transactions.push(tx);
    else groups.push({ date: tx.date, transactions: [tx] });
  }
  return groups;
}
