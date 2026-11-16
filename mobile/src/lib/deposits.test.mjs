import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeDepositForm,
  fdMaturedText,
  fdPayoutText,
  renewFdForm,
  renewFdPayload,
  closeDepositPayload,
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

test("closeDepositForm clears a pay-from that isn't an active bank", () => {
  const banks = [{ id: 7, type: "bank", archived: false }, { id: 8, type: "bank", archived: false }];
  assert.equal(closeDepositForm(rd(), "2026-11-20", banks).account_id, "7");
  assert.equal(closeDepositForm(rd({ pay_from_id: 9 }), "2026-11-20", banks).account_id, "");
  assert.equal(closeDepositForm(rd({ pay_from_id: 7 }), "2026-11-20", []).account_id, "");
  assert.equal(closeDepositForm(rd({ pay_from_id: null }), "2026-11-20", banks).account_id, "");
});

test("instalmentForm starts with no account when the usual bank isn't an active bank", () => {
  const banks = [{ id: 7, type: "bank", archived: false }, { id: 8, type: "bank", archived: false }];
  assert.equal(instalmentForm(rd(), "2026-11-20", banks).account_id, "7");
  assert.equal(instalmentForm(rd(), "2026-11-20").account_id, "7");
  assert.equal(instalmentForm(rd(), "2026-11-20", [{ id: 7, type: "bank", archived: true }]).account_id, "");
  assert.equal(instalmentForm(rd({ pay_from_id: 9 }), "2026-11-20", banks).account_id, "");
  const kept = instalmentForm(rd(), "2026-11-20", [{ id: 7, type: "bank", archived: true }]);
  assert.equal(kept.to_account_id, "11");
  assert.equal(kept.amount, "5000.00");
});

test("formatLongDate and depositLines", async () => {
  const { formatLongDate, depositLines } = await import("./deposits.ts");
  assert.equal(formatLongDate("2036-04-01"), "1 Apr 2036");
  assert.deepEqual(depositLines(rd()), [
    "Paid 3 of 12",
    "Value today ≈ ₹15,300.00 (estimate)",
    "₹62,000.50 on 15 Nov 2027",
  ]);
  assert.deepEqual(
    depositLines({
      type: "ppf",
      deposit: {
        kind: "ppf",
        maturity_date: "2036-04-01",
        deposited_this_year: "50000.00",
        year_limit: "150000.00",
        interest_this_year: "3550.00",
        interest_due: null,
      },
    }),
    ["Interest this year ≈ ₹3,550.00 (estimate)", "₹50,000 of ₹1,50,000 this year", "Matures 1 Apr 2036"],
  );
  assert.deepEqual(depositLines({ type: "bank", deposit: null }), []);
});

test("a PPF or RD is paid from banks only; a loan from anything but loans and deposits", async () => {
  const { payFromAccounts } = await import("./deposits.ts");
  const list = ["bank", "credit_card", "cash", "loan", "ppf", "rd"].map((type, i) => ({ id: i + 1, type }));
  const types = (accounts) => accounts.map((a) => a.type);
  assert.deepEqual(types(payFromAccounts(list, "rd")), ["bank"]);
  assert.deepEqual(types(payFromAccounts(list, "ppf")), ["bank"]);
  assert.deepEqual(types(payFromAccounts(list, "loan")), ["bank", "credit_card", "cash"]);
  assert.deepEqual(types(payFromAccounts(list, "loan", 1)), ["credit_card", "cash"]);
});

test("accountSections puts PPF and RD in one Deposits group, in type order", async () => {
  const { accountSections } = await import("./deposits.ts");
  const list = [
    { id: 1, type: "loan" },
    { id: 2, type: "rd" },
    { id: 3, type: "bank" },
    { id: 4, type: "ppf" },
  ];
  const sections = accountSections(list);
  assert.deepEqual(sections.map((s) => s.title), ["Bank account", "Deposits", "Loan"]);
  assert.deepEqual(sections[1].data.map((a) => a.type), ["ppf", "rd"]);
});

const fd = (o = {}, d = {}) => ({
  id: 21,
  type: "fd",
  name: "HDFC FD",
  balance: "100000.00",
  interest_rate: "7.25",
  pay_from_id: 7,
  matures_on: "2027-01-10",
  fd_payout: "cumulative",
  archived: false,
  deposit: {
    kind: "fd",
    maturity_date: "2027-01-10",
    payout: "cumulative",
    principal: "100000.00",
    interest_so_far: "6200.00",
    value_today: "106200.00",
    maturity_value: "107450.25",
    payout_amount: null,
    matured: false,
    ...d,
  },
  ...o,
});
const payoutFd = (payout, o = {}) =>
  fd(
    { fd_payout: payout, ...o },
    {
      payout,
      interest_so_far: "0.00",
      value_today: "100000.00",
      maturity_value: "100000.00",
      payout_amount: payout === "monthly" ? "604.17" : "1812.50",
    },
  );

test("depositLines for an FD: terms, then the estimate and maturity value, or the payout", async () => {
  const { depositLines } = await import("./deposits.ts");
  assert.deepEqual(depositLines(fd()), [
    "7.25% a year · Cumulative",
    "Value today ≈ ₹1,06,200.00 (estimate)",
    "₹1,07,450.25 on 10 Jan 2027",
  ]);
  assert.deepEqual(depositLines(payoutFd("monthly")), [
    "7.25% a year · Monthly payout",
    "₹604.17 interest every month",
    "Matures 10 Jan 2027",
  ]);
  assert.deepEqual(depositLines(payoutFd("quarterly")), [
    "7.25% a year · Quarterly payout",
    "₹1,812.50 interest every quarter",
    "Matures 10 Jan 2027",
  ]);
  const matured = fd({}, { payout: "monthly", payout_amount: "604.17", matured: true });
  assert.equal(depositLines(matured)[2], "Matured 10 Jan 2027");
  assert.equal(depositLines(fd({ interest_rate: null }))[0], "Cumulative");
});

test("fdPayoutText is only for a payout FD", () => {
  assert.equal(fdPayoutText(fd()), null);
  assert.equal(fdPayoutText(payoutFd("monthly")), "₹604.17 interest every month");
  assert.equal(fdPayoutText(payoutFd("quarterly")), "₹1,812.50 interest every quarter");
});

test("fdMaturedText asks to close or renew a matured FD that is still open", () => {
  assert.equal(fdMaturedText(fd()), null);
  assert.equal(fdMaturedText(fd({}, { matured: true })), "HDFC FD matured on 10 Jan 2027. Close or renew it.");
  assert.equal(fdMaturedText(fd({ archived: true }, { matured: true })), null);
  assert.equal(fdMaturedText(rd()), null);
});

test("closeDepositForm starts an FD at its maturity value and its bank", () => {
  const banks = [{ id: 7, type: "bank", archived: false }];
  assert.deepEqual(closeDepositForm(fd(), "2027-01-10", banks), { amount: "107450.25", date: "2027-01-10", account_id: "7" });
  assert.equal(closeDepositForm(fd({ pay_from_id: null }), "2027-01-10", banks).account_id, "");
  assert.equal(closeDepositForm({ type: "ppf", pay_from_id: null, deposit: null }, "2027-01-10").amount, "");
});

test("renewFdForm starts from the old FD and renews all of the amount received", () => {
  const banks = [{ id: 7, type: "bank", archived: false }];
  assert.deepEqual(renewFdForm(fd(), "2027-01-10", banks), {
    amount: "107450.25",
    date: "2027-01-10",
    account_id: "7",
    reinvest: "107450.25",
    name: "",
    interest_rate: "7.25",
    matures_on: "",
    fd_payout: "cumulative",
  });
  assert.equal(renewFdForm(payoutFd("quarterly"), "2027-01-10", []).account_id, "");
  assert.equal(renewFdForm(payoutFd("quarterly"), "2027-01-10", []).fd_payout, "quarterly");
});

test("renewFdPayload cleans money, leaves out a blank name and amount to renew, and sends other blanks as null", () => {
  const form = {
    amount: "₹1,07,450.25",
    date: "2027-01-10",
    account_id: "7",
    reinvest: "1,00,000",
    name: "  HDFC FD 2  ",
    interest_rate: "7.10",
    matures_on: "2028-01-10",
    fd_payout: "monthly",
  };
  assert.deepEqual(renewFdPayload(form), {
    amount: "107450.25",
    date: "2027-01-10",
    account_id: 7,
    reinvest: "100000",
    name: "HDFC FD 2",
    interest_rate: "7.10",
    matures_on: "2028-01-10",
    fd_payout: "monthly",
  });
  assert.deepEqual(
    renewFdPayload({ ...form, reinvest: " ", name: "", account_id: "", interest_rate: "", matures_on: "", fd_payout: "" }),
    {
      amount: "107450.25",
      date: "2027-01-10",
      account_id: null,
      interest_rate: null,
      matures_on: null,
      fd_payout: null,
    },
  );
});

test("an FD is paid from banks only and sits in the Deposits group after RD", async () => {
  const { accountSections, payFromAccounts } = await import("./deposits.ts");
  const list = ["bank", "credit_card", "fd", "loan"].map((type, i) => ({ id: i + 1, type }));
  assert.deepEqual(payFromAccounts(list, "fd").map((a) => a.type), ["bank"]);
  assert.deepEqual(payFromAccounts(list, "loan").map((a) => a.type), ["bank", "credit_card"]);
  const sections = accountSections([
    { id: 1, type: "fd" },
    { id: 2, type: "ppf" },
    { id: 3, type: "rd" },
    { id: 4, type: "loan" },
  ]);
  assert.deepEqual(sections.map((s) => s.title), ["Deposits", "Loan"]);
  assert.deepEqual(sections[0].data.map((a) => a.type), ["ppf", "rd", "fd"]);
});
