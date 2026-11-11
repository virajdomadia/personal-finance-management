import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changedGoal,
  earmarkErrors,
  goalErrors,
  efText,
  earmarkFormBlank,
  earmarkPayload,
  freeBalanceText,
  goalDueText,
  goalFormBlank,
  goalFormFrom,
  goalPayload,
  holdingName,
  overSetAsideText,
  paceText,
  progressText,
  statusLabel,
} from "./goals.ts";

const custom = (o = {}) => ({
  id: 5,
  name: "Trip",
  kind: "custom",
  target: "120000.00",
  target_date: "2027-06-30",
  note: "Japan",
  archived: false,
  ef: null,
  monthly_amount: "5000.00",
  reminder_day: 5,
  saved: "45500.00",
  earmarked: "40000.00",
  holdings_value: "5500.00",
  percent: 38,
  reached: false,
  months_left: 8,
  per_month: "9313.00",
  overdue: false,
  earmarks: [],
  holdings: [],
  warnings: [],
  ...o,
});
const ef = (o = {}, f = {}) =>
  custom({
    id: 1,
    name: "Emergency fund",
    kind: "emergency",
    target: "194400.00",
    target_date: null,
    note: null,
    monthly_amount: null,
    reminder_day: null,
    ef: { months: 6, monthly: "32400.00", computed: "32400.00", override: null, window: ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"], ...f },
    ...o,
  });

test("goalFormBlank starts empty, the emergency fund at 6 months", () => {
  assert.deepEqual(goalFormBlank("custom"), {
    name: "", kind: "custom", target_amount: "", target_date: "", ef_months: "", ef_monthly_override: "",
    monthly_amount: "", reminder_day: "", note: "",
  });
  assert.equal(goalFormBlank("emergency").ef_months, "6");
  assert.equal(goalFormBlank("emergency").kind, "emergency");
});

test("goalFormFrom reads a goal back into text", () => {
  const form = goalFormFrom(custom());
  assert.equal(form.target_amount, "120000.00");
  assert.equal(form.target_date, "2027-06-30");
  assert.equal(form.monthly_amount, "5000.00");
  assert.equal(form.reminder_day, "5");
  assert.equal(form.note, "Japan");
  const e = goalFormFrom(ef({}, { override: "40000.00" }));
  assert.equal(e.target_amount, "");
  assert.equal(e.ef_months, "6");
  assert.equal(e.ef_monthly_override, "40000.00");
  assert.equal(goalFormFrom(ef()).ef_monthly_override, "");
});

test("goalPayload sends the fields that apply to the kind", () => {
  const form = { ...goalFormBlank("custom"), name: " Trip ", target_amount: "₹1,20,000", target_date: "2027-06-30", monthly_amount: "5,000", reminder_day: "5" };
  assert.deepEqual(goalPayload(form, "create"), {
    kind: "custom", name: "Trip", target_amount: "120000", target_date: "2027-06-30", monthly_amount: "5000", reminder_day: 5, note: null,
  });
  assert.equal("kind" in goalPayload(form, "edit"), false);
  const e = { ...goalFormBlank("emergency"), name: "EF", ef_monthly_override: "40000", note: "x" };
  assert.deepEqual(goalPayload(e, "create"), {
    kind: "emergency", name: "EF", target_date: null, ef_months: 6, ef_monthly_override: "40000", monthly_amount: null, reminder_day: null, note: "x",
  });
});

test("goalPayload drops the reminder day when there is no monthly amount", () => {
  const form = { ...goalFormBlank("custom"), name: "A", target_amount: "10", reminder_day: "5" };
  assert.equal(goalPayload(form, "edit").reminder_day, null);
});

test("progressText", () => {
  assert.equal(progressText(custom()), "₹45,500 of ₹1,20,000 · 38%");
  assert.equal(progressText(custom({ saved: "130000.00", percent: 108, reached: true })), "₹1,30,000 saved · Reached");
  assert.equal(progressText(custom({ target: null, percent: null, saved: "45500.00" })), "₹45,500 saved");
  assert.equal(progressText(custom({ saved: "45500.50" })), "₹45,500.50 of ₹1,20,000 · 38%");
});

test("efText", () => {
  assert.equal(efText(ef()), "6 months × ₹32,400 (average of Jun–Oct)");
  assert.equal(efText(ef({}, { override: "40000.00", monthly: "40000.00" })), "6 months × ₹40,000 (your figure)");
  assert.equal(efText(ef({}, { monthly: null, computed: null, window: [] })), "Not enough history yet: enter your monthly expenses");
  assert.equal(efText(ef({}, { window: ["2026-10"] })), "6 months × ₹32,400 (average of Oct)");
  assert.equal(efText(custom()), "");
});

test("paceText", () => {
  assert.equal(paceText(custom()), "Set aside ₹9,313 a month to reach it by Jun 2027");
  assert.equal(paceText(custom({ overdue: true })), "The target date has passed");
  assert.equal(paceText(custom({ reached: true, per_month: null })), null);
  assert.equal(paceText(custom({ target_date: null, per_month: null })), null);
  assert.equal(paceText(custom({ per_month: null })), null);
});

test("freeBalanceText", () => {
  const a = { balance: "80000.00", set_aside: "50000.00", free_balance: "30000.00" };
  assert.equal(freeBalanceText(a), "₹80,000 in the bank · ₹50,000 set aside for goals");
  assert.equal(freeBalanceText({ ...a, set_aside: "0.00" }), null);
});

test("overSetAsideText", () => {
  const a = { name: "HDFC", balance: "10000.00", set_aside: "12500.50", free_balance: "-2500.50" };
  assert.equal(overSetAsideText(a), "₹2,500.50 more is set aside than HDFC holds.");
  assert.equal(overSetAsideText({ ...a, free_balance: "-3000.00" }), "₹3,000 more is set aside than HDFC holds.");
  assert.equal(overSetAsideText({ ...a, free_balance: "0.00" }), null);
});

test("goalDueText", () => {
  assert.equal(
    goalDueText({ goal_id: 1, name: "Emergency fund", amount: "5000.00", due_since: "2026-11-05" }),
    "Set aside ₹5,000 for Emergency fund this month.",
  );
});

test("earmarkFormBlank and earmarkPayload", () => {
  const form = earmarkFormBlank(5, "set_aside", "2026-11-11");
  assert.deepEqual(form, { goal_id: 5, action: "set_aside", account_id: "", amount: "", date: "2026-11-11", note: "" });
  assert.deepEqual(earmarkPayload({ ...form, account_id: "7", amount: "₹5,000", note: " " }), {
    account_id: 7, action: "set_aside", amount: "5000", date: "2026-11-11", note: null,
  });
});

test("holdingName marks a sold or closed holding", () => {
  const h = (o) => ({ id: 1, kind: "stock", instrument_id: 3, account_id: null, name: "TCS", value: "0.00", status: "held", note: null, ...o });
  assert.equal(statusLabel(h()), null);
  assert.equal(statusLabel(h({ status: "sold" })), "sold");
  assert.equal(statusLabel(h({ status: "closed" })), "closed");
  assert.equal(holdingName(h()), "TCS");
  assert.equal(holdingName(h({ status: "sold" })), "TCS (sold)");
  assert.equal(holdingName(h({ status: "closed", name: "PPF" })), "PPF (closed)");
});

test("goalErrors uses the server's messages", () => {
  const blank = goalErrors(goalFormBlank("custom"));
  assert.equal(blank.name, "Enter a name.");
  assert.equal(blank.target_amount, "Enter a target amount.");
  assert.equal(goalErrors({ ...goalFormBlank("custom"), name: "A", target_amount: "0" }).target_amount, "Enter a target amount.");
  assert.equal(goalErrors({ ...goalFormBlank("custom"), name: "A", target_amount: "abc" }).target_amount, "Enter an amount, like 1234.50.");
  assert.deepEqual(goalErrors({ ...goalFormBlank("custom"), name: "A", target_amount: "₹1,000" }), {});
  assert.equal(goalErrors({ ...goalFormBlank("custom"), name: "A", target_amount: "1", target_date: "2026-13-40" }).target_date, "Enter a date, like 2026-01-15.");
  assert.equal(goalErrors({ ...goalFormBlank("custom"), name: "x".repeat(61), target_amount: "1" }).name, "Use 60 characters or fewer.");
});

test("goalErrors for the emergency fund and the monthly amount", () => {
  const e = goalFormBlank("emergency");
  assert.deepEqual(goalErrors({ ...e, name: "EF" }), {});
  assert.equal(goalErrors({ ...e, name: "EF", ef_months: "25" }).ef_months, "Choose 1 to 24 months.");
  assert.equal(goalErrors({ ...e, name: "EF", ef_months: "" }).ef_months, "Choose 1 to 24 months.");
  assert.equal(goalErrors({ ...e, name: "EF", ef_monthly_override: "0" }).ef_monthly_override, "Enter a monthly figure greater than 0.");
  const c = { ...goalFormBlank("custom"), name: "A", target_amount: "10" };
  assert.equal(goalErrors({ ...c, monthly_amount: "0" }).monthly_amount, "Enter a monthly amount greater than 0.");
  assert.equal(goalErrors({ ...c, monthly_amount: "500" }).reminder_day, "Choose a day from 1 to 31.");
  assert.equal(goalErrors({ ...c, monthly_amount: "500", reminder_day: "32" }).reminder_day, "Choose a day from 1 to 31.");
  assert.deepEqual(goalErrors({ ...c, monthly_amount: "500", reminder_day: "31" }), {});
  assert.deepEqual(goalErrors({ ...c, reminder_day: "99" }), {});
});

test("earmarkErrors uses the server's messages", () => {
  const form = earmarkFormBlank(5, "set_aside", "2026-11-11");
  assert.deepEqual(earmarkErrors(form, "2026-11-11"), {
    account_id: "Set money aside from a bank, cash or wallet account.",
    amount: "Enter an amount greater than 0.",
  });
  const ok = { ...form, account_id: "7", amount: "5,000" };
  assert.deepEqual(earmarkErrors(ok, "2026-11-11"), {});
  assert.equal(earmarkErrors({ ...ok, amount: "0" }, "2026-11-11").amount, "Enter an amount greater than 0.");
  assert.equal(earmarkErrors({ ...ok, date: "2026-11-12" }, "2026-11-11").date, "Choose today or an earlier date.");
  assert.equal(earmarkErrors({ ...ok, date: "nope" }, "2026-11-11").date, "Enter a date, like 2026-01-15.");
  assert.equal(earmarkErrors({ ...ok, action: "x" }, "2026-11-11").action, "Choose set aside or release.");
});

test("changedGoal sends only what differs", () => {
  const g = custom();
  assert.deepEqual(changedGoal(goalFormFrom(g), g), {});
  assert.deepEqual(changedGoal({ ...goalFormFrom(g), name: "Japan trip", target_amount: "150000" }, g), {
    name: "Japan trip", target_amount: "150000",
  });
  assert.deepEqual(changedGoal({ ...goalFormFrom(g), monthly_amount: "" }, g), { monthly_amount: null, reminder_day: null });
  const e = ef();
  assert.deepEqual(changedGoal(goalFormFrom(e), e), {});
  assert.deepEqual(changedGoal({ ...goalFormFrom(e), ef_months: "9" }, e), { ef_months: 9 });
});
