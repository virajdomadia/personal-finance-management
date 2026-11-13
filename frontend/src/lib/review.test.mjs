import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountChoices,
  accountHint,
  initialCategory,
  initialRemember,
  suggestionHint,
  actionsFor,
  approveBody,
  approveButtonText,
  approveResultText,
  categoryTotalText,
  confidentTotalsText,
  rememberLabel,
  expectedBody,
  needsNav,
  cardBillText,
  categoryType,
  marketPrefill,
  reviewCountText,
  reviewTitle,
  ruleText,
  trimSampleText,
} from "./review.ts";

const item = (o = {}) => ({
  id: 1,
  status: "review",
  kind: "debit",
  reason: "category",
  message: "New payee: Swiggy",
  amount: "250.00",
  date: "2026-11-10",
  payee: "Swiggy",
  last4: "1234",
  account_id: 3,
  account_name: "HDFC",
  transaction_id: 9,
  trade_id: null,
  isin: null,
  quantity: null,
  candidates: null,
  suggested_price: null,
  suggested_category: null,
  suggestion_source: null,
  history_count: 0,
  history_total: 0,
  suggested_account_id: null,
  confident: false,
  why: "First time for this payee",
  ...o,
});

const tx = (id) => ({ kind: "transaction", id, label: `₹250 on 10 Nov (${id})` });

test("reviewTitle names every reason", () => {
  const titles = {
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
  for (const [reason, title] of Object.entries(titles)) {
    assert.equal(reviewTitle(item({ reason })), title, reason);
  }
});

test("reviewTitle says a category item with no payee is new money", () => {
  assert.equal(reviewTitle(item({ payee: null })), "New payment");
  assert.equal(reviewTitle(item({ payee: null, kind: "credit" })), "New credit");
});

test("reviewTitle falls back for a reason it doesn't know", () => {
  assert.equal(reviewTitle(item({ reason: "something_new" })), "Check this message");
  assert.equal(reviewTitle(item({ reason: null })), "Check this message");
});

test("actionsFor gives each reason its buttons, dismiss last", () => {
  assert.deepEqual(actionsFor(item({ reason: "category" })), ["category", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "account" })), ["account", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "maybe_duplicate", candidates: [tx(4)] })), ["same", "new", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "maybe_transfer", candidates: [tx(4)] })), ["transfer", "category", "dismiss"]);
  assert.deepEqual(
    actionsFor(item({ reason: "card_payment", candidates: [tx(4), { kind: "account", id: 2, label: "SBI" }] })),
    ["transfer", "account", "dismiss"],
  );
  assert.deepEqual(
    actionsFor(item({ reason: "expected", candidates: [{ kind: "emi", id: 5, label: "Car loan EMI" }] })),
    ["expected", "category", "dismiss"],
  );
  assert.deepEqual(actionsFor(item({ reason: "sip_units", trade_id: 8 })), ["units", "units_ok", "dismiss"]);
  assert.deepEqual(
    actionsFor(item({ reason: "demat", status: "draft", kind: "demat", candidates: [{ kind: "stock", id: 6, label: "INFY" }] })),
    ["trade", "dismiss"],
  );
  assert.deepEqual(actionsFor(item({ reason: "balance" })), ["retry", "dismiss"]);
});

test("actionsFor leaves out answers that have nothing to choose from", () => {
  assert.deepEqual(actionsFor(item({ reason: "maybe_duplicate", candidates: null })), ["new", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "maybe_transfer", candidates: [] })), ["category", "dismiss"]);
  // Only accounts to choose from: no debit to turn into the transfer.
  assert.deepEqual(
    actionsFor(item({ reason: "card_payment", candidates: [{ kind: "account", id: 2, label: "SBI" }] })),
    ["account", "dismiss"],
  );
  assert.deepEqual(actionsFor(item({ reason: "card_payment", candidates: [tx(4)] })), ["transfer", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "expected", candidates: null })), ["category", "dismiss"]);
  // A share movement with no candidates is still confirmed, as a new stock.
  assert.deepEqual(actionsFor(item({ reason: "demat", kind: "demat", candidates: null })), ["trade", "dismiss"]);
});

test("actionsFor offers only dismiss for a reason it doesn't know", () => {
  assert.deepEqual(actionsFor(item({ reason: "something_new" })), ["dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: null })), ["dismiss"]);
});

test("categoryType reads money in as income, everything else as an expense", () => {
  assert.equal(categoryType(item({ kind: "credit" })), "income");
  assert.equal(categoryType(item({ kind: "debit" })), "expense");
  assert.equal(categoryType(item({ kind: "card_spend" })), "expense");
});

const acct = (id, type, name = `A${id}`) => ({ id, type, name });

test("accountChoices offers the accounts an SMS can belong to", () => {
  const accounts = [acct(1, "bank"), acct(2, "credit_card"), acct(3, "wallet"), acct(4, "cash"), acct(5, "loan"), acct(6, "ppf")];
  assert.deepEqual(
    accountChoices(item({ reason: "account", kind: "debit" }), accounts).map((a) => a.id),
    [1, 2, 3],
  );
  assert.deepEqual(
    accountChoices(item({ reason: "account", kind: "card_spend" }), accounts).map((a) => a.id),
    [2],
  );
  assert.deepEqual(
    accountChoices(item({ reason: "account", kind: "card_payment" }), accounts).map((a) => a.id),
    [2],
  );
  // A card bill is paid from the accounts the server listed.
  assert.deepEqual(
    accountChoices(
      item({ reason: "card_payment", kind: "card_payment", candidates: [tx(9), { kind: "account", id: 3, label: "Paytm" }] }),
      accounts,
    ).map((a) => a.id),
    [3],
  );
});

test("marketPrefill splits a market candidate into symbol and name", () => {
  assert.deepEqual(marketPrefill("INFY · Infosys Limited"), { symbol: "INFY", name: "Infosys Limited" });
  assert.deepEqual(marketPrefill("M&M · Mahindra · and Mahindra"), { symbol: "M&M", name: "Mahindra · and Mahindra" });
  assert.deepEqual(marketPrefill("TCS"), { symbol: "TCS", name: "" });
});

test("trimSampleText squeezes the whitespace and shortens a long message", () => {
  assert.equal(trimSampleText("  Rs XXX debited\n\nfrom  a/c "), "Rs XXX debited from a/c");
  assert.equal(trimSampleText("abcdefghij", 6), "abcde…");
  assert.equal(trimSampleText("abcdef", 6), "abcdef");
});

test("reviewCountText counts the messages", () => {
  assert.equal(reviewCountText(1), "1 message to check");
  assert.equal(reviewCountText(4), "4 messages to check");
});

test("cardBillText says which card, how much and when", () => {
  assert.equal(
    cardBillText({ account_id: 2, name: "HDFC Regalia", amount: "12500.00", due_date: "2026-12-05" }),
    "HDFC Regalia bill ₹12,500 due 5 Dec",
  );
  assert.equal(
    cardBillText({ account_id: 2, name: "Amex", amount: "1500.50", due_date: "2026-12-15" }),
    "Amex bill ₹1,500.50 due 15 Dec",
  );
});

const rule = (o = {}) => ({
  id: 1,
  payee_key: "swiggy",
  display: "Swiggy",
  category: null,
  to_account_id: null,
  to_account_name: null,
  template_id: null,
  template_name: null,
  ...o,
});

test("ruleText says what a rule does", () => {
  assert.equal(ruleText(rule({ category: "Food and dining" })), "Category: Food and dining");
  assert.equal(ruleText(rule({ to_account_id: 4, to_account_name: "SBI" })), "Transfer to SBI");
  assert.equal(ruleText(rule({ template_id: 3, template_name: "Rent" })), "Ticks off Rent");
  assert.equal(
    ruleText(rule({ category: "Housing", template_id: 3, template_name: "Rent" })),
    "Category: Housing · Ticks off Rent",
  );
});

test("actionsFor expected offers an EMI already recorded as the same payment", () => {
  const emi = { kind: "emi", id: 5, label: "Car loan EMI" };
  const recorded = { kind: "transaction", id: 9, label: "2026-11-10 · emi · ₹7,500" };
  assert.deepEqual(actionsFor(item({ reason: "expected", candidates: [emi, recorded] })), [
    "expected",
    "same",
    "category",
    "dismiss",
  ]);
});

test("needsNav and expectedBody send a NAV only for a SIP that needs one", () => {
  const sip = { kind: "sip", id: 3, label: "Flexi Cap SIP", needs_nav: true };
  const rent = { kind: "template", id: 4, label: "Rent" };
  const asked = item({ reason: "expected", payee: "Landlord", candidates: [sip, rent] });
  assert.equal(needsNav(asked), true);
  assert.equal(needsNav(item({ reason: "expected", candidates: [rent] })), false);
  assert.deepEqual(expectedBody(asked, sip, true, " 50.1 "), { action: "expected", kind: "sip", id: 3, remember: false, nav: "50.1" });
  assert.deepEqual(expectedBody(asked, sip, true, ""), { action: "expected", kind: "sip", id: 3, remember: false, nav: null });
  assert.deepEqual(expectedBody(asked, rent, true, "50.1"), { action: "expected", kind: "template", id: 4, remember: true });
  const known = { kind: "sip", id: 3, label: "Flexi Cap SIP" };
  assert.deepEqual(expectedBody(asked, known, true, "50.1"), { action: "expected", kind: "sip", id: 3, remember: false });
});

test("approveBody sends each confident item with the category it was shown", () => {
  const sure = item({ id: 4, confident: true, suggested_category: "Groceries" });
  const unsure = item({ id: 5, suggested_category: "Gift" });
  const ruleOnly = item({ id: 6, confident: true, suggested_category: "Gift", suggestion_source: "rule" });
  const later = item({ id: 7, confident: true, suggested_category: "Gift" }); // not in this batch
  const summary = { count: 2, total: 3, ids: [6, 4, 5], spent: "0.00", received: "0.00", categories: [] };
  assert.deepEqual(approveBody([sure, unsure, ruleOnly, later], summary), {
    items: [
      { id: 6, category: "Gift" },
      { id: 4, category: "Groceries" },
    ],
  });
  assert.equal(approveButtonText({ count: 3, total: 3 }), "Approve 3 confident");
  assert.equal(approveButtonText({ count: 200, total: 250 }), "Approve 200 of 250");
});

test("confidentTotalsText leaves out a side with nothing on it", () => {
  const summary = (spent, received) => ({ count: 2, spent, received, categories: [] });
  assert.equal(confidentTotalsText(summary("1240.00", "0.00")), "₹1,240 spent");
  assert.equal(confidentTotalsText(summary("120.75", "5000.00")), "₹120.75 spent · ₹5,000 received");
  assert.equal(confidentTotalsText(summary("0.00", "5000.00")), "₹5,000 received");
  assert.equal(categoryTotalText({ category: "Groceries", type: "expense", count: 3, amount: "1240.00" }), "Groceries · 3 · ₹1,240");
});

test("approveResultText says what was approved and what is left", () => {
  assert.equal(approveResultText({ approved: 1, skipped: [], learn: [] }), "Approved 1 message.");
  assert.equal(
    approveResultText({ approved: 4, skipped: [{ id: 2, reason: "Its suggestion changed" }], learn: [] }),
    "Approved 4 messages. 1 left to check.",
  );
});

test("rememberLabel names the category once one is picked", () => {
  assert.equal(rememberLabel("Ramesh", " Groceries "), "Always use Groceries for Ramesh");
  assert.equal(rememberLabel("Ramesh", "  "), "Always use this for Ramesh");
});

test("a suggestion fills the category only when confident", () => {
  const sure = item({ confident: true, suggested_category: "Groceries", suggestion_source: "history", history_count: 3, history_total: 3 });
  const unsure = item({ suggested_category: "Groceries", suggestion_source: "history", history_count: 3, history_total: 4 });
  const fresh = item();
  assert.equal(initialCategory(sure), "Groceries");
  assert.equal(initialCategory(unsure), "");
  assert.equal(initialRemember(sure), true);
  assert.equal(initialRemember(unsure), false);
  assert.equal(initialRemember(fresh), true);
  assert.equal(suggestionHint(unsure), "Usually Groceries (3 of 4 times)");
  assert.equal(suggestionHint(sure), null);
  assert.equal(suggestionHint(item({ suggested_category: "Gift", suggestion_source: "rule" })), "Suggested: Gift");
});

test("accountHint names the payee's usual account without choosing it", () => {
  const accounts = [{ id: 3, name: "HDFC" }, { id: 4, name: "SBI" }];
  assert.deepEqual(accountHint(item({ reason: "account", suggested_account_id: 4 }), accounts), { id: 4, name: "SBI" });
  assert.equal(accountHint(item({ reason: "account" }), accounts), null);
  assert.equal(accountHint(item({ reason: "account", suggested_account_id: 9 }), accounts), null);
});
