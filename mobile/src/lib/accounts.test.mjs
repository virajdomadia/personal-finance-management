import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TYPE_LABELS,
  TYPE_ORDER,
  changedPayload,
  countError,
  dayError,
  depositErrors,
  errorMessage,
  formFromAccount,
  formatDueDate,
  formatRupees,
  investmentsIn,
  nextDueDate,
  maskLast4,
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
  opened_on: "",
  deposit_amount: "",
  tenure_months: "",
  deposits_paid: "",
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
    detail: "Restore this account before editing it.",
  });
  assert.equal(errorMessage(conflict), "Restore this account before editing it.");
  assert.equal(errorMessage(new TypeError("fetch failed")), "Something went wrong. Try again.");
  const listShaped = Object.assign(new Error("x"), { detail: [{ msg: "x" }] });
  assert.equal(errorMessage(listShaped), "Something went wrong. Try again.");
  assert.equal(errorMessage(Object.assign(new Error("x"), { status: 500 })), "Something went wrong. Try again.");
});

test("dayError accepts blank and whole days 1 to 31 only", () => {
  for (const ok of ["", "  ", "1", "31", " 15 ", "07"]) assert.equal(dayError(ok), null, ok);
  for (const bad of ["0", "32", "abc", "1.5", "-3", "1e1", "1 2", "100"]) {
    assert.equal(dayError(bad), "Enter a day from 1 to 31.", bad);
  }
});

const e422 = (...items) => items.map(([loc, msg]) => ({ loc, msg }));
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
  assert.deepEqual(splitErrors(undefined, BANK_FIELDS), { fields: {}, general: [fallback] });
  assert.deepEqual(splitErrors("oops", BANK_FIELDS), { fields: {}, general: [fallback] });
  assert.deepEqual(splitErrors([], BANK_FIELDS), { fields: {}, general: [fallback] });
  assert.deepEqual(splitErrors([null, { loc: ["body"] }], BANK_FIELDS), { fields: {}, general: [fallback] });
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
  interest_rate: null,
  emi_amount: null,
  emis_left: null,
  pay_from_id: null,
  next_emi: null,
  opened_on: null,
  deposit_amount: null,
  tenure_months: null,
  deposit: null,
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

test("countError accepts blank or a whole number from 1 to 600", () => {
  assert.equal(countError(""), null);
  assert.equal(countError(" 3 "), null);
  assert.equal(countError("600"), null);
  for (const bad of ["0", "601", "2.5", "abc", "-1"]) assert.equal(countError(bad), "Enter a number of EMIs from 1 to 600.");
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

const rdForm = (o = {}) => ({
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
  ...o,
});

test("deposit accounts: order and payload", () => {
  assert.deepEqual(TYPE_ORDER, ["bank", "credit_card", "cash", "broker", "wallet", "ppf", "rd", "loan"]);
  assert.deepEqual(toPayload(rdForm(), "create"), {
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

const rdAccount = {
  ...account,
  type: "rd",
  name: "SBI RD",
  institution: "SBI",
  statement_day: null,
  credit_limit: null,
  last4: null,
  interest_rate: "6.70",
  due_day: 15,
  pay_from_id: 7,
  opened_on: "2026-08-15",
  deposit_amount: "5000.00",
  tenure_months: 12,
  deposit: { kind: "rd", deposits_paid: 3 },
};

test("formFromAccount reads the deposit fields, and an untouched edit sends nothing", () => {
  const form = formFromAccount(rdAccount);
  assert.equal(form.opened_on, "2026-08-15");
  assert.equal(form.deposit_amount, "5000.00");
  assert.equal(form.tenure_months, "12");
  assert.equal(form.deposits_paid, "3");
  assert.deepEqual(changedPayload(form, rdAccount), {});
});

test("changedPayload sends deposits_paid and tenure_months only when changed", () => {
  const form = formFromAccount(rdAccount);
  assert.deepEqual(changedPayload({ ...form, deposits_paid: "4" }, rdAccount), { deposits_paid: 4 });
  assert.deepEqual(changedPayload({ ...form, tenure_months: "24" }, rdAccount), { tenure_months: 24 });
  assert.deepEqual(changedPayload({ ...form, name: "Renamed" }, rdAccount), { name: "Renamed" });
});

test("depositErrors words the required fields as the server does", () => {
  assert.deepEqual(depositErrors(rdForm()), {});
  assert.deepEqual(depositErrors(bank()), {});
  assert.deepEqual(depositErrors({ ...blank, type: "ppf", interest_rate: "7.1", opened_on: "2020-04-01" }), {});
  assert.deepEqual(depositErrors({ ...blank, type: "ppf" }), {
    interest_rate: "Enter the yearly interest rate.",
    opened_on: "Choose the date it was opened.",
  });
  assert.deepEqual(
    depositErrors({ ...blank, type: "rd", interest_rate: " ", opened_on: "", pay_from_id: "", deposit_amount: " ", due_day: "", tenure_months: "", deposits_paid: "" }),
    {
      interest_rate: "Enter the yearly interest rate.",
      opened_on: "Choose the date it was opened.",
      pay_from_id: "Choose the bank the instalments come from.",
      deposit_amount: "Enter the monthly instalment.",
      due_day: "Choose the instalment day.",
      tenure_months: "Enter the tenure in months, from 1 to 120.",
      deposits_paid: "Enter the instalments paid so far, from 0 to the tenure.",
    },
  );
  assert.equal(depositErrors(rdForm({ tenure_months: "0" })).tenure_months, "Enter the tenure in months, from 1 to 120.");
  assert.equal(depositErrors(rdForm({ tenure_months: "121" })).tenure_months, "Enter the tenure in months, from 1 to 120.");
  assert.equal(depositErrors(rdForm({ deposits_paid: "13" })).deposits_paid, "Enter the instalments paid so far, from 0 to the tenure.");
  assert.equal(depositErrors(rdForm({ deposits_paid: "x" })).deposits_paid, "Enter the instalments paid so far, from 0 to the tenure.");
  assert.equal(depositErrors(rdForm({ deposits_paid: "0" })).deposits_paid, undefined);
  assert.equal(depositErrors(rdForm({ deposit_amount: "0" })).deposit_amount, "Instalment must be greater than 0.");
  assert.equal(depositErrors(rdForm({ due_day: "40" })).due_day, "Enter a day from 1 to 31.");
});

test("depositErrors gives a non-numeric instalment the server's money message", () => {
  assert.equal(depositErrors(rdForm({ deposit_amount: "abc" })).deposit_amount, "Enter an amount, like 1234.50.");
  assert.equal(depositErrors(rdForm({ deposit_amount: "12 34" })).deposit_amount, "Enter an amount, like 1234.50.");
  assert.equal(depositErrors(rdForm({ deposit_amount: "1,500.50" })).deposit_amount, undefined);
});

test("depositErrors still checks deposits_paid when the tenure is invalid", () => {
  assert.equal(depositErrors(rdForm({ tenure_months: "", deposits_paid: "5" })).deposits_paid, undefined);
  assert.equal(depositErrors(rdForm({ tenure_months: "abc", deposits_paid: "x" })).deposits_paid, "Enter the instalments paid so far, from 0 to the tenure.");
  assert.equal(depositErrors(rdForm({ tenure_months: "0", deposits_paid: "121" })).deposits_paid, "Enter the instalments paid so far, from 0 to the tenure.");
  assert.equal(depositErrors(rdForm({ tenure_months: "121", deposits_paid: "120" })).deposits_paid, undefined);
  assert.equal(depositErrors(rdForm({ tenure_months: "", deposits_paid: "-1" })).deposits_paid, "Enter the instalments paid so far, from 0 to the tenure.");
});
