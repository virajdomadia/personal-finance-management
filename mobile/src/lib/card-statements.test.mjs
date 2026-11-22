import assert from "node:assert/strict";
import { test } from "node:test";

import {
  billLines,
  blankStatementForm,
  statementForm,
  statementPayload,
} from "./card-statements.ts";

const statement = {
  id: 1,
  account_id: 7,
  statement_date: "2026-11-03",
  total_due: "15000.00",
  minimum_due: "1500.00",
  due_date: "2026-11-23",
  source: "sms",
};
const bill = (over = {}) => ({
  statement,
  paid: "0.00",
  left: "15000.00",
  extra: "0.00",
  minimum_left: "1500.00",
  status: "unpaid",
  overdue: false,
  ...over,
});

test("an unpaid bill says what is due, and the minimum", () => {
  assert.deepEqual(billLines(bill()), ["Unpaid · ₹15,000.00 due 23 Nov 2026", "Minimum ₹1,500.00"]);
});

test("a part-paid bill says what is left, and what is left of the minimum", () => {
  assert.deepEqual(billLines(bill({ status: "part_paid", paid: "1000.00", left: "14000.00", minimum_left: "500.00" })), [
    "₹1,000.00 of ₹15,000.00 paid · ₹14,000.00 left",
    "Minimum ₹1,500.00 · ₹500.00 still to pay",
  ]);
});

test("once the minimum is paid only what is left is shown", () => {
  assert.deepEqual(billLines(bill({ status: "minimum_paid", paid: "1500.00", left: "13500.00", minimum_left: "0.00" })), [
    "Minimum paid · ₹13,500.00 left",
  ]);
});

test("a paid bill, and an overpaid one", () => {
  assert.deepEqual(billLines(bill({ status: "paid", paid: "15000.00", left: "0.00", minimum_left: "0.00" })), ["Paid"]);
  assert.deepEqual(billLines(bill({ status: "paid", paid: "15500.00", left: "0.00", extra: "500.00", minimum_left: "0.00" })), [
    "Paid · ₹500.00 more than the bill, which counts toward the next one",
  ]);
});

test("an overdue bill says so first", () => {
  assert.deepEqual(billLines(bill({ overdue: true }))[0], "Overdue · Unpaid · ₹15,000.00 due 23 Nov 2026");
});

test("a bill without a minimum leaves that line out", () => {
  assert.deepEqual(billLines(bill({ statement: { ...statement, minimum_due: null }, minimum_left: null })), [
    "Unpaid · ₹15,000.00 due 23 Nov 2026",
  ]);
});

test("the statement form starts today and sends cleaned money, a blank minimum as null", () => {
  const form = { ...blankStatementForm("2026-11-22"), total_due: "₹15,000", minimum_due: " ", due_date: "2026-12-12" };
  assert.equal(form.statement_date, "2026-11-22");
  assert.deepEqual(statementPayload(form), {
    statement_date: "2026-11-22",
    total_due: "15000",
    minimum_due: null,
    due_date: "2026-12-12",
  });
});

test("editing fills the form from the statement", () => {
  assert.deepEqual(statementForm(statement), {
    statement_date: "2026-11-03",
    total_due: "15000.00",
    minimum_due: "1500.00",
    due_date: "2026-11-23",
  });
  assert.equal(statementForm({ ...statement, minimum_due: null }).minimum_due, "");
});
