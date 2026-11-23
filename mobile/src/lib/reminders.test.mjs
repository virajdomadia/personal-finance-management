import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BUDGETS_URL,
  CALENDAR_URL,
  MAX_DUE,
  budgetLevel,
  dueText,
  parsePref,
  parseSent,
  planBudgetAlerts,
  planDueReminders,
  prefValue,
  reminderTarget,
} from "./reminders.ts";

const item = (o = {}) => ({
  date: "2026-11-20",
  kind: "emi",
  name: "Car loan",
  account_id: 1,
  account_name: "HDFC",
  amount: "12000.00",
  varies: false,
  direction: "out",
  overdue: false,
  balance_after: "42000.00",
  ref_id: 3,
  ...o,
});

// 17 Nov 2026, 8 am phone time.
const NOW = new Date(2026, 10, 17, 8, 0);

test("planDueReminders: the day before and the day, at 9 am", () => {
  const plan = planDueReminders([item()], NOW);
  assert.deepEqual(
    plan.map((r) => [r.id, r.at.getDate(), r.at.getHours()]),
    [
      ["due-emi-3-2026-11-20-1", 19, 9],
      ["due-emi-3-2026-11-20-0", 20, 9],
    ],
  );
  assert.equal(plan[0].title, "EMI due tomorrow: Car loan");
  assert.equal(plan[0].body, "₹12,000 from HDFC. Keep the balance ready.");
  assert.equal(plan[1].title, "EMI due today: Car loan");
  assert.equal(plan[0].url, CALENDAR_URL); // a due reminder opens the spending calendar
});

test("planDueReminders: a premium is reminded a week ahead too", () => {
  const plan = planDueReminders([item({ kind: "insurance", name: "Star Health", date: "2026-11-30" })], NOW);
  assert.deepEqual(plan.map((r) => r.id.split("-").pop()), ["7", "1", "0"]);
  assert.equal(plan[0].title, "Star Health premium due on 30 Nov");
});

test("planDueReminders: past times, overdue items and goals are left out", () => {
  const plan = planDueReminders(
    [
      item({ date: "2026-11-17" }), // today at 9 is still ahead; yesterday's reminder is past
      item({ date: "2026-11-15", overdue: true, ref_id: 4 }),
      item({ kind: "goal", ref_id: 5 }),
    ],
    NOW,
  );
  assert.deepEqual(plan.map((r) => r.id), ["due-emi-3-2026-11-17-0"]);
  assert.deepEqual(planDueReminders([item({ date: "2026-11-17" })], new Date(2026, 10, 17, 9, 30)), []);
});

test("planDueReminders: soonest first and capped", () => {
  const many = Array.from({ length: 50 }, (_, i) => item({ ref_id: i, date: `2026-12-${String((i % 28) + 1).padStart(2, "0")}` }));
  const plan = planDueReminders(many, NOW);
  assert.equal(plan.length, MAX_DUE);
  for (let i = 1; i < plan.length; i += 1) assert.ok(plan[i - 1].at <= plan[i].at);
});

test("dueText: each kind reads right", () => {
  assert.deepEqual(dueText(item({ kind: "card_bill", name: "HDFC Regalia", varies: true, amount: "8400.00" }), 1), {
    title: "HDFC Regalia bill due tomorrow",
    body: "₹8,400 owed so far. Pay it before the due date.",
  });
  assert.equal(dueText(item({ kind: "card_bill", name: "HDFC Regalia" }), 0).body, "₹12,000 to pay.");
  assert.equal(dueText(item({ kind: "fd", name: "SBI FD", direction: "none" }), 0).title, "SBI FD matures today");
  assert.equal(dueText(item({ kind: "fd_interest", name: "SBI FD", direction: "in" }), 1).body, "₹12,000 from SBI FD into HDFC.");
  assert.equal(dueText(item({ kind: "recurring", name: "Salary", direction: "in" }), 0).title, "Salary expected today");
  assert.equal(dueText(item({ kind: "sip", name: "Parag Parikh", account_name: null }), 1).body, "₹12,000. Keep the balance ready.");
});

const line = (o = {}) => ({
  category_id: 12,
  name: "Food",
  icon: null,
  colour: null,
  parent_id: null,
  parent_name: null,
  active: true,
  note: null,
  counted: true,
  since: "2026-01",
  amount: "10000.00",
  spent: "8500.00",
  left: "1500.00",
  remaining: "1500.00",
  over_by: "0.00",
  percent: 85,
  bar: 85,
  over: false,
  ...o,
});

const book = (budgets, o = {}) => ({ month: "2026-11", is_current: true, through: "2026-11-30", budgets, ...o });

test("budgetLevel", () => {
  assert.equal(budgetLevel(line({ percent: 79 })), null);
  assert.equal(budgetLevel(line({ percent: 80 })), "near");
  assert.equal(budgetLevel(line({ percent: 120, over: true })), "over");
  assert.equal(budgetLevel(line({ active: false })), null);
  assert.equal(budgetLevel(line({ percent: null })), null);
});

test("planBudgetAlerts: near, then over, each once", () => {
  const first = planBudgetAlerts(book([line()]), null, NOW);
  assert.equal(first.alerts.length, 1);
  assert.equal(first.alerts[0].title, "Food: 85% of budget used");
  assert.equal(first.alerts[0].body, "₹1,500 left for 13 days.");
  assert.equal(first.alerts[0].url, BUDGETS_URL);

  assert.deepEqual(planBudgetAlerts(book([line()]), first.sent, NOW).alerts, []);

  const over = line({ percent: 110, over: true, spent: "11000.00", over_by: "1000.00", remaining: "0.00" });
  const second = planBudgetAlerts(book([over]), first.sent, NOW);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].title, "Food is over budget");
  assert.equal(second.alerts[0].body, "Over by ₹1,000: ₹11,000 spent of ₹10,000 this month.");
  assert.deepEqual(planBudgetAlerts(book([over]), second.sent, NOW).alerts, []);
});

test("planBudgetAlerts: straight past 100% skips the near alert for good", () => {
  const over = line({ percent: 110, over: true });
  const { sent } = planBudgetAlerts(book([over]), null, NOW);
  assert.deepEqual(planBudgetAlerts(book([line()]), sent, NOW).alerts, []);
});

test("planBudgetAlerts: a new month starts afresh; a past month never alerts", () => {
  const { sent } = planBudgetAlerts(book([line()]), null, NOW);
  const december = planBudgetAlerts(book([line()], { month: "2026-12", through: "2026-12-31" }), sent, NOW);
  assert.equal(december.alerts.length, 1);
  assert.equal(december.sent.month, "2026-12");
  assert.deepEqual(planBudgetAlerts(book([line()], { is_current: false }), null, NOW).alerts, []);
});

test("parseSent and prefs", () => {
  assert.equal(parseSent(null), null);
  assert.equal(parseSent("nope"), null);
  assert.equal(parseSent('{"month":3}'), null);
  assert.deepEqual(parseSent('{"month":"2026-11","keys":["12:near",4]}'), { month: "2026-11", keys: ["12:near"] });
  assert.equal(parsePref(prefValue(true)), true);
  assert.equal(parsePref(null), false);
});

test("reminderTarget only opens our routes", () => {
  assert.equal(reminderTarget({ url: "/calendar" }), "/calendar");
  assert.equal(reminderTarget({ url: "/upcoming" }), "/upcoming"); // already scheduled before the calendar
  assert.equal(reminderTarget({ url: "/budgets" }), "/budgets");
  assert.equal(reminderTarget({ url: "/digest" }), null);
  assert.equal(reminderTarget(null), null);
});
