import { type CardBill, cleanMoney, formatDueDate, formatRupees, maskLast4 } from "./accounts.ts";
import { formatDate } from "./dates.ts";
import { whole } from "./recurring.ts";
import { maskSample } from "./sms/mask.ts";
import type { RawSms } from "./sms/sync.ts";

// To review: messages the server couldn't decide on its own, and what the app can answer.

// Mirrors ReviewItem in backend/app/api/routes/sms.py. A candidate is one choice the server found:
// a transaction, an account, a loan's EMI, a SIP, a reminder, an owned stock or a market listing.
export type Candidate = { kind: string; id: number; label: string };

export type ReviewItem = {
  id: number;
  status: "review" | "draft";
  kind: string;
  reason: string | null;
  message: string | null;
  amount: string | null;
  date: string;
  payee: string | null;
  last4: string | null;
  account_id: number | null;
  account_name: string | null;
  transaction_id: number | null;
  trade_id: number | null;
  isin: string | null;
  quantity: string | null;
  candidates: Candidate[] | null;
  suggested_price: string | null;
};

// The answers POST /sms/review/{id} takes.
export type Action =
  | "category"
  | "account"
  | "same"
  | "new"
  | "transfer"
  | "expected"
  | "units"
  | "units_ok"
  | "trade"
  | "retry"
  | "dismiss";

export type PayeeRule = {
  id: number;
  payee_key: string;
  display: string;
  category: string | null;
  to_account_id: number | null;
  to_account_name: string | null;
  template_id: number | null;
  template_name: string | null;
};

export type Identifier = { id: number; account_id: number; account_name: string; last4: string };

export type { CardBill };

const TITLES: Record<string, string> = {
  category: "New payee",
  account: "Which account?",
  maybe_duplicate: "Already added?",
  maybe_transfer: "A transfer?",
  expected: "A regular payment?",
  sip_units: "Check SIP units",
  demat: "Confirm share trade",
  card_payment: "Card bill paid from?",
  balance: "Couldn't record",
};

export function reviewTitle(item: ReviewItem): string {
  if (item.reason === "category" && item.payee === null) {
    return categoryType(item) === "income" ? "New credit" : "New payment";
  }
  return TITLES[item.reason ?? ""] ?? "Check this message";
}

export const REVIEW_EMOJI: Record<string, { emoji: string; tone: "yellow" | "blue" | "purple" | "orange" | "green" | "pink" }> = {
  category: { emoji: "🏷️", tone: "yellow" },
  account: { emoji: "👛", tone: "blue" },
  maybe_duplicate: { emoji: "👯", tone: "purple" },
  maybe_transfer: { emoji: "🔁", tone: "blue" },
  expected: { emoji: "🔔", tone: "orange" },
  sip_units: { emoji: "🥧", tone: "green" },
  demat: { emoji: "📈", tone: "green" },
  card_payment: { emoji: "💳", tone: "pink" },
  balance: { emoji: "⚠️", tone: "pink" },
};

// "Swiggy · HDFC •••• 1234 · 10 Nov 2026".
export function reviewDetails(item: ReviewItem): string {
  const account = [item.account_name, item.last4 ? maskLast4(item.last4) : null].filter(Boolean).join(" ");
  return [item.payee, account || null, formatDate(item.date)].filter(Boolean).join(" · ");
}

// The amount as the API sent it, or the shares for a demat message.
export function reviewFigure(item: ReviewItem): string | undefined {
  if (item.amount !== null) return formatRupees(item.amount);
  if (item.quantity !== null) return `${item.quantity} ${item.quantity === "1" ? "share" : "shares"}`;
  return undefined;
}

export const candidatesOf = (item: ReviewItem, kind: string): Candidate[] =>
  (item.candidates ?? []).filter((c) => c.kind === kind);

const EXPECTED_KINDS = new Set(["emi", "sip", "template"]);

// The EMIs, SIPs and reminders an "expected" item may be.
export const expectedChoices = (item: ReviewItem): Candidate[] =>
  (item.candidates ?? []).filter((c) => EXPECTED_KINDS.has(c.kind));

// The answers an item offers, in order, dismiss last. An answer that needs a candidate is left out
// when the server found none. Mirrors ANSWERS in backend/app/sms/review.py.
export function actionsFor(item: ReviewItem): Action[] {
  const transactions = candidatesOf(item, "transaction").length > 0;
  let actions: Action[];
  switch (item.reason) {
    case "category":
      actions = ["category"];
      break;
    case "account":
      actions = ["account"];
      break;
    case "maybe_duplicate":
      actions = transactions ? ["same", "new"] : ["new"];
      break;
    case "maybe_transfer":
      actions = transactions ? ["transfer", "category"] : ["category"];
      break;
    case "card_payment":
      actions = [];
      if (transactions) actions.push("transfer");
      if (candidatesOf(item, "account").length > 0) actions.push("account");
      break;
    case "expected":
      actions = expectedChoices(item).length > 0 ? ["expected", "category"] : ["category"];
      break;
    case "sip_units":
      actions = ["units", "units_ok"];
      break;
    case "demat":
      actions = ["trade"];
      break;
    case "balance":
      actions = ["retry"];
      break;
    default:
      actions = [];
  }
  return [...actions, "dismiss"];
}

// Which category list applies: money in is income, anything else an expense.
export function categoryType(item: ReviewItem): "income" | "expense" {
  return item.kind === "credit" ? "income" : "expense";
}

// The accounts an "account" answer can choose. A card message belongs to a credit card; any other
// to a bank, wallet or card. A card bill is paid from one of the accounts the server listed.
export function accountChoices<T extends { id: number; type: string }>(item: ReviewItem, accounts: T[]): T[] {
  if (item.reason === "card_payment") {
    const listed = new Set(candidatesOf(item, "account").map((c) => c.id));
    return accounts.filter((a) => listed.has(a.id));
  }
  const card = item.kind === "card_spend" || item.kind === "card_payment" || item.kind === "card_statement";
  return accounts.filter((a) => (card ? a.type === "credit_card" : ["bank", "wallet", "credit_card"].includes(a.type)));
}

// The category answer. "Always use this" only means something when the message named a payee.
export function categoryBody(item: ReviewItem, category: string, remember: boolean) {
  return { action: "category" as const, category: category.trim() || null, remember: item.payee !== null && remember };
}

type TradeInput = {
  stock: { kind: "stock"; id: number } | null; // null: a new stock from symbol and name
  brokerId: number | null;
  price: string;
  charges: string;
  symbol: string;
  name: string;
  side: "buy" | "sell" | null;
};

// The trade answer for a share movement. Money stays as typed text, cleaned of ₹ and commas.
export function tradeBody({ stock, brokerId, price, charges, symbol, name, side }: TradeInput) {
  return {
    action: "trade" as const,
    stock_id: stock === null ? null : stock.id,
    account_id: brokerId,
    price: cleanMoney(price) || null,
    charges: cleanMoney(charges) || "0",
    symbol: stock === null ? symbol.trim() || null : null,
    name: stock === null ? name.trim() || null : null,
    side,
  };
}

// "INFY · Infosys Limited" -> the symbol and name a new stock starts with.
export function marketPrefill(label: string): { symbol: string; name: string } {
  const at = label.indexOf(" · ");
  if (at < 0) return { symbol: label.trim(), name: "" };
  return { symbol: label.slice(0, at).trim(), name: label.slice(at + 3).trim() };
}

export function reviewCountText(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"} to check`;
}

// "Regalia bill ₹12,500 due 5 Dec".
export function cardBillText(bill: CardBill): string {
  return `${bill.name} bill ${whole(bill.amount)} due ${formatDueDate(bill.due_date)}`;
}

// "Category: Food and dining", "Transfer to SBI", plus "Ticks off Rent" when tied to a reminder.
export function ruleText(rule: PayeeRule): string {
  const parts: string[] = [];
  if (rule.category !== null) parts.push(`Category: ${rule.category}`);
  if (rule.to_account_id !== null) parts.push(`Transfer to ${rule.to_account_name ?? "an account"}`);
  if (rule.template_id !== null) parts.push(`Ticks off ${rule.template_name ?? "a reminder"}`);
  return parts.join(" · ");
}

// What "Send sample" sends: the sender and the masked text, clipped to what the server takes.
// The raw text is never part of it; the confirm dialog shows exactly this.
export function samplePayload(sms: RawSms): { sender: string; text: string } {
  return { sender: sms.address.trim().slice(0, 20), text: maskSample(sms.body).trim().slice(0, 500).trim() };
}

// Bank SMS settings

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The earliest start date: 90 days before today (the reader goes no further back).
export function earliestStartDate(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 90 * DAY_MS).toISOString().slice(0, 10);
}

// "Today, 9:05 am" or "11 Nov, 9:30 pm", in India time. 0 means it hasn't happened yet.
export function readTimeText(ms: number, now: Date = new Date()): string {
  if (ms <= 0) return "Not yet";
  const at = new Date(ms + IST_MS);
  const day = at.toISOString().slice(0, 10);
  const today = new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
  const hours = at.getUTCHours();
  const time = `${hours % 12 === 0 ? 12 : hours % 12}:${String(at.getUTCMinutes()).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
  const date = day === today ? "Today" : `${at.getUTCDate()} ${SHORT_MONTHS[at.getUTCMonth()]}`;
  return `${date}, ${time}`;
}

const BANK_NAMES: Record<string, string> = {
  hdfc: "HDFC Bank",
  sbi: "SBI",
  sbicard: "SBI Card",
  icici: "ICICI Bank",
  axis: "Axis Bank",
  kotak: "Kotak Bank",
  boi: "Bank of India",
  bob: "Bank of Baroda",
  pnb: "PNB",
  canara: "Canara Bank",
  union: "Union Bank",
  idfc: "IDFC First Bank",
  yes: "Yes Bank",
  indusind: "IndusInd Bank",
  federal: "Federal Bank",
  cdsl: "CDSL",
  nsdl: "NSDL",
};

export function bankName(key: string): string {
  return BANK_NAMES[key] ?? key.toUpperCase();
}

export type SmsStatus = "unavailable" | "off" | "stopped" | "on";

// What the Bank SMS screen shows at the top.
export function smsStatus(settings: { enabled: boolean; stoppedAt: number }, available: boolean): SmsStatus {
  if (!available) return "unavailable";
  if (!settings.enabled) return "off";
  return settings.stoppedAt > 0 ? "stopped" : "on";
}
