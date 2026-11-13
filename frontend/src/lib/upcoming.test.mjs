import assert from "node:assert/strict";
import { test } from "node:test";

import {
  amountText,
  breakdown,
  budgetNote,
  dueLabel,
  itemMeta,
  safeFigure,
  signedAmountText,
  untilText,
} from "./upcoming.ts";

const safe = (o = {}) => ({
  amount: "16200.00",
  until: "2026-11-30",
  reason: "salary",
  payday: { name: "Salary", date: "2026-12-01" },
  money: "62000.00",
  due: "40000.00",
  goals: "5000.00",
  budgets: "800.00",
  money_items: [
    { name: "HDFC", amount: "60000.00" },
    { name: "Cash", amount: "2000.00" },
  ],
  due_items: [
    { name: "Rent", amount: "20000.00", date: "2026-11-15", kind: "recurring", overdue: false, varies: false },
    { name: "HDFC card", amount: "8000.00", date: "2026-11-25", kind: "card_bill", overdue: true, varies: true },
  ],
  goal_items: [{ name: "Bike", amount: "5000.00" }],
  budget_items: [
    { category_id: 1, name: "Food and dining", remaining: "800.00", due: "0.00", amount: "800.00" },
    { category_id: 2, name: "Housing", remaining: "20000.00", due: "20000.00", amount: "0.00" },
  ],
  ...o,
});

test("safeFigure shows a negative figure as short", () => {
  assert.deepEqual(safeFigure("16200.00"), { text: "₹16,200.00", short: false });
  assert.deepEqual(safeFigure("-3000.50"), { text: "₹3,000.50 short", short: true });
  assert.deepEqual(safeFigure("-0.00"), { text: "₹0.00", short: false });
});

test("untilText and dueLabel follow the server's window", () => {
  assert.equal(untilText(safe()), "until payday, Salary on 1 Dec");
  assert.equal(untilText(safe({ reason: "month_end", payday: null })), "until the end of the month");
  assert.equal(untilText(safe({ payday: null })), "until 30 Nov");
  assert.equal(dueLabel(safe()), "Due before payday");
  assert.equal(dueLabel(safe({ reason: "month_end" })), "Due by 30 Nov");
});

test("item amounts, signs and meta", () => {
  const item = { amount: "4250.00", varies: true, direction: "out", kind: "card_bill", account_name: "HDFC", overdue: true };
  assert.equal(amountText(item), "₹4,250.00 so far · amount varies");
  assert.equal(signedAmountText(item), "−₹4,250.00 so far · amount varies");
  assert.equal(signedAmountText({ ...item, varies: false, direction: "in" }), "+₹4,250.00");
  assert.equal(signedAmountText({ ...item, varies: false, direction: "none" }), "₹4,250.00");
  assert.equal(itemMeta(item), "Card bill · HDFC · overdue");
  assert.equal(itemMeta({ kind: "goal", account_name: null, overdue: false }), "Goal set-aside");
});

test("breakdown lists the four lines with their items", () => {
  const lines = breakdown(safe());
  assert.deepEqual(
    lines.map((l) => [l.sign, l.label, l.amount, l.items.length]),
    [
      ["", "Money now", "62000.00", 2],
      ["−", "Due before payday", "40000.00", 2],
      ["−", "Set aside for goals", "5000.00", 1],
      ["−", "Budgets left", "800.00", 2],
    ],
  );
  assert.deepEqual(lines[1].items[1], {
    key: "d1",
    label: "25 Nov · HDFC card",
    amount: "8000.00",
    note: "Card bill · overdue · amount varies",
  });
  assert.equal(lines[3].items[1].note, "₹20,000.00 left, less ₹20,000.00 in bills above");
  assert.equal(budgetNote({ remaining: "800.00", due: "0.00" }), "₹800.00 left");
});
