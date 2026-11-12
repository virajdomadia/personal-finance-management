import { formatDueDate } from "./accounts.ts";
import { whole } from "./recurring.ts";

// Mirrors ReviewItem in backend/app/api/routes/sms.py. A candidate is one choice the server found:
// a transaction, an account, a loan's EMI, a SIP, a reminder, an owned stock or a market listing.
// A SIP whose fund has no NAV for the day says needs_nav: its "expected" answer takes the NAV.
export type Candidate = { kind: string; id: number; label: string; needs_nav?: boolean };

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

export type ReviewList = { items: ReviewItem[] };

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

// Mirrors the payee rules, identifiers and samples responses.
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

export type Sample = { id: number; sender: string; text: string; created_at: string };

export type CardBill = { account_id: number; name: string; amount: string; due_date: string };

const TITLES: Record<string, string> = {
  category: "New payee",
  account: "Which account?",
  maybe_duplicate: "Already typed in?",
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

const ofKind = (item: ReviewItem, kind: string) => (item.candidates ?? []).filter((c) => c.kind === kind);
const EXPECTED_KINDS = new Set(["emi", "sip", "template"]);

// The buttons a card shows, in order. An answer that needs a candidate is left out when there is none.
export function actionsFor(item: ReviewItem): Action[] {
  const transactions = ofKind(item, "transaction").length > 0;
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
      actions = [
        ...(transactions ? (["transfer"] as const) : []),
        ...(ofKind(item, "account").length > 0 ? (["account"] as const) : []),
      ];
      break;
    case "expected":
      // "same": an EMI already recorded for the period, offered as a transaction.
      actions = [
        ...((item.candidates ?? []).some((c) => EXPECTED_KINDS.has(c.kind)) ? (["expected"] as const) : []),
        ...(transactions ? (["same"] as const) : []),
        "category",
      ];
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

// Whether an "expected" item offers a SIP the NAV has to be typed in for.
export function needsNav(item: ReviewItem): boolean {
  return (item.candidates ?? []).some((c) => c.kind === "sip" && c.needs_nav === true);
}

// The "expected" answer for a choice. Only a SIP that needs a NAV sends one; blank sends null, which
// the server asks for again.
export function expectedBody(item: ReviewItem, choice: Candidate, remember: boolean, nav: string) {
  return {
    action: "expected" as const,
    kind: choice.kind,
    id: choice.id,
    remember: choice.kind === "template" && item.payee !== null && remember,
    ...(choice.kind === "sip" && choice.needs_nav === true ? { nav: nav.trim() || null } : {}),
  };
}

// Which category list applies: money in is income, anything else an expense.
export function categoryType(item: ReviewItem): "income" | "expense" {
  return item.kind === "credit" ? "income" : "expense";
}

// The accounts an "account" answer can choose. A card message belongs to a credit card; any other
// to a bank, wallet or card. A card bill is paid from one of the accounts the server listed.
export function accountChoices<T extends { id: number; type: string }>(item: ReviewItem, accounts: T[]): T[] {
  if (item.reason === "card_payment") {
    const listed = new Set(ofKind(item, "account").map((c) => c.id));
    return accounts.filter((a) => listed.has(a.id));
  }
  const card = item.kind === "card_spend" || item.kind === "card_payment" || item.kind === "card_statement";
  return accounts.filter((a) => (card ? a.type === "credit_card" : ["bank", "wallet", "credit_card"].includes(a.type)));
}

// "INFY · Infosys Limited" -> the symbol and name a new stock starts with.
export function marketPrefill(label: string): { symbol: string; name: string } {
  const at = label.indexOf(" · ");
  if (at < 0) return { symbol: label.trim(), name: "" };
  return { symbol: label.slice(0, at).trim(), name: label.slice(at + 3).trim() };
}

// A sample on one line, cut short with an ellipsis.
export function trimSampleText(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function reviewCountText(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"} to check`;
}

// "HDFC Regalia bill ₹12,500 due 5 Dec".
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

// Fired on window when an answer changes what's waiting, so the sidebar's count can reload.
export const REVIEW_CHANGED = "gullak:review-changed";
