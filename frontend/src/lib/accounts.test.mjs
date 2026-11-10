import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TYPE_LABELS,
  changedPayload,
  errorMessage,
  formFromAccount,
  formatDueDate,
  formatFullDate,
  formatRupees,
  headlineBalance,
  investmentsIn,
  maskLast4,
  nextDueDate,
  renderedFields,
  splitErrors,
  toPayload,
} from "./accounts.ts";

const blank = {
  type: "bank",
  name: "Main",
  balance: "10",
  institution: "",
  bank_kind: "",
  last4: "",
  credit_limit: "",
  statement_day: "",
  due_day: "",
  interest_rate: "",
  emi_amount: "",
  emis_left: "",
  pay_from_id: "",
  moved_from_card: "",
};
const loan = (o = {}) => ({ ...blank, type: "loan", ...o });
const bank = (o = {}) => ({ ...blank, type: "bank", bank_kind: "savings", ...o });
const card = (o = {}) => ({ ...blank, type: "credit_card", ...o });
const cash = (o = {}) => ({ ...blank, type: "cash", ...o });

test("formatRupees uses Indian grouping without touching Number", () => {
  assert.equal(formatRupees("100000.50"), "₹1,00,000.50");
  assert.equal(formatRupees("999.00"), "₹999.00");
  assert.equal(formatRupees("1000.00"), "₹1,000.00");
  assert.equal(formatRupees("999999999999.99"), "₹9,99,99,99,99,999.99");
  assert.equal(formatRupees("-500.50"), "-₹500.50");
});

test("maskLast4", () => {
  assert.equal(maskLast4("1234"), "•••• 1234");
});

test("toPayload cleans money, nulls blanks, numbers days", () => {
  assert.equal(toPayload(bank({ balance: " ₹1,00,000.50 " }), "create").balance, "100000.50");
  assert.equal(toPayload(card({ last4: "" }), "create").last4, null);
  assert.equal(toPayload(card({ due_day: "25" }), "create").due_day, 25);
  assert.equal(toPayload(card({ credit_limit: "₹ 50,000" }), "create").credit_limit, "50000");
});

test("toPayload sends only applicable fields and type on create only", () => {
  assert.equal("last4" in toPayload(cash(), "create"), false);
  assert.equal("type" in toPayload(bank(), "edit"), false);
  assert.equal(toPayload(bank(), "create").type, "bank");
});

test("errorMessage", () => {
  const conflict = Object.assign(new Error("API 409"), {
    status: 409,
    body: JSON.stringify({ detail: "Restore this account before editing it." }),
  });
  assert.equal(errorMessage(conflict), "Restore this account before editing it.");
  assert.equal(errorMessage(new TypeError("fetch failed")), "Something went wrong. Try again.");
  const listShaped = Object.assign(new Error("x"), { body: JSON.stringify({ detail: [{ msg: "x" }] }) });
  assert.equal(errorMessage(listShaped), "Something went wrong. Try again.");
});

const e422 = (...items) => JSON.stringify({ detail: items.map(([loc, msg]) => ({ loc, msg })) });
const BANK_FIELDS = renderedFields("bank", "create");

test("renderedFields follows what the dialog shows", () => {
  assert.deepEqual(renderedFields("cash", "edit"), ["name", "balance"]);
  assert.ok(renderedFields("bank", "create").includes("type"));
  assert.ok(!renderedFields("bank", "edit").includes("type"));
  assert.ok(!renderedFields("bank", "create").includes("credit_limit"));
});

test("splitErrors puts a rendered field's message next to the field", () => {
  const out = splitErrors(e422([["body", "last4"], "Must be 4 digits"]), BANK_FIELDS);
  assert.deepEqual(out, { fields: { last4: "Must be 4 digits" }, general: [] });
});

test("splitErrors sends an unrendered field's message to general", () => {
  const out = splitErrors(e422([["body", "credit_limit"], "Not allowed for this type"]), BANK_FIELDS);
  assert.deepEqual(out, { fields: {}, general: ["Not allowed for this type"] });
});

test("splitErrors sends a loc ending in body to general", () => {
  const out = splitErrors(e422([["body"], "Field required"]), BANK_FIELDS);
  assert.deepEqual(out, { fields: {}, general: ["Field required"] });
});

test("splitErrors handles a type error on edit, where type is not rendered", () => {
  const out = splitErrors(e422([["body", "type"], "Type cannot change"]), renderedFields("bank", "edit"));
  assert.deepEqual(out, { fields: {}, general: ["Type cannot change"] });
});

test("splitErrors keeps every message in a mix, including a second one for the same field", () => {
  const out = splitErrors(
    e422(
      [["body", "name"], "Too long"],
      [["body", "credit_limit"], "Not allowed"],
      [["body"], "Bad body"],
      [["body", "name"], "Also bad"],
    ),
    BANK_FIELDS,
  );
  assert.deepEqual(out, { fields: { name: "Too long" }, general: ["Not allowed", "Bad body", "Also bad"] });
});

test("splitErrors falls back when nothing parses", () => {
  const fallback = errorMessage(new Error("x"));
  assert.deepEqual(splitErrors("not json", BANK_FIELDS), { fields: {}, general: [fallback] });
  assert.deepEqual(splitErrors(JSON.stringify({ detail: "oops" }), BANK_FIELDS), { fields: {}, general: [fallback] });
  assert.deepEqual(splitErrors(JSON.stringify({ detail: [] }), BANK_FIELDS), { fields: {}, general: [fallback] });
});

test("type labels match the approved table", () => {
  assert.deepEqual(TYPE_LABELS, {
    bank: "Bank account",
    credit_card: "Credit card",
    cash: "Cash in hand",
    broker: "Broker balance",
    wallet: "Wallet or prepaid card",
    ppf: "PPF",
    rd: "Recurring deposit",
    loan: "Loan",
  });
});

test("cleanMoney strips commas only between digit groups", () => {
  const balance = (raw) => toPayload(bank({ balance: raw }), "create").balance;
  assert.equal(balance("1,00,000"), "100000");
  assert.equal(balance("1,000.50"), "1000.50");
  assert.equal(balance("12,34,567.8"), "1234567.8");
  assert.equal(balance("-₹1,000"), "-1000");
  assert.equal(balance(" ₹ 50,000 "), "50000");
  assert.equal(balance("1500,50"), "1500,50");
  assert.equal(balance("1 2"), "1 2");
  assert.equal(balance("1,00"), "1,00");
  assert.equal(balance("1,0000"), "1,0000");
  assert.equal(balance(",100"), ",100");
  assert.equal(balance("1,000,"), "1,000,");
  assert.equal(balance("1,000.5,0"), "1,000.5,0");
  assert.equal(balance("  "), null);
});

const account = {
  id: 1,
  type: "credit_card",
  name: "Card",
  balance: "2500.00",
  institution: "HDFC",
  bank_kind: null,
  last4: "1234",
  credit_limit: "100000.00",
  available_credit: "97500.00",
  statement_day: 5,
  due_day: null,
  interest_rate: null,
  emi_amount: null,
  emis_left: null,
  pay_from_id: null,
  next_emi: null,
  archived: false,
};

test("changedPayload is empty when nothing changed", () => {
  assert.deepEqual(changedPayload(formFromAccount(account), account), {});
});

test("changedPayload sends only the fields that differ", () => {
  const form = { ...formFromAccount(account), name: " Renamed ", statement_day: "7" };
  assert.deepEqual(changedPayload(form, account), { name: "Renamed", statement_day: 7 });
});

test("changedPayload sends cleared fields as null and leaves the balance out when untouched", () => {
  const form = { ...formFromAccount(account), institution: "", last4: "  ", statement_day: "" };
  const changed = changedPayload(form, account);
  assert.deepEqual(changed, { institution: null, last4: null, statement_day: null });
  assert.equal("balance" in changed, false);
});

test("changedPayload cleans a changed amount and never sends type", () => {
  const form = { ...formFromAccount(account), balance: "₹3,000.50" };
  assert.deepEqual(changedPayload(form, account), { balance: "3000.50" });
});

test("cleanMoney strips the rupee sign only at the start, after an optional sign", () => {
  const balance = (raw) => toPayload(bank({ balance: raw }), "create").balance;
  assert.equal(balance("₹500"), "500");
  assert.equal(balance("-₹500"), "-500");
  assert.equal(balance(" ₹ 1,00,000.50 "), "100000.50");
  assert.equal(balance("10₹50"), "10₹50");
  assert.equal(balance("500₹"), "500₹");
  assert.equal(balance("₹₹5"), "₹5");
});

test("formatDueDate reads the ISO string without a Date", () => {
  assert.equal(formatDueDate("2026-11-25"), "25 Nov");
  assert.equal(formatDueDate("2026-11-05"), "5 Nov");
  assert.equal(formatDueDate("2027-01-01"), "1 Jan");
  assert.equal(formatDueDate("2026-12-31"), "31 Dec");
});

test("toPayload sends a loan's details as numbers and money text", () => {
  const payload = toPayload(
    loan({ balance: "21,632", interest_rate: " 14.5 ", emi_amount: "₹7,500", emis_left: "3", pay_from_id: "4", due_day: "5" }),
    "create",
  );
  assert.deepEqual(payload, {
    type: "loan",
    name: "Main",
    balance: "21632",
    institution: null,
    due_day: 5,
    interest_rate: "14.5",
    emi_amount: "7500",
    emis_left: 3,
    pay_from_id: 4,
  });
});

test("toPayload sends moved_from_card only when ticked, and only on create", () => {
  assert.equal(toPayload(loan({ moved_from_card: "yes" }), "create").moved_from_card, true);
  assert.equal("moved_from_card" in toPayload(loan(), "create"), false);
  assert.equal("moved_from_card" in toPayload(loan({ moved_from_card: "yes" }), "edit"), false);
  assert.equal("moved_from_card" in toPayload(card({ moved_from_card: "yes" }), "create"), false);
});

test("renderedFields shows the move option only when creating a loan", () => {
  assert.ok(renderedFields("loan", "create").includes("moved_from_card"));
  assert.ok(!renderedFields("loan", "edit").includes("moved_from_card"));
  assert.ok(renderedFields("loan", "edit").includes("emis_left"));
});

test("nextDueDate keeps this month until the day passes, and clamps short months", () => {
  assert.equal(nextDueDate(5, "2026-11-05"), "2026-11-05");
  assert.equal(nextDueDate(5, "2026-11-06"), "2026-12-05");
  assert.equal(nextDueDate(31, "2026-02-10"), "2026-02-28");
  assert.equal(nextDueDate(31, "2028-02-10"), "2028-02-29");
  assert.equal(nextDueDate(3, "2026-12-20"), "2027-01-03");
});

test("investmentsIn is what You have holds beyond the account balances", () => {
  const account = (type, balance, archived = false) => ({ type, balance, archived });
  const list = (total_have, accounts) => ({ accounts, total_have, total_owe: "0.00" });
  const accounts = [account("bank", "1000.10"), account("broker", "-200.05"), account("credit_card", "500.00")];
  assert.equal(investmentsIn(list("2300.55", accounts)), "1500.50");
  assert.equal(investmentsIn(list("800.05", accounts)), null);
  assert.equal(investmentsIn(list("0.07", [])), "0.07");
  assert.equal(investmentsIn(list("90071992547409.93", [account("bank", "0.01")])), "90071992547409.92");
  assert.equal(investmentsIn(list("10.00", [account("bank", "10"), account("cash", "5.00", true)])), null);
  // PPF and RD balances are part of You have, not investments.
  assert.equal(investmentsIn(list("1800.00", [account("bank", "100.00"), account("ppf", "1000.00"), account("rd", "700.00")])), null);
});

test("deposit accounts: labels, applicable fields and payload", () => {
  assert.equal(TYPE_LABELS.ppf, "PPF");
  assert.equal(TYPE_LABELS.rd, "Recurring deposit");
  const form = {
    ...blank,
    type: "rd",
    institution: "SBI",
    interest_rate: "6.70",
    opened_on: "2026-08-15",
    pay_from_id: "7",
    deposit_amount: "₹5,000",
    due_day: "15",
    tenure_months: "12",
    deposits_paid: "3",
  };
  assert.deepEqual(toPayload(form, "create"), {
    type: "rd",
    name: "Main",
    balance: "10",
    institution: "SBI",
    interest_rate: "6.70",
    opened_on: "2026-08-15",
    pay_from_id: 7,
    deposit_amount: "5000",
    due_day: 15,
    tenure_months: 12,
    deposits_paid: 3,
  });
  const ppf = toPayload({ ...blank, type: "ppf", opened_on: "2020-04-01" }, "edit");
  assert.equal(ppf.opened_on, "2020-04-01");
  assert.equal("deposit_amount" in ppf, false);
  assert.ok(renderedFields("rd", "edit").includes("tenure_months"));
});

test("formatFullDate reads the ISO string without a Date", () => {
  assert.equal(formatFullDate("2036-04-01"), "1 Apr 2036");
  assert.equal(formatFullDate("2026-11-25"), "25 Nov 2026");
});

test("changedPayload for an RD leaves out unchanged deposits_paid and tenure_months, and sends changed ones as numbers", () => {
  const rd = {
    ...account,
    type: "rd",
    name: "SBI RD",
    credit_limit: null,
    available_credit: null,
    statement_day: null,
    institution: "SBI",
    tenure_months: 24,
    deposits_paid: 3,
    deposit: { kind: "rd", deposits_paid: 3 },
  };
  const same = changedPayload(formFromAccount(rd), rd);
  assert.equal("deposits_paid" in same, false);
  assert.equal("tenure_months" in same, false);
  const changed = changedPayload({ ...formFromAccount(rd), deposits_paid: "4", tenure_months: "36" }, rd);
  assert.equal(changed.deposits_paid, 4);
  assert.equal(changed.tenure_months, 36);
});

test("headlineBalance is the free balance, or the balance for an older response", () => {
  assert.equal(headlineBalance({ balance: "80000.00", free_balance: "30000.00" }), "30000.00");
  assert.equal(headlineBalance({ balance: "80000.00" }), "80000.00");
});
