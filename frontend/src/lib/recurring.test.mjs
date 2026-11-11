import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canSkip,
  toggleLabel,
  dueText,
  scheduleText,
  templateFormBlank,
  templateFormFrom,
  templatePayload,
  transactionFormFromTemplate,
} from "./recurring.ts";

const rent = (o = {}) => ({
  id: 3,
  name: "Rent",
  type: "expense",
  amount: "15000.00",
  account_id: 7,
  account_name: "HDFC",
  to_account_id: null,
  to_account_name: null,
  category: "Rent",
  note: "Flat",
  frequency: "monthly",
  day: 1,
  month: null,
  start_date: "2026-01-01",
  end_date: null,
  remind_days: 3,
  active: true,
  policy_id: null,
  due: ["2026-03-01"],
  coming_up: null,
  recorded: 2,
  ...o,
});
const premium = rent({
  id: 4,
  name: "Care Health Insurance premium",
  amount: "11936.00",
  frequency: "yearly",
  day: 6,
  month: 4,
  category: "Insurance",
});

test("dueText says what is due or coming up", () => {
  assert.equal(dueText({ template: rent(), occurrence: "2026-03-01", state: "due" }), "Rent: ₹15,000 due since 1 Mar. Record it.");
  assert.equal(
    dueText({ template: premium, occurrence: "2027-04-06", state: "coming_up" }),
    "Care Health Insurance premium: ₹11,936 coming up on 6 Apr.",
  );
  assert.equal(
    dueText({ template: rent({ amount: "1500.50" }), occurrence: "2026-03-01", state: "due" }),
    "Rent: ₹1,500.50 due since 1 Mar. Record it.",
  );
});

test("scheduleText names the cadence", () => {
  assert.equal(scheduleText(rent()), "Every month on the 1st");
  assert.equal(scheduleText(rent({ day: 2 })), "Every month on the 2nd");
  assert.equal(scheduleText(rent({ day: 23 })), "Every month on the 23rd");
  assert.equal(scheduleText(rent({ day: 11 })), "Every month on the 11th");
  assert.equal(scheduleText(rent({ day: 31 })), "Every month on the 31st");
  assert.equal(scheduleText(premium), "Every year on 6 Apr");
});

test("templateFormBlank starts with the frequency's reminder lead", () => {
  assert.equal(templateFormBlank("monthly").remind_days, "3");
  assert.equal(templateFormBlank("yearly").remind_days, "30");
  assert.equal(templateFormBlank("yearly").frequency, "yearly");
});

test("templateFormFrom turns the template into text fields", () => {
  const form = templateFormFrom(rent({ end_date: "2027-01-01", to_account_id: 9 }));
  assert.equal(form.account_id, "7");
  assert.equal(form.to_account_id, "9");
  assert.equal(form.day, "1");
  assert.equal(form.month, "");
  assert.equal(form.end_date, "2027-01-01");
  assert.equal(templateFormFrom(premium).month, "4");
});

test("templatePayload sends the type only on create and drops what does not apply", () => {
  const form = { ...templateFormFrom(rent()), amount: "₹15,000", note: " " };
  const create = templatePayload(form, "create");
  assert.equal(create.type, "expense");
  assert.equal(create.amount, "15000");
  assert.equal(create.note, null);
  assert.equal(create.day, 1);
  assert.equal(create.month, null);
  assert.equal(create.category, "Rent");
  assert.ok(!("to_account_id" in create));
  assert.ok(!("active" in create));
  const edit = templatePayload(form, "edit");
  assert.ok(!("type" in edit));
  assert.equal(edit.active, true);
  assert.equal(templatePayload(templateFormFrom(premium), "create").month, 4);
  const transfer = templatePayload({ ...form, type: "transfer", to_account_id: "9" }, "create");
  assert.equal(transfer.to_account_id, 9);
  assert.ok(!("category" in transfer));
  // A monthly template never sends a stale month.
  assert.equal(templatePayload({ ...form, month: "4" }, "create").month, null);
});

test("transactionFormFromTemplate dates a due item at its occurrence and a coming one today", () => {
  const due = transactionFormFromTemplate(rent(), "2026-03-01", "2026-03-20");
  assert.equal(due.date, "2026-03-01");
  assert.equal(due.type, "expense");
  assert.equal(due.amount, "15000.00");
  assert.equal(due.account_id, "7");
  assert.equal(due.category, "Rent");
  assert.equal(due.note, "Flat");
  assert.equal(due.recurring_template_id, 3);
  assert.equal(transactionFormFromTemplate(premium, "2027-04-06", "2027-03-20").date, "2027-03-20");
  assert.equal(transactionFormFromTemplate(rent(), "2026-03-20", "2026-03-20").date, "2026-03-20");
});

test("transactionFormFromTemplate fills a transfer's destination and no category", () => {
  const form = transactionFormFromTemplate(rent({ type: "transfer", to_account_id: 9, category: null }), "2026-03-01", "2026-03-02");
  assert.equal(form.to_account_id, "9");
  assert.equal(form.category, "");
});

test("toggleLabel offers Stop and Restart only on a plain reminder", () => {
  assert.equal(toggleLabel(rent()), "Stop");
  assert.equal(toggleLabel(rent({ active: false })), "Restart");
  // A policy's reminder is stopped by lapsing the policy, never here.
  assert.equal(toggleLabel({ ...premium, policy_id: 2 }), null);
  // A stopped policy reminder restarts from the policy, never here.
  assert.equal(toggleLabel({ ...premium, policy_id: 2, active: false }), null);
});

test("canSkip refuses a policy's reminder", () => {
  assert.equal(canSkip({ template: rent(), occurrence: "2026-03-01", state: "due" }), true);
  assert.equal(canSkip({ template: { ...premium, policy_id: 2 }, occurrence: "2027-04-06", state: "coming_up" }), false);
});

test("a template carries the dates skipped, which a form ignores", () => {
  const t = rent({ skipped: ["2026-02-01"] });
  assert.equal("skipped" in templateFormFrom(t), false);
  assert.equal("skipped" in templatePayload(templateFormFrom(t), "edit"), false);
});
