import { type Account, cleanMoney, formatRupees } from "./accounts.ts";
import { formatCoinQty } from "./crypto.ts";
import type { HistoryLine } from "./goals.ts";

export type TransactionType = "income" | "expense" | "transfer" | "emi" | "refund" | "adjustment";

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
  interest: string | null; // EMIs only
  note: string | null;
  recurring_template_id: number | null;
  refund_of_id?: number | null; // a refund's purchase, when linked
  refunded?: string | null; // an expense's linked refunds, when there are any
  editable: boolean;
  split?: SplitTag | null; // set when it's part of a split bill
  from_sms?: boolean; // recorded from a bank SMS
};

export type TransactionList = {
  transactions: Transaction[];
  has_more: boolean;
  total_income: string;
  total_expense: string;
  expense_by_category: { category: string; amount: string }[];
};

export type CategoryList = { income: string[]; expense: string[] };

export type TransactionForm = {
  type: TransactionType;
  amount: string;
  date: string;
  account_id: string;
  to_account_id: string;
  category: string;
  interest: string;
  note: string;
  refund_of_id: string; // a refund's purchase; "" when not linked
  recurring_template_id?: number | null; // set when it records a reminder occurrence
};

// The form's fields the dialog edits as text; the template link is carried, not typed.
export type FieldKey = Exclude<keyof TransactionForm, "recurring_template_id">;

export const TRANSACTION_TYPES: { value: TransactionType; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
  { value: "emi", label: "EMI" },
  { value: "refund", label: "Refund" },
  // Recorded by correcting an account's balance, so never picked when adding a transaction.
  { value: "adjustment", label: "Adjustment" },
];

// Types that move money into a second account: the transfer's destination, or the EMI's loan.
const TWO_ACCOUNTS = new Set<TransactionType>(["transfer", "emi"]);

export function blankForm(type: TransactionType, date: string, accountId: number | null): TransactionForm {
  return {
    type,
    amount: "",
    date,
    account_id: accountId === null ? "" : String(accountId),
    to_account_id: "",
    category: "",
    interest: "",
    note: "",
    refund_of_id: "",
  };
}

// An EMI for `loan`, pre-filled with its suggested split and paid from its usual account.
export function emiForm(loan: Account, date: string): TransactionForm {
  return {
    ...blankForm("emi", date, loan.pay_from_id),
    to_account_id: String(loan.id),
    amount: loan.next_emi?.amount ?? loan.emi_amount ?? "",
    interest: loan.next_emi?.interest ?? "",
  };
}

export function formFromTransaction(tx: Transaction): TransactionForm {
  return {
    type: tx.type,
    amount: tx.amount,
    date: tx.date,
    account_id: String(tx.account_id),
    to_account_id: tx.to_account_id === null ? "" : String(tx.to_account_id),
    category: tx.type === "emi" ? "" : (tx.category ?? ""),
    interest: tx.interest ?? "",
    note: tx.note ?? "",
    refund_of_id: tx.refund_of_id == null ? "" : String(tx.refund_of_id),
    ...(tx.recurring_template_id == null ? {} : { recurring_template_id: tx.recurring_template_id }),
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
  if (TWO_ACCOUNTS.has(form.type)) payload.to_account_id = idOrNull(form.to_account_id);
  // A linked refund takes its purchase's category, so only an unlinked one names its own.
  // A linked refund takes its purchase's category, and an adjustment has none.
  else if (form.type !== "adjustment" && !(form.type === "refund" && form.refund_of_id !== "")) {
    payload.category = textOrNull(form.category);
  }
  if (form.type === "refund") payload.refund_of_id = idOrNull(form.refund_of_id);
  if (form.type === "emi") payload.interest = textOrNull(cleanMoney(form.interest));
  payload.note = textOrNull(form.note);
  if (form.recurring_template_id != null) payload.recurring_template_id = form.recurring_template_id;
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
export function renderedFields(type: TransactionType): FieldKey[] {
  if (type === "emi") return ["amount", "date", "account_id", "to_account_id", "interest", "note"];
  if (type === "refund") return ["amount", "date", "account_id", "refund_of_id", "category", "note"];
  if (type === "adjustment") return ["amount", "date", "account_id", "note"];
  return ["amount", "date", "account_id", type === "transfer" ? "to_account_id" : "category", "note"];
}

// A transfer is only "in" or "out" from one account's side, so without one in view it has no sign.
export function signedAmount(tx: Transaction, viewedAccountId: number | null = null): string {
  const rupees = formatRupees(tx.amount);
  if (tx.type === "income" || tx.type === "refund") return `+${rupees}`;
  // An adjustment's amount is already signed: money into the account, or out of it.
  if (tx.type === "adjustment") return tx.amount.startsWith("-") ? rupees : `+${rupees}`;
  if (tx.type === "expense") return `-${rupees}`;
  // Only the principal reaches the loan; the paying account loses the whole EMI.
  if (tx.type === "emi" && viewedAccountId === tx.to_account_id) {
    return `+${formatRupees(subtractMoney(tx.amount, tx.interest ?? "0"))}`;
  }
  if (tx.type === "emi") return `-${rupees}`;
  if (viewedAccountId === tx.account_id) return `-${rupees}`;
  if (viewedAccountId === tx.to_account_id) return `+${rupees}`;
  return rupees;
}

// At most 13 whole digits, so paise stay well inside the integers a Number holds exactly.
const MONEY_TEXT = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/;

function toPaise(text: string): number | null {
  const match = MONEY_TEXT.exec(text.trim());
  if (!match) return null;
  const paise = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -paise : paise;
}

// a − b on money text, exactly: whole paise, never fractional floats. "" when either isn't a
// plain amount (like "12.5" or "-3.10").
export function subtractMoney(a: string, b: string): string {
  const x = toPaise(a);
  const y = toPaise(b);
  if (x === null || y === null) return "";
  const diff = x - y;
  const abs = Math.abs(diff);
  return `${diff < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
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

export const isDeposit = (a: Account | undefined) => a?.type === "ppf" || a?.type === "rd" || a?.type === "fd";
const byId = (accounts: Account[], id: string) => accounts.find((a) => String(a.id) === id);

// The accounts the "paid from" / "received in" / "from" picker offers. The server refuses an expense
// or EMI paid from a PPF, RD or FD, and a transfer between two deposits or from/to a non-bank; so those
// aren't offered. The account already chosen stays listed so a pre-filled form still shows it.
export function fromOptions(type: TransactionType, accounts: Account[], form: TransactionForm): Account[] {
  const toAccount = byId(accounts, form.to_account_id);
  return accounts.filter((a) => {
    if (String(a.id) === form.account_id) return true;
    if (type === "expense" || type === "refund") return !isDeposit(a);
    if (type === "emi") return !isDeposit(a) && a.type !== "loan";
    if (type === "transfer") {
      if (String(a.id) === form.to_account_id) return false;
      // A deposit only trades with a bank, so against anything else, or into a deposit, only banks.
      return (!isDeposit(toAccount) && !(toAccount && toAccount.type !== "bank" && isDeposit(a))) || a.type === "bank";
    }
    return true;
  });
}

// The transfer's "to" picker: never the "from" account, and banks only when "from" is a deposit.
export function toOptions(accounts: Account[], form: TransactionForm): Account[] {
  const from = byId(accounts, form.account_id);
  return accounts.filter(
    (a) =>
      String(a.id) === form.to_account_id ||
      (String(a.id) !== form.account_id && (a.type === "bank" ? true : !isDeposit(from) && !(from && from.type !== "bank" && isDeposit(a)))),
  );
}

// Income into a PPF, RD or FD can only be interest, so that is the one category offered.
export type CategorySuggestion = { category: string | null; source: "history" | "keywords" | null };

// Where to ask for the category a note suggests; null when there's nothing worth asking about.
export function suggestPath(type: TransactionType, note: string): string | null {
  const trimmed = note.trim();
  if ((type !== "expense" && type !== "income") || trimmed.length < 2) return null;
  return `/transactions/suggest-category?${new URLSearchParams({ type, note: trimmed })}`;
}

// A suggestion fills (or, with none, clears) the category until the owner picks one themselves.
export function applySuggestion(form: TransactionForm, touched: boolean, category: string | null): TransactionForm {
  if (touched) return form;
  return { ...form, category: category ?? "" };
}

export function incomeCategories(accounts: Account[], form: TransactionForm, categories: string[]): string[] {
  return isDeposit(byId(accounts, form.account_id)) ? ["Interest"] : categories;
}

// After the user changes a field, drop or fix what the deposit rules no longer allow. Not applied
// to a pre-filled form, which is already valid.
export function applyDepositRules(form: TransactionForm, accounts: Account[]): TransactionForm {
  const from = byId(accounts, form.account_id);
  const to = byId(accounts, form.to_account_id);
  let next = form;
  if ((form.type === "expense" || form.type === "emi" || form.type === "refund") && isDeposit(from)) {
    next = { ...next, account_id: "" };
  }
  if (form.type === "income" && isDeposit(from)) next = { ...next, category: "Interest" };
  if (form.type === "transfer") {
    if (isDeposit(from) && to && to.type !== "bank") next = { ...next, to_account_id: "" };
    if (isDeposit(to) && from && from.type !== "bank") next = { ...next, account_id: "" };
  }
  return next;
}

// The form for a new transaction: an expense paid from `accountId`, unless that is a PPF, RD or FD, which
// an expense can't be paid from; then no account is chosen.
export function newTransactionForm(date: string, accountId: number | null, accounts: Account[]): TransactionForm {
  return applyDepositRules(blankForm("expense", date, accountId), accounts);
}

// One buy or sell on an account's investment activity list, from GET /accounts/{id}/investment-activity.
export type Activity = {
  trade_id: number;
  kind: "stock" | "mutual_fund" | "crypto";
  instrument_id: number;
  symbol: string;
  name: string;
  side: "buy" | "sell";
  date: string;
  quantity: string;
  amount: string;
  signed_amount: string;
  sip_id: number | null;
};

// Investment activity shows under one account's transactions, and not when a type filter is set:
// a buy or sell is not of any transaction type.
export function showsActivity(filters: { accountId: number | null; type: TransactionType | null }): boolean {
  return filters.accountId !== null && filters.type === null;
}

export function activityLabel(a: Activity): string {
  if (a.sip_id !== null) return `SIP: ${a.name}`;
  const quantity = a.kind === "crypto" ? formatCoinQty(a.quantity) : a.quantity;
  return `${a.side === "buy" ? "Bought" : "Sold"} ${quantity} ${a.symbol}`;
}

// "Release and record an expense": the expense that matches a release, from the same account for the
// same amount (the release is stored negative), dated today. The caller saves the release first.
export function expenseFormFromRelease(entry: HistoryLine, today: string): TransactionForm {
  return { ...blankForm("expense", today, entry.account_id), amount: entry.amount.replace(/^-/, "") };
}

// A purchase a refund could be for (GET /transactions/refundable).
export type RefundablePurchase = {
  id: number;
  date: string;
  amount: string;
  left: string; // what is still unrefunded
  category: string | null;
  account_id: number;
  account_name: string;
  note: string | null;
};

// Where to ask for the purchases a refund on the form's date, of at least its amount, could be for.
// `editingId` is the refund being edited, so its own amount still counts as refundable.
export function refundablePath(form: TransactionForm, editingId: number | null = null): string {
  const params = new URLSearchParams();
  if (form.date) params.set("date", form.date);
  const amount = cleanMoney(form.amount);
  if (/^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0) params.set("amount", amount);
  if (editingId !== null) params.set("exclude_id", String(editingId));
  const query = params.toString();
  return query ? `/transactions/refundable?${query}` : "/transactions/refundable";
}

export function purchaseLabel(p: RefundablePurchase): string {
  const left = p.left === p.amount ? "" : ` (${formatRupees(p.left)} left)`;
  const parts = [formatDate(p.date), p.category ?? "Uncategorised", `${formatRupees(p.amount)}${left}`];
  if (p.note) parts.push(p.note);
  return parts.join(" · ");
}

// A split bill: `id` is the original's (part 1). See GET/PUT /transactions/{id}/split.
export type SplitTag = { id: number; part: number; parts: number };
export type SplitPart = { category: string; amount: string };

export const splitLabel = (tag: SplitTag | null | undefined): string | null =>
  tag ? `Split ${tag.part} of ${tag.parts}` : null;

// What's left to assign to a part: the bill less every part, exactly; "" if an amount isn't plain money.
export function splitLeft(total: string, parts: SplitPart[]): string {
  let left = total;
  for (const p of parts) {
    left = subtractMoney(left, p.amount.trim() === "" ? "0.00" : p.amount);
    if (left === "") return "";
  }
  return left;
}
