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
  // The category the payee's rule ("rule") or history ("history": history_count of the latest
  // history_total) suggests, the account an unknown-account message's payee used, and whether the
  // item can be approved with the others. `why` is the short reason either way.
  suggested_category: string | null;
  suggestion_source: "rule" | "merchant" | "history" | null;
  history_count: number;
  history_total: number;
  suggested_account_id: number | null;
  confident: boolean;
  why: string;
};

// Mirrors ConfidentSummary: the server's totals for every confident item.
export type CategoryTotal = { category: string; type: "income" | "expense"; count: number; amount: string };
// `ids` is the batch "Approve all" sends (the oldest, at most 200); `total` counts every confident item.
export type ConfidentSummary = {
  count: number;
  total: number;
  ids: number[];
  spent: string;
  received: string;
  categories: CategoryTotal[];
};

export type ReviewList = { items: ReviewItem[]; confident: ConfidentSummary };

// Mirrors ApproveResult from POST /sms/review/approve.
export type Learnable = { entry_id: number; payee: string; category: string };
export type ApproveResult = { approved: number; skipped: { id: number; reason: string }[]; learn: Learnable[] };

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

// The body for POST /sms/review/approve: each confident item with the category the owner was shown,
// so the server skips any whose suggestion changed since.
export function approveBody(items: ReviewItem[], summary: ConfidentSummary) {
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    items: summary.ids.flatMap((id) => {
      const item = byId.get(id);
      return item && item.confident && item.suggested_category !== null
        ? [{ id, category: item.suggested_category }]
        : [];
    }),
  };
}

// "Approve 12 confident", or "Approve 200 of 250" when there are more than one batch takes.
export function approveButtonText(summary: Pick<ConfidentSummary, "count" | "total">): string {
  return summary.count < summary.total
    ? `Approve ${summary.count} of ${summary.total}`
    : `Approve ${summary.count} confident`;
}

// A category is filled in only when the item is confident; otherwise the suggestion is a hint the
// owner can tap, and "Always use" starts off so a guess is never learned by default.
export function initialCategory(item: ReviewItem): string {
  return item.confident ? (item.suggested_category ?? "") : "";
}

export function initialRemember(item: ReviewItem): boolean {
  return item.confident || item.suggested_category === null;
}

// "Usually Groceries (3 of 4 times)" for a suggestion that isn't sure enough to fill in.
export function suggestionHint(item: ReviewItem): string | null {
  if (item.confident || item.suggested_category === null) return null;
  if (item.suggestion_source === "history") {
    return `Usually ${item.suggested_category} (${item.history_count} of ${item.history_total} times)`;
  }
  return `Suggested: ${item.suggested_category}`;
}

// "Earlier messages from Ramesh were in HDFC": only a hint, since a payee says nothing about an
// unknown card number.
export function accountHint<T extends { id: number; name: string }>(item: ReviewItem, accounts: T[]): T | null {
  if (item.suggested_account_id === null) return null;
  return accounts.find((a) => a.id === item.suggested_account_id) ?? null;
}

const isZero = (money: string) => /^0+(\.0+)?$/.test(money);

// "₹1,240 spent · ₹5,000 received", leaving out a side with nothing on it.
export function confidentTotalsText(summary: ConfidentSummary): string {
  const parts: string[] = [];
  if (!isZero(summary.spent)) parts.push(`${whole(summary.spent)} spent`);
  if (!isZero(summary.received)) parts.push(`${whole(summary.received)} received`);
  return parts.join(" · ");
}

// "Groceries · 3 · ₹1,240", one line per category in the confirmation.
export function categoryTotalText(total: CategoryTotal): string {
  return `${total.category} · ${total.count} · ${whole(total.amount)}`;
}

export function approveResultText(result: ApproveResult): string {
  const done = `Approved ${result.approved} ${result.approved === 1 ? "message" : "messages"}.`;
  const skipped = result.skipped.length;
  return skipped === 0 ? done : `${done} ${skipped} left to check.`;
}

// The "Always use" box names the category it will remember once one is picked.
export function rememberLabel(payee: string, category: string): string {
  const picked = category.trim();
  return picked ? `Always use ${picked} for ${payee}` : `Always use this for ${payee}`;
}

// Fired on window when an answer changes what's waiting, so the sidebar's count can reload.
export const REVIEW_CHANGED = "gullak:review-changed";
