import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeRdForm,
  closeRdPayload,
  instalmentForm,
  interestForm,
  ppfDepositForm,
  ppfInterestText,
  ppfRoomText,
  rdDueText,
} from "./deposits.ts";

const rd = (o = {}, d = {}) => ({
  id: 11,
  type: "rd",
  name: "SBI RD",
  pay_from_id: 7,
  deposit_amount: "5000.00",
  deposit: {
    kind: "rd",
    maturity_date: "2027-11-15",
    deposits_paid: 3,
    deposits_left: 9,
    deposited: "15000.00",
    interest_so_far: "300.00",
    value_today: "15300.00",
    maturity_value: "62000.50",
    due: ["2026-11-15"],
    ...d,
  },
  ...o,
});
const ppf = (o = {}, d = {}) => ({
  id: 12,
  type: "ppf",
  name: "PPF",
  pay_from_id: 7,
  deposit: {
    kind: "ppf",
    maturity_date: "2041-04-01",
    deposited_this_year: "50000.00",
    year_limit: "150000.00",
    interest_this_year: "1000.00",
    interest_due: { year: "2026-27", amount: "10354.17", date: "2027-03-31" },
    ...d,
  },
  ...o,
});

test("rdDueText says what is due, with months when behind", () => {
  assert.equal(rdDueText(rd()), "SBI RD: ₹5,000 instalment due since 15 Nov. Record it.");
  assert.equal(
    rdDueText(rd({}, { due: ["2026-10-15", "2026-11-15"] })),
    "SBI RD: ₹5,000 instalment due since 15 Oct (2 months). Record it.",
  );
  assert.equal(rdDueText(rd({ deposit_amount: "5000.50" })), "SBI RD: ₹5,000.50 instalment due since 15 Nov. Record it.");
  assert.equal(rdDueText(rd({}, { due: [] })), null);
  assert.equal(rdDueText(ppf()), null);
  assert.equal(rdDueText(rd({ deposit: null })), null);
});

test("ppfInterestText and ppfRoomText", () => {
  assert.equal(ppfInterestText(ppf()), "PPF: record interest for 2026-27, about ₹10,354.17.");
  assert.equal(ppfInterestText(ppf({}, { interest_due: null })), null);
  assert.equal(ppfInterestText(rd()), null);
  assert.equal(ppfRoomText(ppf().deposit), "₹50,000 of ₹1,50,000 this year");
});

test("instalmentForm is a transfer into the RD, dated by the oldest due", () => {
  const form = instalmentForm(rd(), "2026-11-20");
  assert.equal(form.type, "transfer");
  assert.equal(form.account_id, "7");
  assert.equal(form.to_account_id, "11");
  assert.equal(form.amount, "5000.00");
  assert.equal(form.date, "2026-11-15");
  assert.equal(instalmentForm(rd({}, { due: [] }), "2026-11-20").date, "2026-11-20");
  assert.equal(instalmentForm(rd({ pay_from_id: null }), "2026-11-20").account_id, "");
});

test("ppfDepositForm is a transfer with a blank amount", () => {
  const form = ppfDepositForm(ppf(), "2026-11-20");
  assert.equal(form.type, "transfer");
  assert.equal(form.account_id, "7");
  assert.equal(form.to_account_id, "12");
  assert.equal(form.amount, "");
  assert.equal(form.date, "2026-11-20");
  assert.equal(ppfDepositForm(ppf({ pay_from_id: null }), "2026-11-20").account_id, "");
});

test("interestForm is income into the deposit", () => {
  const form = interestForm(ppf());
  assert.equal(form.type, "income");
  assert.equal(form.account_id, "12");
  assert.equal(form.category, "Interest");
  assert.equal(form.amount, "10354.17");
  assert.equal(form.date, "2027-03-31");
});

test("closeRdForm and closeRdPayload", () => {
  const form = closeRdForm(rd(), "2026-11-20");
  assert.deepEqual(form, { amount: "62000.50", date: "2026-11-20", account_id: "7" });
  assert.deepEqual(closeRdPayload({ amount: "₹62,000.50", date: "2026-11-20", account_id: "7" }), {
    amount: "62000.50",
    date: "2026-11-20",
    account_id: 7,
  });
  assert.equal(closeRdPayload({ amount: "1", date: "2026-11-20", account_id: "" }).account_id, null);
});
