import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDepositRules,
  blankForm,
  defaultAccountId,
  startForm,
  changedPayload,
  emiForm,
  subtractMoney,
  formFromTransaction,
  formatDate,
  formatMonth,
  fromOptions,
  groupByDate,
  incomeCategories,
  toOptions,
  previousDay,
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

test("previousDay crosses month and year boundaries", () => {
  assert.equal(previousDay("2026-01-15"), "2026-01-14");
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
  assert.equal(previousDay("2026-01-01"), "2025-12-31");
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

const acct = (id, type, extra = {}) => ({ id, type, name: `${type} ${id}`, archived: false, ...extra });
const bank = acct(1, "bank");
const bank2 = acct(2, "bank");
const cash = acct(3, "cash");
const ppf = acct(4, "ppf");
const rd = acct(5, "rd");
const loan = acct(6, "loan");
const card = acct(7, "credit_card");
const all = [bank, bank2, cash, ppf, rd, loan, card];
const form = (type, account_id = "", to_account_id = "", category = "") => ({ ...blankForm(type, "2026-01-01", null), account_id, to_account_id, category });
const ids = (list) => list.map((a) => a.id);

test("expense and EMI payers leave out PPF and RD", () => {
  assert.deepEqual(ids(fromOptions("expense", all, form("expense"))), [1, 2, 3, 6, 7]);
  assert.deepEqual(ids(fromOptions("emi", all, form("emi"))), [1, 2, 3, 7]);
});

test("income can be received in a deposit", () => {
  assert.deepEqual(ids(fromOptions("income", all, form("income"))), [1, 2, 3, 4, 5, 6, 7]);
});

test("a pre-selected account stays listed even if the rules would hide it", () => {
  assert.ok(ids(fromOptions("expense", all, form("expense", "5"))).includes(5));
});

test("a transfer into a deposit offers banks as the source, and out of one banks as the target", () => {
  assert.deepEqual(ids(fromOptions("transfer", all, form("transfer", "", "4"))), [1, 2]);
  assert.deepEqual(ids(toOptions(all, form("transfer", "4"))), [1, 2]);
  assert.deepEqual(ids(toOptions(all, form("transfer", "1"))), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ids(fromOptions("transfer", all, form("transfer", "", "1"))), [2, 3, 4, 5, 6, 7]);
});

test("archived banks are not offered next to a deposit", () => {
  const old = acct(9, "bank", { archived: true });
  assert.deepEqual(ids(toOptions([bank, old, ppf], form("transfer", "4"))), [1]);
});

test("income into a deposit offers only Interest", () => {
  assert.deepEqual(incomeCategories(all, form("income", "4"), ["Salary", "Interest"]), ["Interest"]);
  assert.deepEqual(incomeCategories(all, form("income", "1"), ["Salary", "Interest"]), ["Salary", "Interest"]);
});

test("applyDepositRules fixes what a change leaves invalid", () => {
  assert.equal(applyDepositRules(form("expense", "4"), all).account_id, "");
  assert.equal(applyDepositRules(form("emi", "5", "6"), all).account_id, "");
  assert.equal(applyDepositRules(form("income", "4", "", "Salary"), all).category, "Interest");
  assert.equal(applyDepositRules(form("transfer", "4", "3"), all).to_account_id, "");
  assert.equal(applyDepositRules(form("transfer", "3", "4"), all).account_id, "");
  const ok = form("transfer", "1", "4");
  assert.equal(applyDepositRules(ok, all), ok);
});

test("a non-bank source offers no deposits as the transfer target", () => {
  assert.deepEqual(ids(toOptions(all, form("transfer", "3"))), [1, 2, 6, 7]);
  assert.deepEqual(ids(toOptions(all, form("transfer", "7"))), [1, 2, 3, 6]);
  assert.deepEqual(ids(toOptions(all, form("transfer", "3", "4"))), [1, 2, 4, 6, 7]);
});

test("a new form never starts on a deposit", () => {
  assert.equal(defaultAccountId([ppf, rd, bank], null), 1);
  assert.equal(defaultAccountId([ppf], null), 4);
  assert.equal(defaultAccountId([], null), null);
  assert.equal(startForm([ppf, bank], "2026-01-01", null).account_id, "1");
  assert.equal(startForm([ppf, bank], "2026-01-01", 4).account_id, "");
  assert.equal(startForm([ppf, bank], "2026-01-01", 1).account_id, "1");
  assert.equal(startForm([ppf], "2026-01-01", null).account_id, "");
});
