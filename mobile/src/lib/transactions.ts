import { type Account, cleanMoney, formatRupees } from "./accounts.ts";

export type TransactionType = "income" | "expense" | "transfer" | "emi";

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
  interest: string;
  note: string;
};

export const TRANSACTION_TYPES: { value: TransactionType; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
  { value: "emi", label: "EMI" },
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
  else payload.category = textOrNull(form.category);
  if (form.type === "emi") payload.interest = textOrNull(cleanMoney(form.interest));
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

// The fields the form shows for a type, in order, which is where field errors can be displayed.
export function renderedFields(type: TransactionType): (keyof TransactionForm)[] {
  if (type === "emi") return ["amount", "date", "account_id", "to_account_id", "interest", "note"];
  return ["amount", "date", "account_id", type === "transfer" ? "to_account_id" : "category", "note"];
}

// A transfer is only "in" or "out" from one account's side, so without one in view it has no sign.
export function signedAmount(tx: Transaction, viewedAccountId: number | null = null): string {
  const rupees = formatRupees(tx.amount);
  if (tx.type === "income") return `+${rupees}`;
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

const INDIA_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Plain arithmetic rather than Intl, whose time zone support varies across Android devices.
export function todayIndia(now: Date = new Date()): string {
  return new Date(now.getTime() + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

export function previousDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
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

// Set by the form when it saves, and read by the list when it regains focus, so the list can move
// to the month the transaction landed in rather than have it seem to vanish.
export const savedMonth: { current: string | null } = { current: null };

export const isDeposit = (a: Account | undefined) => a?.type === "ppf" || a?.type === "rd";
const byId = (accounts: Account[], id: string) => accounts.find((a) => String(a.id) === id);
const isActiveBank = (a: Account) => a.type === "bank" && !a.archived;

// The accounts the "paid from" / "received in" / "from" picker offers. The server refuses an expense
// or EMI paid from a PPF or RD, and a transfer between a deposit and anything but a bank; so those
// aren't offered. The account already chosen stays listed so a pre-filled form still shows it.
export function fromOptions(type: TransactionType, accounts: Account[], form: TransactionForm): Account[] {
  const toAccount = byId(accounts, form.to_account_id);
  return accounts.filter((a) => {
    if (String(a.id) === form.account_id) return true;
    if (type === "expense") return !isDeposit(a);
    if (type === "emi") return !isDeposit(a) && a.type !== "loan";
    if (type === "transfer") {
      if (String(a.id) === form.to_account_id) return false;
      // A deposit only trades with a bank: into a deposit only active banks, and no deposit against a non-bank.
      return (!isDeposit(toAccount) || isActiveBank(a)) && !(toAccount && toAccount.type !== "bank" && isDeposit(a));
    }
    return true;
  });
}

// The transfer's "to" picker: never the "from" account. Only a bank can pay into a deposit and only
// a bank can receive from one, so a deposit "from" lists active banks and a non-bank "from" lists no deposits.
export function toOptions(accounts: Account[], form: TransactionForm): Account[] {
  const from = byId(accounts, form.account_id);
  return accounts.filter((a) => {
    if (String(a.id) === form.to_account_id) return true;
    if (String(a.id) === form.account_id) return false;
    if (isDeposit(from)) return isActiveBank(a);
    if (from && from.type !== "bank" && isDeposit(a)) return false;
    return true;
  });
}

// The account a new form starts with: the one asked for, else the first that isn't a deposit, which
// an expense can't be paid from.
export function defaultAccountId(accounts: Account[], preferred: number | null): number | null {
  if (preferred !== null) return preferred;
  return (accounts.find((a) => !isDeposit(a)) ?? accounts[0])?.id ?? null;
}

// A new blank expense form. If its account is a deposit (opened from that account's page), the rules
// clear it once up front, so the picker never shows a choice the first edit would silently drop.
export function startForm(accounts: Account[], date: string, preferred: number | null): TransactionForm {
  return applyDepositRules(blankForm("expense", date, defaultAccountId(accounts, preferred)), accounts);
}

// Income into a PPF or RD can only be interest, so that is the one category offered.
export function incomeCategories(accounts: Account[], form: TransactionForm, categories: string[]): string[] {
  return isDeposit(byId(accounts, form.account_id)) ? ["Interest"] : categories;
}

// After the user changes a field, drop or fix what the deposit rules no longer allow. Not applied
// to a pre-filled form, which is already valid.
export function applyDepositRules(form: TransactionForm, accounts: Account[]): TransactionForm {
  const from = byId(accounts, form.account_id);
  const to = byId(accounts, form.to_account_id);
  let next = form;
  if ((form.type === "expense" || form.type === "emi") && isDeposit(from)) next = { ...next, account_id: "" };
  if (form.type === "income" && isDeposit(from)) next = { ...next, category: "Interest" };
  if (form.type === "transfer") {
    if (isDeposit(from) && to && !isActiveBank(to)) next = { ...next, to_account_id: "" };
    if (isDeposit(to) && from && !isActiveBank(from)) next = { ...next, account_id: "" };
  }
  return next;
}
