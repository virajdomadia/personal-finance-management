import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDepositRules,
  blankForm,
  fromOptions,
  incomeCategories,
  newTransactionForm,
  toOptions,
  changedPayload,
  emiForm,
  subtractMoney,
  formFromTransaction,
  formatDate,
  formatMonth,
  groupByDate,
  renderedFields,
  shiftMonth,
  signedAmount,
  toPayload,
  todayIndia,
} from "./transactions.ts";

const expense = {
  id: 1,
  type: "expense",
  amount: "100.50",
  date: "2026-01-15",
  account_id: 7,
  account_name: "HDFC",
  to_account_id: null,
  to_account_name: null,
  category: "Groceries",
  interest: null,
  note: null,
  editable: true,
};
const transfer = {
  ...expense,
  id: 2,
  type: "transfer",
  to_account_id: 8,
  to_account_name: "Card",
  category: null,
};

test("blankForm starts on the given date and account", () => {
  const form = blankForm("expense", "2026-01-15", 7);
  assert.equal(form.type, "expense");
  assert.equal(form.date, "2026-01-15");
  assert.equal(form.account_id, "7");
  assert.equal(form.to_account_id, "");
});

test("blankForm leaves the account empty when there is none to preselect", () => {
  assert.equal(blankForm("income", "2026-01-15", null).account_id, "");
});

test("toPayload for an expense sends a category and no second account", () => {
  const form = { ...blankForm("expense", "2026-01-15", 7), amount: "₹1,00,000.50", category: " Food " };
  assert.deepEqual(toPayload(form, "create"), {
    type: "expense",
    amount: "100000.50",
    date: "2026-01-15",
    account_id: 7,
    category: "Food",
    note: null,
  });
});

test("toPayload for a transfer sends a second account and no category", () => {
  const form = {
    ...blankForm("transfer", "2026-01-15", 7),
    amount: "5",
    to_account_id: "8",
    category: "left over from another type",
    note: " Bill ",
  };
  assert.deepEqual(toPayload(form, "create"), {
    type: "transfer",
    amount: "5",
    date: "2026-01-15",
    account_id: 7,
    to_account_id: 8,
    note: "Bill",
  });
});

test("toPayload sends null for empty required fields so the server names them", () => {
  const payload = toPayload(blankForm("transfer", "", null), "create");
  assert.equal(payload.amount, null);
  assert.equal(payload.date, null);
  assert.equal(payload.account_id, null);
  assert.equal(payload.to_account_id, null);
});

test("toPayload in edit mode leaves out the type", () => {
  assert.equal("type" in toPayload(formFromTransaction(expense), "edit"), false);
});

test("changedPayload is empty when nothing changed", () => {
  assert.deepEqual(changedPayload(formFromTransaction(expense), expense), {});
  assert.deepEqual(changedPayload(formFromTransaction(transfer), transfer), {});
});

test("changedPayload sends only what changed", () => {
  const form = { ...formFromTransaction(expense), amount: "20", note: "Lunch" };
  assert.deepEqual(changedPayload(form, expense), { amount: "20", note: "Lunch" });
});

test("changedPayload clears a removed note with null", () => {
  const original = { ...expense, note: "Lunch" };
  const form = { ...formFromTransaction(original), note: "  " };
  assert.deepEqual(changedPayload(form, original), { note: null });
});

test("renderedFields follows the type", () => {
  assert.ok(renderedFields("expense").includes("category"));
  assert.ok(!renderedFields("expense").includes("to_account_id"));
  assert.ok(renderedFields("transfer").includes("to_account_id"));
  assert.ok(!renderedFields("transfer").includes("category"));
});

test("signedAmount shows expense as out and income as in", () => {
  assert.equal(signedAmount(expense), "-₹100.50");
  assert.equal(signedAmount({ ...expense, type: "income" }), "+₹100.50");
});

test("signedAmount leaves a transfer unsigned without an account in view", () => {
  assert.equal(signedAmount(transfer), "₹100.50");
});

test("signedAmount signs a transfer from the viewed account's side", () => {
  assert.equal(signedAmount(transfer, 7), "-₹100.50");
  assert.equal(signedAmount(transfer, 8), "+₹100.50");
});

test("shiftMonth crosses year boundaries both ways", () => {
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-06", 1), "2026-07");
});

test("formatMonth and formatDate read the text directly", () => {
  assert.equal(formatMonth("2026-01"), "January 2026");
  assert.equal(formatDate("2026-11-05"), "5 Nov 2026");
});

test("todayIndia uses India's date, not UTC's", () => {
  assert.equal(todayIndia(new Date("2026-01-14T19:00:00Z")), "2026-01-15");
  assert.equal(todayIndia(new Date("2026-01-14T18:00:00Z")), "2026-01-14");
});

test("groupByDate keeps order and groups neighbours by date", () => {
  const a = { ...expense, id: 1, date: "2026-01-20" };
  const b = { ...expense, id: 2, date: "2026-01-20" };
  const c = { ...expense, id: 3, date: "2026-01-10" };
  assert.deepEqual(groupByDate([a, b, c]), [
    { date: "2026-01-20", transactions: [a, b] },
    { date: "2026-01-10", transactions: [c] },
  ]);
});

const emi = {
  ...expense,
  id: 3,
  type: "emi",
  amount: "7500.00",
  to_account_id: 9,
  to_account_name: "Card loan",
  category: "Loan interest",
  interest: "289.33",
};

test("toPayload for an EMI sends the loan and interest, never a category", () => {
  const form = { ...formFromTransaction(emi), interest: " ₹1,289.33 " };
  const payload = toPayload(form, "create");
  assert.equal(payload.to_account_id, 9);
  assert.equal(payload.interest, "1289.33");
  assert.equal("category" in payload, false);
});

test("an untouched EMI has nothing to save", () => {
  assert.deepEqual(changedPayload(formFromTransaction(emi), emi), {});
  assert.deepEqual(changedPayload({ ...formFromTransaction(emi), interest: "300" }, emi), { interest: "300" });
});

test("renderedFields for an EMI", () => {
  assert.deepEqual(renderedFields("emi"), ["amount", "date", "account_id", "to_account_id", "interest", "note"]);
});

test("signedAmount shows an EMI as out, and only its principal into the loan", () => {
  assert.equal(signedAmount(emi), "-₹7,500.00");
  assert.equal(signedAmount(emi, 7), "-₹7,500.00");
  assert.equal(signedAmount(emi, 9), "+₹7,210.67");
});

test("emiForm pre-fills the suggested split and the usual account", () => {
  const loan = {
    id: 9,
    pay_from_id: 7,
    emi_amount: "7500.00",
    next_emi: { amount: "7500.00", interest: "289.33", principal: "7210.67" },
  };
  const form = emiForm(loan, "2026-11-08");
  assert.equal(form.type, "emi");
  assert.equal(form.account_id, "7");
  assert.equal(form.to_account_id, "9");
  assert.equal(form.amount, "7500.00");
  assert.equal(form.interest, "289.33");
  const unknown = emiForm({ ...loan, pay_from_id: null, next_emi: { amount: "300.00", interest: null, principal: null } }, "2026-11-08");
  assert.equal(unknown.account_id, "");
  assert.equal(unknown.interest, "");
});

test("subtractMoney is exact and refuses what isn't a plain amount", () => {
  assert.equal(subtractMoney("7500.00", "289.33"), "7210.67");
  assert.equal(subtractMoney("0.1", "0.2"), "-0.10");
  assert.equal(subtractMoney("100", "0"), "100.00");
  assert.equal(subtractMoney("100", "abc"), "");
  assert.equal(subtractMoney("1.234", "1"), "");
});

const acct = (id, type) => ({ id, type, name: `${type}${id}` });
const set = [acct(1, "bank"), acct(2, "cash"), acct(3, "ppf"), acct(4, "rd"), acct(5, "loan")];
const ids = (list) => list.map((a) => a.id);
const f = (o) => ({ ...blankForm("expense", "2026-01-01", null), ...o });

test("expense and EMI 'paid from' leave out PPF and RD", () => {
  assert.deepEqual(ids(fromOptions("expense", set, f())), [1, 2, 5]);
  assert.deepEqual(ids(fromOptions("emi", set, f({ type: "emi" }))), [1, 2]);
});

test("income 'received in' allows deposits", () => {
  assert.deepEqual(ids(fromOptions("income", set, f({ type: "income" }))), [1, 2, 3, 4, 5]);
});

test("transfer pickers list banks only against a deposit, and never the other side", () => {
  const toDeposit = f({ type: "transfer", to_account_id: "3" });
  assert.deepEqual(ids(fromOptions("transfer", set, toDeposit)), [1]);
  const fromDeposit = f({ type: "transfer", account_id: "4" });
  assert.deepEqual(ids(toOptions(set, fromDeposit)), [1]);
  const fromBank = f({ type: "transfer", account_id: "1" });
  assert.deepEqual(ids(toOptions(set, fromBank)), [2, 3, 4, 5]);
});

test("a pre-selected account stays listed even when the rules would hide it", () => {
  assert.deepEqual(ids(fromOptions("expense", set, f({ account_id: "3" }))), [1, 2, 3, 5]);
  assert.deepEqual(ids(toOptions(set, f({ type: "transfer", account_id: "3", to_account_id: "2" }))), [1, 2]);
});

test("income categories narrow to Interest for a deposit", () => {
  const cats = ["Salary", "Interest"];
  assert.deepEqual(incomeCategories(set, f({ type: "income", account_id: "3" }), cats), ["Interest"]);
  assert.deepEqual(incomeCategories(set, f({ type: "income", account_id: "1" }), cats), cats);
});

test("applyDepositRules sets Interest and clears refused picks", () => {
  assert.equal(applyDepositRules(f({ type: "income", account_id: "4", category: "Salary" }), set).category, "Interest");
  assert.equal(applyDepositRules(f({ type: "expense", account_id: "3" }), set).account_id, "");
  assert.equal(applyDepositRules(f({ type: "transfer", account_id: "3", to_account_id: "2" }), set).to_account_id, "");
  assert.equal(applyDepositRules(f({ type: "transfer", account_id: "2", to_account_id: "3" }), set).account_id, "");
  const ok = f({ type: "transfer", account_id: "1", to_account_id: "3" });
  assert.deepEqual(applyDepositRules(ok, set), ok);
});

test("a new form never starts on a deposit the expense can't be paid from", () => {
  assert.equal(newTransactionForm("2026-01-01", 3, set).account_id, "");
  assert.equal(newTransactionForm("2026-01-01", 1, set).account_id, "1");
  assert.equal(newTransactionForm("2026-01-01", null, set).account_id, "");
});

test("transfer pickers leave deposits out against a non-bank account", () => {
  assert.deepEqual(ids(toOptions(set, f({ type: "transfer", account_id: "2" }))), [1, 5]);
  assert.deepEqual(ids(fromOptions("transfer", set, f({ type: "transfer", to_account_id: "2" }))), [1, 5]);
  assert.deepEqual(ids(toOptions(set, f({ type: "transfer", account_id: "1" }))), [2, 3, 4, 5]);
});
