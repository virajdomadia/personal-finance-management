import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canSkip,
  toggleLabel,
  changedTemplate,
  dueText,
  scheduleText,
  templateErrors,
  templateFormBlank,
  templateFormFrom,
  templatePayload,
  transactionFormFromTemplate,
} from "./recurring.ts";
import { formFromTransaction, toPayload } from "./transactions.ts";

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

test("a transaction form carries the template link into its payload", () => {
  const form = transactionFormFromTemplate(rent(), "2026-03-01", "2026-03-20");
  assert.equal(toPayload(form, "create").recurring_template_id, 3);
  const tx = { id: 1, type: "expense", amount: "10.00", date: "2026-03-01", account_id: 7, account_name: "HDFC", to_account_id: null, to_account_name: null, category: "Rent", interest: null, note: null, recurring_template_id: 3, editable: true };
  assert.equal(formFromTransaction(tx).recurring_template_id, 3);
  assert.ok(!("recurring_template_id" in toPayload(formFromTransaction({ ...tx, recurring_template_id: null }), "create")));
});

const valid = () => ({ ...templateFormFrom(rent()) });

test("templateErrors is empty for a valid reminder and lets it start ahead", () => {
  assert.deepEqual(templateErrors(valid()), {});
  assert.deepEqual(templateErrors({ ...valid(), start_date: "2099-01-01" }), {});
  assert.deepEqual(templateErrors({ ...templateFormFrom(premium) }), {});
  assert.deepEqual(templateErrors({ ...valid(), remind_days: "" }), {});
});

test("templateErrors uses the server's messages", () => {
  const errors = templateErrors({
    ...templateFormBlank("yearly"),
    type: "expense",
  });
  assert.equal(errors.name, "Enter a name.");
  assert.equal(errors.amount, "Enter an amount.");
  assert.equal(errors.account_id, "Choose an account.");
  assert.equal(errors.category, "Choose a category.");
  assert.equal(errors.day, "Choose a day from 1 to 31.");
  assert.equal(errors.month, "Choose a month.");
  assert.equal(errors.start_date, "Choose a date.");
  assert.equal(errors.remind_days, undefined);
});

test("templateErrors checks each rule", () => {
  assert.equal(templateErrors({ ...valid(), name: "x".repeat(61) }).name, "Use 60 characters or fewer.");
  assert.equal(templateErrors({ ...valid(), day: "32" }).day, "Choose a day from 1 to 31.");
  assert.equal(templateErrors({ ...valid(), day: "0" }).day, "Choose a day from 1 to 31.");
  assert.equal(templateErrors({ ...valid(), day: "1.5" }).day, "Choose a day from 1 to 31.");
  assert.equal(templateErrors({ ...valid(), month: "13", frequency: "yearly" }).month, "Choose a month.");
  assert.equal(templateErrors({ ...valid(), month: "" }).month, undefined);
  assert.equal(templateErrors({ ...valid(), start_date: "2026-02-31" }).start_date, "Enter a date, like 2026-01-15.");
  assert.equal(templateErrors({ ...valid(), end_date: "2025-12-31" }).end_date, "The end date can't be before the start.");
  assert.equal(templateErrors({ ...valid(), end_date: "soon" }).end_date, "Enter a date, like 2026-01-15.");
  assert.equal(templateErrors({ ...valid(), remind_days: "61" }).remind_days, "Enter a number of days from 0 to 60.");
  assert.equal(templateErrors({ ...valid(), remind_days: "-1" }).remind_days, "Enter a number of days from 0 to 60.");
  assert.equal(templateErrors({ ...valid(), remind_days: "0" }).remind_days, undefined);
  assert.equal(templateErrors({ ...valid(), note: "x".repeat(201) }).note, "Use 200 characters or fewer.");
  assert.equal(templateErrors({ ...valid(), category: "x".repeat(41) }).category, "Use 40 characters or fewer.");
});

test("templateErrors checks the amount like the server", () => {
  assert.equal(templateErrors({ ...valid(), amount: "abc" }).amount, "Enter an amount, like 1234.50.");
  assert.equal(templateErrors({ ...valid(), amount: "0" }).amount, "Amount must be greater than 0.");
  assert.equal(templateErrors({ ...valid(), amount: "-5" }).amount, "Amount must be greater than 0.");
  assert.equal(templateErrors({ ...valid(), amount: "1.234" }).amount, "Use at most 2 decimal places.");
  assert.equal(templateErrors({ ...valid(), amount: "1.500" }).amount, undefined);
  assert.equal(templateErrors({ ...valid(), amount: "₹15,000" }).amount, undefined);
  assert.equal(templateErrors({ ...valid(), amount: "1000000000000" }).amount, "Amount must be under ₹10,00,00,00,00,000.");
});

test("templateErrors checks a transfer's accounts and ignores its category", () => {
  const transfer = { ...valid(), type: "transfer", category: "" };
  assert.equal(templateErrors(transfer).to_account_id, "Choose the account the money goes to.");
  assert.equal(templateErrors(transfer).category, undefined);
  assert.equal(templateErrors({ ...transfer, to_account_id: "7" }).to_account_id, "Choose a different account to transfer to.");
  assert.deepEqual(templateErrors({ ...transfer, to_account_id: "9" }), {});
});

test("changedTemplate sends only what changed", () => {
  const original = rent();
  assert.deepEqual(changedTemplate(templateFormFrom(original), original), {});
  assert.deepEqual(changedTemplate({ ...templateFormFrom(original), amount: "16,000", note: "" }, original), { amount: "16000", note: null });
  assert.deepEqual(changedTemplate({ ...templateFormFrom(original), active: false }, original), { active: false });
  assert.deepEqual(changedTemplate({ ...templateFormFrom(original), end_date: "2027-01-01" }, original), { end_date: "2027-01-01" });
});

test("changedTemplate for a policy's reminder sends only name, note and remind days, never active", () => {
  const original = premium;
  const policyOwned = { ...original, policy_id: 1 };
  const form = {
    ...templateFormFrom(policyOwned),
    name: "Premium",
    note: "Pay by card",
    remind_days: "45",
    active: false,
    amount: "99999",
    day: "9",
    category: "Other",
  };
  assert.deepEqual(changedTemplate(form, policyOwned), {
    name: "Premium",
    note: "Pay by card",
    remind_days: 45,
  });
  assert.deepEqual(changedTemplate(templateFormFrom(policyOwned), policyOwned), {});
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
