import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountChoices,
  actionsFor,
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
