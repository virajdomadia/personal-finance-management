import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountChoices,
  actionsFor,
  approveBody,
  approveButtonText,
  approveResultText,
  categoryTotalText,
  confidentTotalsText,
  rememberLabel,
  whyLine,
  expectedBody,
  needsNav,
  bankName,
  cardBillText,
  categoryBody,
  categoryType,
  earliestStartDate,
  expectedChoices,
  marketPrefill,
  readTimeText,
  reviewCountText,
  reviewDetails,
  reviewFigure,
  reviewTitle,
  ruleText,
  samplePayload,
  smsStatus,
  tradeBody,
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
    maybe_duplicate: "Already added?",
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

test("reviewTitle falls back for an unknown reason", () => {
  assert.equal(reviewTitle(item({ reason: "something_new" })), "Check this message");
  assert.equal(reviewTitle(item({ reason: null })), "Check this message");
});

test("actionsFor category and account", () => {
  assert.deepEqual(actionsFor(item({ reason: "category" })), ["category", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "account" })), ["account", "dismiss"]);
});

test("actionsFor maybe_duplicate needs a transaction for same", () => {
  assert.deepEqual(actionsFor(item({ reason: "maybe_duplicate", candidates: [tx(4)] })), ["same", "new", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "maybe_duplicate", candidates: [] })), ["new", "dismiss"]);
});

test("actionsFor maybe_transfer offers not a transfer always", () => {
  assert.deepEqual(actionsFor(item({ reason: "maybe_transfer", candidates: [tx(4)] })), ["transfer", "category", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "maybe_transfer", candidates: null })), ["category", "dismiss"]);
});

test("actionsFor card_payment shows only what it has candidates for", () => {
  const account = { kind: "account", id: 2, label: "SBI" };
  assert.deepEqual(actionsFor(item({ reason: "card_payment", candidates: [tx(4), account] })), ["transfer", "account", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "card_payment", candidates: [account] })), ["account", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "card_payment", candidates: [tx(4)] })), ["transfer", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "card_payment", candidates: [] })), ["dismiss"]);
});

test("actionsFor expected falls back to a category", () => {
  assert.deepEqual(
    actionsFor(item({ reason: "expected", candidates: [{ kind: "template", id: 5, label: "Rent" }] })),
    ["expected", "category", "dismiss"],
  );
  assert.deepEqual(actionsFor(item({ reason: "expected", candidates: [] })), ["category", "dismiss"]);
});

test("actionsFor sip_units, demat, balance and unknown", () => {
  assert.deepEqual(actionsFor(item({ reason: "sip_units", trade_id: 8 })), ["units", "units_ok", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "demat", status: "draft" })), ["trade", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "balance" })), ["retry", "dismiss"]);
  assert.deepEqual(actionsFor(item({ reason: "something_new" })), ["dismiss"]);
});

test("expectedChoices keeps EMIs, SIPs and reminders only", () => {
  const list = [tx(1), { kind: "emi", id: 2, label: "Car loan" }, { kind: "sip", id: 3, label: "Index SIP" }, { kind: "template", id: 4, label: "Rent" }];
  assert.deepEqual(
    expectedChoices(item({ reason: "expected", candidates: list })).map((c) => c.kind),
    ["emi", "sip", "template"],
  );
});

test("categoryType: money in is income", () => {
  assert.equal(categoryType(item({ kind: "credit" })), "income");
  assert.equal(categoryType(item({ kind: "debit" })), "expense");
  assert.equal(categoryType(item({ kind: "card_spend" })), "expense");
});

test("accountChoices: card messages need a card, others a bank, wallet or card", () => {
  const accounts = [
    { id: 1, type: "bank" },
    { id: 2, type: "credit_card" },
    { id: 3, type: "wallet" },
    { id: 4, type: "broker" },
    { id: 5, type: "cash" },
  ];
  assert.deepEqual(accountChoices(item({ reason: "account", kind: "debit" }), accounts).map((a) => a.id), [1, 2, 3]);
  assert.deepEqual(accountChoices(item({ reason: "account", kind: "card_spend" }), accounts).map((a) => a.id), [2]);
  assert.deepEqual(
    accountChoices(item({ reason: "card_payment", kind: "card_payment", candidates: [{ kind: "account", id: 3, label: "Paytm" }] }), accounts).map(
      (a) => a.id,
    ),
    [3],
  );
});

test("categoryBody remembers only when there is a payee", () => {
  assert.deepEqual(categoryBody(item(), " Food and dining ", true), { action: "category", category: "Food and dining", remember: true });
  assert.deepEqual(categoryBody(item({ payee: null }), "Food", true), { action: "category", category: "Food", remember: false });
  assert.deepEqual(categoryBody(item(), "  ", false), { action: "category", category: null, remember: false });
});

test("tradeBody for an owned stock, a market listing and a new stock", () => {
  const base = { brokerId: 7, price: " ₹1,234.50 ", charges: "", side: null };
  assert.deepEqual(tradeBody({ ...base, stock: { kind: "stock", id: 3 }, symbol: "X", name: "Y" }), {
    action: "trade",
    stock_id: 3,
    account_id: 7,
    price: "1234.50",
    charges: "0",
    symbol: null,
    name: null,
    side: null,
  });
  assert.deepEqual(tradeBody({ ...base, stock: null, symbol: " INFY ", name: " Infosys ", side: "buy", charges: "20" }), {
    action: "trade",
    stock_id: null,
    account_id: 7,
    price: "1234.50",
    charges: "20",
    symbol: "INFY",
    name: "Infosys",
    side: "buy",
  });
  assert.equal(tradeBody({ ...base, brokerId: null, stock: null, symbol: "", name: "", price: "" }).price, null);
});

test("marketPrefill splits symbol and name", () => {
  assert.deepEqual(marketPrefill("INFY · Infosys Limited"), { symbol: "INFY", name: "Infosys Limited" });
  assert.deepEqual(marketPrefill("TCS"), { symbol: "TCS", name: "" });
});

test("reviewCountText", () => {
  assert.equal(reviewCountText(1), "1 message to check");
  assert.equal(reviewCountText(4), "4 messages to check");
});

test("cardBillText uses the API's amount as text", () => {
  assert.equal(cardBillText({ account_id: 2, name: "Regalia", amount: "12500.00", due_date: "2026-12-05" }), "Regalia bill ₹12,500 due 5 Dec");
  assert.equal(cardBillText({ account_id: 2, name: "Regalia", amount: "12500.50", due_date: "2026-12-05" }), "Regalia bill ₹12,500.50 due 5 Dec");
});

test("ruleText describes each part", () => {
  const rule = { id: 1, payee_key: "swiggy", display: "Swiggy", category: "Food", to_account_id: null, to_account_name: null, template_id: null, template_name: null };
  assert.equal(ruleText(rule), "Category: Food");
  assert.equal(ruleText({ ...rule, category: null, to_account_id: 3, to_account_name: "SBI" }), "Transfer to SBI");
  assert.equal(ruleText({ ...rule, template_id: 4, template_name: "Rent" }), "Category: Food · Ticks off Rent");
});

test("samplePayload masks the text and never sends it raw", () => {
  const sms = { id: "1", address: "VM-HDFCBK-S", body: "Rs 450.00 sent to Ramesh Kumar on 12-11-26 Ref 123456789", date: 0 };
  const sample = samplePayload(sms);
  assert.equal(sample.sender, "VM-HDFCBK-S");
  assert.ok(!sample.text.includes("123456789"));
  assert.ok(!sample.text.includes("Ramesh"));
  assert.ok(sample.text.includes("<name>"));
});

test("samplePayload clips to what the server takes", () => {
  const sample = samplePayload({ id: "1", address: "AB-VERYLONGSENDERNAME-S", body: "word ".repeat(200), date: 0 });
  assert.equal(sample.sender.length, 20);
  assert.ok(sample.text.length <= 500);
  assert.equal(sample.text, sample.text.trim());
});

test("earliestStartDate is 90 days back", () => {
  assert.equal(earliestStartDate("2026-11-12"), "2026-08-14");
  assert.equal(earliestStartDate("2026-03-01"), "2025-12-01");
});

test("readTimeText in India time", () => {
  const now = new Date("2026-11-12T10:00:00+05:30");
  assert.equal(readTimeText(0, now), "Not yet");
  assert.equal(readTimeText(new Date("2026-11-12T09:05:00+05:30").getTime(), now), "Today, 9:05 am");
  assert.equal(readTimeText(new Date("2026-11-11T21:30:00+05:30").getTime(), now), "11 Nov, 9:30 pm");
  assert.equal(readTimeText(new Date("2026-11-12T00:10:00+05:30").getTime(), now), "Today, 12:10 am");
  assert.equal(readTimeText(new Date("2026-11-11T12:00:00+05:30").getTime(), now), "11 Nov, 12:00 pm");
});

test("bankName names known banks and falls back to capitals", () => {
  assert.equal(bankName("hdfc"), "HDFC Bank");
  assert.equal(bankName("cdsl"), "CDSL");
  assert.equal(bankName("newbank"), "NEWBANK");
});

test("smsStatus: off, unavailable, stopped, on", () => {
  const s = (o = {}) => ({ enabled: true, stoppedAt: 0, ...o });
  assert.equal(smsStatus(s(), false), "unavailable");
  assert.equal(smsStatus(s({ enabled: false }), true), "off");
  assert.equal(smsStatus(s({ stoppedAt: 5 }), true), "stopped");
  assert.equal(smsStatus(s({ enabled: false, stoppedAt: 5 }), true), "off");
  assert.equal(smsStatus(s(), true), "on");
});

test("reviewDetails and reviewFigure show what the API sent", () => {
  assert.equal(reviewDetails(item()), "Swiggy · HDFC •••• 1234 · 10 Nov 2026");
  assert.equal(reviewDetails(item({ payee: null, account_name: null, last4: null })), "10 Nov 2026");
  assert.equal(reviewFigure(item({ amount: "12500.00" })), "₹12,500.00");
  assert.equal(reviewFigure(item({ amount: null, quantity: "221" })), "221 shares");
  assert.equal(reviewFigure(item({ amount: null, quantity: "1" })), "1 share");
  assert.equal(reviewFigure(item({ amount: null, quantity: null })), undefined);
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
  assert.deepEqual(approveBody([sure, unsure]), { items: [{ id: 4, category: "Groceries" }] });
  assert.equal(approveButtonText(2), "Approve 2 confident");
});

test("confidentTotalsText and categoryTotalText format the server's totals", () => {
  const summary = (spent, received) => ({ count: 2, spent, received, categories: [] });
  assert.equal(confidentTotalsText(summary("1240.00", "0.00")), "₹1,240 out");
  assert.equal(confidentTotalsText(summary("120.75", "5000.00")), "₹120.75 out · ₹5,000 in");
  assert.equal(categoryTotalText({ category: "Groceries", type: "expense", count: 3, amount: "1240.00" }), "3 × Groceries  ₹1,240");
});

test("approveResultText and whyLine", () => {
  assert.equal(approveResultText({ approved: 3, skipped: [], learn: [] }), "Approved 3. All set.");
  assert.equal(approveResultText({ approved: 3, skipped: [{ id: 1, reason: "x" }], learn: [] }), "Approved 3. 1 still needs you.");
  assert.equal(whyLine(item({ confident: true, why: "Payee rule: Gift" })), "✓ Payee rule: Gift");
  assert.equal(whyLine(item()), "First time for this payee");
  assert.equal(rememberLabel("Ramesh", "Gift"), "Always use Gift for Ramesh");
  assert.equal(rememberLabel("Ramesh", ""), "Always use this for Ramesh");
});
