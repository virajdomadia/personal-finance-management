import assert from "node:assert/strict";
import { test } from "node:test";

import {
  amountInput,
  budgetLink,
  budgetPayload,
  budgetsById,
  budgetsHref,
  fullName,
  groupBudgets,
  leftText,
  monthNav,
  saveErrorText,
  spentOfText,
  unbudgetedOptions,
  usedText,
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
  colour: null,
  parent_id: null,
  parent_name: null,
  active: true,
  note: null,
  counted: true,
  since: "2026-11",
  ...o,
});

test("spent of, left or over by, and percent used come from the server's figures", () => {
  assert.equal(spentOfText(line()), "₹7,200.00 of ₹8,000.00");
  assert.equal(leftText(line()), "₹800.00 left");
  assert.equal(leftText(line({ over: true, remaining: "0.00", over_by: "200.00" })), "Over by ₹200.00");
  assert.equal(usedText(line({ percent: 120 })), "120% used");
  assert.equal(usedText(line({ percent: null })), "No budget amount");
});

test("groupBudgets puts subcategories under a budgeted parent and inactive budgets last", () => {
  const food = line();
  const dining = line({ category_id: 2, name: "Dining", parent_id: 1, parent_name: "Food and dining", counted: false });
  const fuel = line({ category_id: 5, name: "Fuel", parent_id: 4, parent_name: "Transport" });
  const old = line({ category_id: 9, name: "Old", active: false, note: "Archived" });
  const groups = groupBudgets([old, dining, fuel, food]);
  assert.deepEqual(
    groups.map((g) => [g.line.name, g.children.map((c) => c.name)]),
    [
      ["Fuel", []],
      ["Food and dining", ["Dining"]],
      ["Old", []],
    ],
  );
  assert.equal(fullName(fuel), "Transport › Fuel");
  assert.equal(fullName(food), "Food and dining");
});

test("unbudgetedOptions shows what each category has spent", () => {
  assert.deepEqual(
    unbudgetedOptions([
      { category_id: 3, name: "Shopping", icon: null, colour: null, parent_id: null, parent_name: null, spent: "1500.00" },
      { category_id: 7, name: "Cabs", icon: null, colour: null, parent_id: 4, parent_name: "Transport", spent: "0.00" },
    ]),
    [
      { value: "3", label: "Shopping · ₹1,500.00 spent" },
      { value: "7", label: "Transport › Cabs · ₹0.00 spent" },
    ],
  );
});

test("budgetPayload cleans the typed amount and sends a blank as null", () => {
  assert.deepEqual(budgetPayload(" ₹8,000 "), { amount: "8000" });
  assert.deepEqual(budgetPayload("1,00,000.50"), { amount: "100000.50" });
  assert.deepEqual(budgetPayload("  "), { amount: null });
  assert.equal(amountInput("8000.00"), "8000");
  assert.equal(amountInput("8000.50"), "8000.50");
});

test("saveErrorText shows the API's message", () => {
  assert.equal(
    saveErrorText(JSON.stringify({ detail: [{ loc: ["body", "amount"], msg: "Enter an amount above zero." }] })),
    "Enter an amount above zero.",
  );
  assert.equal(saveErrorText(JSON.stringify({ detail: "Category not found." })), "Category not found.");
  assert.equal(saveErrorText("<html>"), "We couldn't save that budget. Try again.");
  assert.equal(saveErrorText("{}"), "We couldn't save that budget. Try again.");
});

test("month navigation never goes past this month", () => {
  assert.deepEqual(monthNav({ month: "2026-11", is_current: true }), { previous: "2026-10", next: null });
  assert.deepEqual(monthNav({ month: "2026-01", is_current: false }), { previous: "2025-12", next: "2026-02" });
  assert.equal(budgetsHref("2026-11", "2026-11"), "/budgets");
  assert.equal(budgetsHref("2026-10", "2026-11"), "/budgets?month=2026-10");
});

test("budgetLink opens the category's spending in the month", () => {
  assert.equal(budgetLink("2026-11", line()), "/transactions?month=2026-11&category=Food+and+dining");
});

test("budgetsById keeps active budgets only", () => {
  const map = budgetsById({
    month: "2026-11",
    is_current: true,
    start: "2026-11-01",
    through: "2026-11-13",
    budgets: [line(), line({ category_id: 9, active: false })],
    total: line(),
    unbudgeted: [],
  });
  assert.deepEqual([...map.keys()], [1]);
  assert.equal(budgetsById(null).size, 0);
});
