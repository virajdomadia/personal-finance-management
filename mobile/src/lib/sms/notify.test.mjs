import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FRESH_MS,
  REVIEW_URL,
  TRANSACTIONS_URL,
  headline,
  newOutcomes,
  noticeData,
  planNotices,
  recordedNotice,
  reviewNotice,
  smsNoticeTarget,
} from "./notify.ts";

const NOW = Date.parse("2026-11-17T10:00:00+05:30");
let n = 0;

function outcome(patch = {}) {
  n += 1;
  return {
    hash: `${String(n).padStart(4, "0")}${"a".repeat(60)}`,
    kind: "debit",
    bank: "hdfc",
    amount: "450.00",
    payee: "Swiggy",
    last4: "1234",
    quantity: null,
    receivedAt: NOW - 5_000,
    status: "recorded",
    reason: null,
    entryId: 10 + n,
    transactionId: 100 + n,
    ...patch,
  };
}

test("test_recorded_spend_is_worded_with_rupees_and_the_card", () => {
  const o = outcome({ transactionId: 77 });
  const notice = recordedNotice(o);
  assert.equal(notice.title, "₹450 at Swiggy");
  assert.equal(notice.body, "Recorded from HDFC Bank ••1234. Tap to change.");
  assert.equal(notice.url, "/transaction-form?id=77");
});

test("test_money_in_and_other_kinds_are_worded", () => {
  assert.equal(headline(outcome({ kind: "credit", amount: "50000.00", payee: "ACME" })), "₹50,000 received from ACME");
  assert.equal(headline(outcome({ kind: "credit", amount: "1250.50", payee: null })), "₹1,250.50 received");
  assert.equal(headline(outcome({ kind: "card_spend", amount: "1500000.00" })), "₹15,00,000 at Swiggy");
  assert.equal(headline(outcome({ kind: "debit", payee: "  " })), "₹450 spent");
  assert.equal(headline(outcome({ kind: "card_payment", amount: "5000.00" })), "₹5,000 card payment");
  assert.equal(headline(outcome({ kind: "demat", amount: null, quantity: "10", payee: "RELIANCE INDUSTRIES" })), "10 shares of RELIANCE INDUSTRIES");
  assert.equal(headline(outcome({ kind: "demat", amount: null, quantity: "1", payee: null })), "1 share");
  const long = headline(outcome({ payee: "A".repeat(80) }));
  assert.ok(long.length < 60 && long.endsWith("…"), "a long payee is clipped");
});

test("test_no_last4_names_only_the_bank", () => {
  assert.equal(recordedNotice(outcome({ last4: null, bank: "sbi" })).body, "Recorded from SBI. Tap to change.");
});

test("test_review_items_open_the_review_item", () => {
  const category = reviewNotice(outcome({ status: "review", reason: "category", entryId: 5 }));
  assert.equal(category.title, "₹450 at Swiggy needs a category");
  assert.equal(category.url, "/review-item?id=5");
  assert.equal(category.body, "From HDFC Bank ••1234. Tap to answer.");
  const account = reviewNotice(outcome({ status: "review", reason: "account" }));
  assert.equal(account.title, "₹450 at Swiggy needs your review");
  const draft = reviewNotice(outcome({ status: "draft", reason: "demat", kind: "demat", amount: null, quantity: "5", payee: "TCS" }));
  assert.equal(draft.title, "Confirm 5 shares of TCS");
});

test("test_missing_ids_fall_back_to_the_lists", () => {
  assert.equal(recordedNotice(outcome({ transactionId: null })).url, TRANSACTIONS_URL);
  assert.equal(reviewNotice(outcome({ status: "review", reason: "category", entryId: null })).url, REVIEW_URL);
});

test("test_only_new_and_fresh_outcomes_are_notified", () => {
  const kept = [outcome(), outcome({ status: "review", reason: "category" }), outcome({ status: "draft", kind: "demat" })];
  const dropped = [
    outcome({ status: "duplicate" }),
    outcome({ status: "ignored" }),
    outcome({ kind: "card_statement", status: "recorded" }), // moves no money
    outcome({ receivedAt: NOW - FRESH_MS - 1 }), // caught up on, not just arrived
    outcome({ receivedAt: 0 }),
  ];
  assert.deepEqual(newOutcomes([...dropped, ...kept], NOW), kept);
  // A statement that needs an answer is still notified.
  const statement = outcome({ kind: "card_statement", status: "review", reason: "account" });
  assert.deepEqual(newOutcomes([statement], NOW), [statement]);
});

test("test_up_to_three_recorded_are_one_each", () => {
  const notices = planNotices([outcome(), outcome(), outcome()], NOW);
  assert.equal(notices.length, 3);
  assert.equal(new Set(notices.map((x) => x.id)).size, 3);
});

test("test_more_than_three_recorded_become_one_summary_and_reviews_stay_separate", () => {
  const recorded = Array.from({ length: 5 }, () => outcome());
  const review = [outcome({ status: "review", reason: "category", entryId: 9 })];
  const notices = planNotices([...recorded, ...review, outcome({ status: "duplicate" })], NOW);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].title, "Recorded 5 transactions from SMS");
  assert.equal(notices[0].url, TRANSACTIONS_URL);
  assert.equal(notices[1].url, "/review-item?id=9");
});

test("test_many_review_items_become_one_summary", () => {
  const review = Array.from({ length: 6 }, () => outcome({ status: "review", reason: "category" }));
  const notices = planNotices(review, NOW);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "6 bank SMS need your answer");
  assert.equal(notices[0].url, REVIEW_URL);
  assert.equal(planNotices(review.slice(0, 5), NOW).length, 5);
});

test("test_nothing_new_means_no_notifications", () => {
  assert.deepEqual(planNotices([], NOW), []);
  assert.deepEqual(planNotices([outcome({ status: "duplicate" })], NOW), []);
});

test("test_notifications_never_carry_the_message_text", () => {
  const notices = planNotices([outcome(), outcome({ status: "review", reason: "category" })], NOW);
  for (const notice of notices) {
    assert.deepEqual(Object.keys(notice).sort(), ["body", "id", "title", "url"]);
    assert.deepEqual(Object.keys(noticeData(notice)).sort(), ["source", "url"]);
  }
});

test("test_tap_targets_are_checked", () => {
  for (const url of ["/transactions", "/review", "/transaction-form?id=12", "/review-item?id=3"]) {
    assert.equal(smsNoticeTarget({ source: "sms", url }), url);
  }
  assert.equal(smsNoticeTarget({ url: "/review" }), null, "not ours");
  assert.equal(smsNoticeTarget({ source: "sms", url: "/digest" }), null);
  assert.equal(smsNoticeTarget({ source: "sms", url: "/transaction-form?id=0" }), null);
  assert.equal(smsNoticeTarget({ source: "sms", url: "https://example.com" }), null);
  assert.equal(smsNoticeTarget(null), null);
  const notice = recordedNotice(outcome({ transactionId: 4 }));
  assert.equal(smsNoticeTarget(noticeData(notice)), "/transaction-form?id=4");
});
