import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeDepositForm,
  closeDepositPayload,
  depositShortLabel,
  fdMaturedText,
  instalmentForm,
  interestForm,
  ppfDepositForm,
  ppfInterestText,
  ppfRoomText,
  rdDueText,
  renewFdForm,
  renewFdPayload,
} from "./deposits.ts";

const rd = (o = {}, d = {}) => ({
  id: 11,
  type: "rd",
  name: "SBI RD",
  pay_from_id: 7,
  deposit_amount: "5000.00",
  tenure_months: 12,
  deposit: {
    kind: "rd",
    maturity_date: "2027-11-15",
    deposits_paid: 3,
    deposits_left: 5,
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
    interest_due: { year: "2026-27", amount: "10354.00", date: "2027-03-31" },
    ...d,
  },
  ...o,
});

const fd = (o = {}, d = {}) => ({
  id: 13,
  type: "fd",
  name: "HDFC FD",
  pay_from_id: 7,
  archived: false,
  interest_rate: "7.25",
  matures_on: "2027-11-15",
  fd_payout: "cumulative",
  deposit: {
    kind: "fd",
    maturity_date: "2027-11-15",
    payout: "cumulative",
    principal: "100000.00",
    interest_so_far: "3500.00",
    value_today: "103500.00",
    maturity_value: "107450.00",
    payout_amount: null,
    matured: false,
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
  assert.equal(ppfInterestText(ppf()), "PPF: record interest for 2026-27, about ₹10,354.");
  assert.equal(
    ppfInterestText(ppf({}, { interest_due: { year: "2026-27", amount: "10354.50", date: "2027-03-31" } })),
    "PPF: record interest for 2026-27, about ₹10,354.50.",
  );
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
  assert.equal(form.amount, "10354.00");
  assert.equal(form.date, "2027-03-31");
});

test("closeDepositForm and closeDepositPayload", () => {
  const form = closeDepositForm(rd(), "2026-11-20");
  assert.deepEqual(form, { amount: "62000.50", date: "2026-11-20", account_id: "7" });
  assert.deepEqual(closeDepositPayload({ amount: "₹62,000.50", date: "2026-11-20", account_id: "7" }), {
    amount: "62000.50",
    date: "2026-11-20",
    account_id: 7,
  });
  assert.equal(closeDepositPayload({ amount: "1", date: "2026-11-20", account_id: "" }).account_id, null);
});

test("closeDepositForm starts an FD at its maturity value and linked bank", () => {
  assert.deepEqual(closeDepositForm(fd(), "2027-11-16"), { amount: "107450.00", date: "2027-11-16", account_id: "7" });
  assert.equal(closeDepositForm(fd({ pay_from_id: null }), "2027-11-16").account_id, "");
  assert.equal(closeDepositForm(ppf(), "2027-11-16").amount, "");
});

test("fdMaturedText only for a matured FD that is still open", () => {
  assert.equal(fdMaturedText(fd({}, { matured: true })), "HDFC FD matured on 15 Nov 2027. Close or renew it.");
  assert.equal(fdMaturedText(fd()), null);
  assert.equal(fdMaturedText(fd({ archived: true }, { matured: true })), null);
  assert.equal(fdMaturedText(rd()), null);
  assert.equal(fdMaturedText(fd({ deposit: null })), null);
});

test("renewFdForm starts from the FD; renewFdPayload cleans money and nulls blanks", () => {
  const form = renewFdForm(fd({ fd_payout: "quarterly" }), "2027-11-16");
  assert.deepEqual(form, {
    amount: "107450.00",
    date: "2027-11-16",
    account_id: "7",
    reinvest: "107450.00",
    name: "",
    interest_rate: "7.25",
    matures_on: "",
    fd_payout: "quarterly",
  });
  assert.deepEqual(
    renewFdPayload({ ...form, amount: "₹1,07,450", reinvest: "1,00,000", matures_on: "2028-11-16", name: "  HDFC FD 2 " }),
    {
      amount: "107450",
      date: "2027-11-16",
      account_id: 7,
      reinvest: "100000",
      name: "HDFC FD 2",
      interest_rate: "7.25",
      matures_on: "2028-11-16",
      fd_payout: "quarterly",
    },
  );
  const blank = renewFdPayload({ ...form, reinvest: " ", interest_rate: "", fd_payout: "" });
  assert.equal(blank.reinvest, null);
  assert.equal(blank.name, null);
  assert.equal(blank.interest_rate, null);
  assert.equal(blank.matures_on, null);
  assert.equal(blank.fd_payout, null);
});

test("depositShortLabel", () => {
  assert.deepEqual(["ppf", "rd", "fd"].map((t) => depositShortLabel(t)), ["PPF", "RD", "FD"]);
});

test("depositLines uses the tenure for the instalment total", async () => {
  const { depositLines } = await import("./deposits.ts");
  assert.deepEqual(depositLines(rd()), [
    "Paid 3 of 12",
    "Value today ≈ ₹15,300.00 (estimate)",
    "₹62,000.50 on 15 Nov 2027",
  ]);
  assert.deepEqual(depositLines({ type: "bank", deposit: null }), []);
});

test("depositLines for an FD: value and maturity when cumulative, the payout otherwise", async () => {
  const { depositLines } = await import("./deposits.ts");
  assert.deepEqual(depositLines(fd()), [
    "7.25% a year",
    "Cumulative",
    "Value today ≈ ₹1,03,500.00 (estimate)",
    "₹1,07,450.00 on 15 Nov 2027",
  ]);
  const monthly = fd({}, { payout: "monthly", payout_amount: "604.17", maturity_value: "100000.00", interest_so_far: "0.00" });
  assert.deepEqual(depositLines(monthly), ["7.25% a year", "Monthly payout", "₹604.17 interest every month", "Matures 15 Nov 2027"]);
  const quarterly = fd({ interest_rate: null }, { payout: "quarterly", payout_amount: "1812.50", matured: true });
  assert.deepEqual(depositLines(quarterly), ["Quarterly payout", "₹1,812.50 interest every quarter", "Matured 15 Nov 2027"]);
});

test("a PPF, RD or FD is paid from banks only; a loan from anything but loans and deposits", async () => {
  const { payFromAccounts } = await import("./deposits.ts");
  const list = ["bank", "credit_card", "cash", "loan", "ppf", "rd", "fd"].map((type, i) => ({ id: i + 1, type }));
  const types = (accounts) => accounts.map((a) => a.type);
  assert.deepEqual(types(payFromAccounts(list, "rd")), ["bank"]);
  assert.deepEqual(types(payFromAccounts(list, "ppf")), ["bank"]);
  assert.deepEqual(types(payFromAccounts(list, "fd")), ["bank"]);
  assert.deepEqual(types(payFromAccounts(list, "loan")), ["bank", "credit_card", "cash"]);
  assert.deepEqual(types(payFromAccounts(list, "loan", 1)), ["credit_card", "cash"]);
});
