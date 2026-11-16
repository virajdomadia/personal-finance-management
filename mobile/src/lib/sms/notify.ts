// What to tell the owner after a sync: the notifications for bank SMS that just arrived and were
// recorded or wait in To review. Pure, so it runs under node tests; posting them is
// notifications.ts. Only the parsed fields the server was sent are worded, never the message text.

import { whole } from "../recurring.ts";
import { bankName } from "../review.ts";
import type { EntryOutcome } from "./sync.ts";

export const SMS_CHANNEL = {
  id: "sms-transactions",
  name: "Transactions from SMS",
  description: "When a bank SMS is recorded or needs your answer",
} as const;

// Only SMS received this recently are notified: a sync that catches up on older ones (the first
// read, a long time offline) fills them in quietly.
export const FRESH_MS = 15 * 60 * 1000;
// More recorded than this in one sync become one summary. To review items stay one each, up to
// MAX_REVIEW; more than that become one summary too.
export const GROUP_OVER = 3;
export const MAX_REVIEW = 5;

const PAYEE_MAX = 40;

export type SmsNotice = { id: string; title: string; body: string; url: string };

export const TRANSACTIONS_URL = "/transactions";
export const REVIEW_URL = "/review";

const MONEY_OUT = new Set(["debit", "card_spend"]);

export function needsReview(o: EntryOutcome): boolean {
  return o.status === "review" || o.status === "draft";
}

// Recorded money. A card statement is "recorded" too, but it moves no money: it only sets the card
// bill reminder, so it isn't a transaction to tell about.
export function wasRecorded(o: EntryOutcome): boolean {
  return o.status === "recorded" && o.kind !== "card_statement";
}

// The outcomes worth a notification: new to the server (not a duplicate or ignored) and received
// in the last FRESH_MS. Each message is posted once per sync and the server answers a repeat as
// "duplicate", so nothing is notified twice.
export function newOutcomes(outcomes: EntryOutcome[], now: number): EntryOutcome[] {
  return outcomes.filter(
    (o) => (wasRecorded(o) || needsReview(o)) && o.receivedAt > 0 && now - o.receivedAt <= FRESH_MS,
  );
}

function clipPayee(payee: string | null): string | null {
  const text = payee?.replace(/\s+/g, " ").trim() ?? "";
  if (text === "") return null;
  return text.length > PAYEE_MAX ? `${text.slice(0, PAYEE_MAX - 1).trimEnd()}…` : text;
}

// "₹450 at Swiggy", "₹50,000 received from ACME", "10 shares of RELIANCE".
export function headline(o: EntryOutcome): string {
  const payee = clipPayee(o.payee);
  if (o.kind === "demat") {
    const n = o.quantity ?? "";
    const shares = n === "" ? "Shares" : `${n} ${n === "1" ? "share" : "shares"}`;
    return payee ? `${shares} of ${payee}` : shares;
  }
  if (o.amount === null) return "A bank SMS";
  const amount = whole(o.amount);
  if (MONEY_OUT.has(o.kind)) return payee ? `${amount} at ${payee}` : `${amount} spent`;
  if (o.kind === "credit") return payee ? `${amount} received from ${payee}` : `${amount} received`;
  if (o.kind === "card_payment") return `${amount} card payment`;
  return `Card bill of ${amount}`;
}

// "HDFC Bank ••1234", or just the bank.
function source(o: EntryOutcome): string {
  return o.last4 ? `${bankName(o.bank)} ••${o.last4}` : bankName(o.bank);
}

function noticeId(o: EntryOutcome): string {
  return `sms-${o.hash.slice(0, 24)}`;
}

export function recordedNotice(o: EntryOutcome): SmsNotice {
  return {
    id: noticeId(o),
    title: headline(o),
    body: `Recorded from ${source(o)}. Tap to change.`,
    url: o.transactionId !== null ? `/transaction-form?id=${o.transactionId}` : TRANSACTIONS_URL,
  };
}

export function reviewNotice(o: EntryOutcome): SmsNotice {
  const title =
    o.status === "draft"
      ? `Confirm ${headline(o).replace(/^S/, "s")}`
      : o.reason === "category"
        ? `${headline(o)} needs a category`
        : `${headline(o)} needs your review`;
  return {
    id: noticeId(o),
    title,
    body: `From ${source(o)}. Tap to answer.`,
    url: o.entryId !== null ? `/review-item?id=${o.entryId}` : REVIEW_URL,
  };
}

// The notifications for one sync, recorded first. `now` is epoch ms.
export function planNotices(outcomes: EntryOutcome[], now: number): SmsNotice[] {
  const fresh = newOutcomes(outcomes, now);
  const recorded = fresh.filter(wasRecorded);
  const review = fresh.filter(needsReview);
  const notices: SmsNotice[] = [];

  if (recorded.length > GROUP_OVER) {
    notices.push({
      id: `sms-recorded-${now}`,
      title: `Recorded ${recorded.length} transactions from SMS`,
      body: "Tap to see them in Transactions.",
      url: TRANSACTIONS_URL,
    });
  } else {
    notices.push(...recorded.map(recordedNotice));
  }

  if (review.length > MAX_REVIEW) {
    notices.push({
      id: `sms-review-${now}`,
      title: `${review.length} bank SMS need your answer`,
      body: "Tap to answer them in To review.",
      url: REVIEW_URL,
    });
  } else {
    notices.push(...review.map(reviewNotice));
  }
  return notices;
}

const TARGETS = [/^\/transactions$/, /^\/review$/, /^\/transaction-form\?id=[1-9]\d{0,15}$/, /^\/review-item\?id=[1-9]\d{0,15}$/];

// Where a tapped SMS notification opens, or null when the data isn't one of ours.
export function smsNoticeTarget(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const { url, source: from } = data as { url?: unknown; source?: unknown };
  if (from !== "sms" || typeof url !== "string") return null;
  return TARGETS.some((t) => t.test(url)) ? url : null;
}

// What goes in the notification's data, read back by smsNoticeTarget.
export function noticeData(notice: SmsNotice): { source: "sms"; url: string } {
  return { source: "sms", url: notice.url };
}
