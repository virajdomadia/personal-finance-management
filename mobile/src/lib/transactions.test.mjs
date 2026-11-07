import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankForm,
  changedPayload,
  formFromTransaction,
  formatDate,
  formatMonth,
  groupByDate,
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
