import assert from "node:assert/strict";
import { test } from "node:test";

import {
  amountInput,
  barFill,
  budgetAmountError,
  budgetErrorText,
  budgetGroups,
  budgetMonthLabel,
  budgetPath,
  budgetPayload,
  budgetSpoken,
  budgetsPath,
  isMonth,
  leftText,
  nextMonth,
  percentText,
  previousMonth,
  spentOfText,
  unbudgetedSpentText,
} from "./budgets.ts";

const line = (o = {}) => ({
  amount: "8000.00",
  spent: "7200.00",
  left: "800.00",
  remaining: "800.00",
  over_by: "0.00",
  percent: 90,
  bar: 90,
  over: false,
  category_id: 1,
  name: "Food and dining",
  icon: "food",
  colour: "#f3a712",
  parent_id: null,
  parent_name: null,
  active: true,
  note: null,
  counted: true,
  since: "2026-11",
  ...o,
});

test("paths", () => {
  assert.equal(budgetsPath(null), "/budgets");
  assert.equal(budgetsPath("2026-10"), "/budgets?month=2026-10");
  assert.equal(budgetPath(12), "/budgets/12");
});

test("month helpers", () => {
  assert.equal(budgetMonthLabel("2026-11"), "November 2026");
  assert.equal(previousMonth("2026-01"), "2025-12");
  assert.equal(previousMonth("2026-11"), "2026-10");
  assert.equal(nextMonth("2026-12"), "2027-01");
  assert.equal(nextMonth("2026-09"), "2026-10");
  assert.equal(isMonth("2026-11"), true);
  assert.equal(isMonth("2026-13"), false);
  assert.equal(isMonth("0999-01"), false);
  assert.equal(isMonth(undefined), false);
});

test("budgetGroups puts a subcategory under its budgeted parent", () => {
  const food = line();
  const dining = line({ category_id: 2, name: "Dining", parent_id: 1, parent_name: "Food and dining" });
  const fuel = line({ category_id: 5, name: "Fuel", parent_id: 4, parent_name: "Transport" });
  const groups = budgetGroups([food, fuel, dining]);
  assert.deepEqual(
    groups.map((g) => [g.line.name, g.children.map((c) => c.name)]),
    [
      ["Food and dining", ["Dining"]],
      ["Fuel", []],
    ],
  );
});

test("figures are worded, not worked out", () => {
  assert.equal(spentOfText(line()), "₹7,200 of ₹8,000");
  assert.equal(leftText(line()), "₹800 left");
  assert.equal(leftText(line({ over: true, over_by: "200.00", remaining: "0.00" })), "Over by ₹200");
  assert.equal(percentText(line({ percent: 120 })), "120%");
  assert.equal(percentText(line({ percent: null })), "–");
  assert.equal(barFill(line({ bar: 100 })), 100);
  assert.equal(barFill(line({ bar: null })), 0);
  assert.equal(barFill(line({ bar: 140 })), 100);
});

test("budgetSpoken says the parent and why it is inactive", () => {
  assert.equal(budgetSpoken(line()), "Food and dining, ₹7,200 of ₹8,000 spent, ₹800 left, 90% used");
  const dining = line({ name: "Dining", parent_id: 1, parent_name: "Food", active: false, note: "Dining is archived." });
  assert.match(budgetSpoken(dining), /in Food, .*Dining is archived\.$/);
});

test("unbudgetedSpentText", () => {
  assert.equal(unbudgetedSpentText({ spent: "1200.00" }, true), "₹1,200 spent this month");
  assert.equal(unbudgetedSpentText({ spent: "0.00" }, true), "Nothing spent this month");
  assert.equal(unbudgetedSpentText({ spent: "0.00" }, false), "Nothing spent that month");
});

test("budget amount: checked like the server, sent as typed", () => {
  assert.equal(budgetAmountError(""), "Enter the budget amount.");
  assert.equal(budgetAmountError("0"), "Amount must be greater than 0.");
  assert.equal(budgetAmountError("abc"), "Enter an amount, like 1234.50.");
  assert.equal(budgetAmountError("₹8,000"), null);
  assert.deepEqual(budgetPayload(" ₹8,000.50 "), { amount: "8000.50" });
  assert.equal(amountInput("8000.00"), "8000");
  assert.equal(amountInput("8000.50"), "8000.50");
  assert.equal(amountInput(undefined), "");
});

test("budgetErrorText shows the server's message", () => {
  const amount = [{ loc: ["body", "amount"], msg: "Enter an amount above zero." }];
  assert.deepEqual(budgetErrorText(amount), { amount: "Enter an amount above zero.", general: [] });
  const other = [{ loc: ["body", "category_id"], msg: "Food is archived. Restore it to set a budget." }];
  assert.deepEqual(budgetErrorText(other), { amount: null, general: ["Food is archived. Restore it to set a budget."] });
});
