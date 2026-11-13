import assert from "node:assert/strict";
import { test } from "node:test";

import {
  balanceText,
  budgetPartMeta,
  dayHeading,
  dueHeading,
  duePartMeta,
  groupByDay,
  isShort,
  itemAmountText,
  itemDetail,
  itemSpoken,
  safeText,
  untilText,
} from "./upcoming.ts";

const item = (o = {}) => ({
  date: "2026-11-15",
  kind: "recurring",
  name: "Rent",
  account_id: 1,
  account_name: "HDFC",
  amount: "20000.00",
  varies: false,
  direction: "out",
  overdue: false,
  balance_after: "42000.00",
  ref_id: 3,
  ...o,
});

test("safeText: a negative figure is money short", () => {
  assert.equal(safeText("16200.00"), "₹16,200");
  assert.equal(safeText("-3000.00"), "₹3,000 short");
  assert.equal(safeText("-0.00"), "₹0");
  assert.equal(isShort("-3000.00"), true);
  assert.equal(isShort("0.00"), false);
});

test("untilText and dueHeading", () => {
  assert.equal(untilText({ until: "2026-11-30", reason: "salary", payday: { name: "Salary", date: "2026-12-01" } }), "Until payday on 1 Dec");
  assert.equal(untilText({ until: "2026-11-30", reason: "month_end", payday: null }), "Until 30 Nov, the end of the month");
  assert.equal(dueHeading({ reason: "salary" }), "Due before payday");
  assert.equal(dueHeading({ reason: "month_end" }), "Due before the month ends");
});

test("groupByDay keeps the server's order", () => {
  const groups = groupByDay([item({ date: "2026-11-10" }), item({ date: "2026-11-15" }), item({ date: "2026-11-15", name: "SIP" })]);
  assert.deepEqual(
    groups.map((g) => [g.date, g.items.length]),
    [
      ["2026-11-10", 1],
      ["2026-11-15", 2],
    ],
  );
});

test("dayHeading", () => {
  assert.equal(dayHeading("2026-11-13", "2026-11-13"), "Today");
  assert.equal(dayHeading("2026-11-14", "2026-11-13"), "Tomorrow");
  assert.equal(dayHeading("2026-12-01", "2026-11-30"), "Tomorrow");
  assert.equal(dayHeading("2026-11-21", "2026-11-13"), "Sat, 21 Nov");
  assert.equal(dayHeading("2026-11-10", "2026-11-13"), "Tue, 10 Nov · overdue");
});

test("itemAmountText signs by direction", () => {
  assert.equal(itemAmountText(item()), "-₹20,000");
  assert.equal(itemAmountText(item({ direction: "in", amount: "50000.00" })), "+₹50,000");
  assert.equal(itemAmountText(item({ direction: "none", amount: "5000.00" })), "₹5,000");
  assert.equal(itemAmountText(item({ varies: true, kind: "card_bill" })), "Varies");
});

test("itemDetail and itemSpoken", () => {
  assert.deepEqual(itemDetail(item()), ["Reminder · HDFC"]);
  assert.deepEqual(itemDetail(item({ kind: "card_bill", varies: true, amount: "3400.00", account_name: null })), [
    "Card bill",
    "Amount varies: ₹3,400 owed so far",
  ]);
  assert.deepEqual(itemDetail(item({ kind: "goal", direction: "none", account_name: null })), ["Goal set-aside", "Doesn't change your balance now"]);
  assert.equal(itemSpoken(item({ overdue: true })), "Rent, overdue, Reminder · HDFC, out ₹20,000, Balance ₹42,000");
});

test("balanceText keeps the sign", () => {
  assert.equal(balanceText("-2000.00"), "Balance -₹2,000");
  assert.equal(balanceText("48000.50"), "Balance ₹48,000.50");
});

test("breakdown lines", () => {
  assert.equal(
    duePartMeta({ name: "Rent", amount: "20000.00", date: "2026-11-15", kind: "recurring", overdue: true, varies: false }),
    "Reminder · 15 Nov · overdue",
  );
  assert.equal(budgetPartMeta({ name: "Food", amount: "800.00", category_id: 1, remaining: "800.00", due: "0.00" }), "₹800 left this month");
  assert.equal(
    budgetPartMeta({ name: "Housing", amount: "0.00", category_id: 2, remaining: "20000.00", due: "20000.00" }),
    "₹20,000 left, less ₹20,000 in bills above",
  );
});
