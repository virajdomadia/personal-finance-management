import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cardBillText,
  changedPolicy,
  fundingText,
  policyErrors,
  policyFormBlank,
  policyFormFrom,
  policyPayload,
  renewErrors,
  renewFormFrom,
  renewPayload,
  renewalText,
  roundRupees,
} from "./insurance.ts";

const policy = (o = {}, f = {}) => ({
  id: 1,
  kind: "health",
  insurer: "Care Health Insurance",
  plan: "Care Supreme",
  policy_number: "P123",
  insured: "Viraj",
  sum_insured: "1000000.00",
  period_start: "2026-04-07",
  period_end: "2027-04-06",
  premium: "11936.00",
  details: null,
  active: true,
  template: {},
  paying_account_id: 5,
  paying_account_name: "HDFC card",
  funded_by: {
    account_id: 8,
    name: "Bank of India RD",
    maturity_date: "2027-05-19",
    maturity_estimate: "18643.00",
    covers: true,
    shortfall: null,
    matured: false,
    ...f,
  },
  card_bill: { due: "2027-05-05", before_funding: true },
  periods: [
    { period_start: "2026-04-07", period_end: "2027-04-06", premium: "11936.00", sum_insured: "1000000.00", paid_on: "2026-04-01", transaction_id: null },
  ],
  premium_by_fy: [],
  days_to_renewal: 147,
  ...o,
});

test("renewFormFrom proposes the next year, paid today", () => {
  assert.deepEqual(renewFormFrom(policy(), "2026-11-10"), {
    date: "2026-11-10",
    amount: "11936.00",
    account_id: "5",
    period_start: "2027-04-07",
    period_end: "2028-04-06",
    sum_insured: "1000000.00",
  });
});

test("renewFormFrom clamps a leap day and crosses year ends", () => {
  assert.equal(renewFormFrom(policy({ period_end: "2028-02-29" }), "2028-01-01").period_end, "2029-02-28");
  assert.equal(renewFormFrom(policy({ period_end: "2026-12-31" }), "2026-12-01").period_start, "2027-01-01");
  assert.equal(renewFormFrom(policy({ period_end: "2027-02-28" }), "2027-01-01").period_start, "2027-03-01");
});

test("renewPayload sends ids as numbers and blanks as null", () => {
  const payload = renewPayload({ ...renewFormFrom(policy(), "2026-11-10"), amount: " " });
  assert.equal(payload.account_id, 5);
  assert.equal(payload.amount, null);
  assert.equal(payload.date, "2026-11-10");
});

test("renewPayload cleans grouped money", () => {
  const payload = renewPayload({ ...renewFormFrom(policy(), "2026-11-10"), amount: "12,500", sum_insured: "5,00,000" });
  assert.equal(payload.amount, "12500");
  assert.equal(payload.sum_insured, "500000");
});

test("fundingText says when the funding matures and whether it covers the premium", () => {
  assert.equal(
    fundingText(policy()),
    "Funded by Bank of India RD: matures 19 May 2027, about ₹18,643. Covers the ₹11,936 premium.",
  );
  assert.equal(
    fundingText(policy({}, { covers: false, shortfall: "1200.00", maturity_estimate: "10736.00" })),
    "Funded by Bank of India RD: matures 19 May 2027, about ₹10,736. ₹1,200 short.",
  );
  assert.equal(fundingText(policy({ funded_by: null })), null);
});

test("cardBillText warns only when the bill falls before the funding", () => {
  assert.equal(
    cardBillText(policy()),
    "This premium's card bill is due 5 May 2027, before your Bank of India RD matures on 19 May. Plan to pay it from the bank.",
  );
  assert.equal(
    cardBillText(policy({}, { name: "Post Office recurring deposit" })),
    "This premium's card bill is due 5 May 2027, before your Post Office recurring deposit matures on 19 May. Plan to pay it from the bank.",
  );
  assert.equal(cardBillText(policy({ card_bill: { due: "2027-05-05", before_funding: false } })), null);
  assert.equal(cardBillText(policy({ card_bill: null })), null);
});

test("renewalText shows the server's date and day count", () => {
  assert.equal(renewalText(policy()), "Renews 6 Apr 2027 (147 days)");
  assert.equal(renewalText(policy({ days_to_renewal: 1 })), "Renews 6 Apr 2027 (1 day)");
  assert.equal(renewalText(policy({ days_to_renewal: 0 })), "Renews 6 Apr 2027 (today)");
  assert.equal(renewalText(policy({ days_to_renewal: -2 })), "Renews 6 Apr 2027 (2 days ago)");
  assert.equal(renewalText(policy({ days_to_renewal: null })), null);
});

test("funding figures round half up to whole rupees", () => {
  assert.equal(roundRupees("18642.97"), "₹18,643");
  assert.equal(roundRupees("18642.49"), "₹18,642");
  assert.equal(roundRupees("18642.50"), "₹18,643");
  assert.equal(roundRupees("999.50"), "₹1,000");
  assert.equal(
    fundingText(policy({}, { maturity_estimate: "18642.97" })),
    "Funded by Bank of India RD: matures 19 May 2027, about ₹18,643. Covers the ₹11,936 premium.",
  );
  assert.equal(
    fundingText(policy({}, { covers: false, shortfall: "1199.60", maturity_estimate: "10736.40" })),
    "Funded by Bank of India RD: matures 19 May 2027, about ₹10,736. ₹1,200 short.",
  );
});

const renew = () => renewFormFrom(policy(), "2026-11-10");

test("renewErrors is empty for the proposed renewal", () => {
  assert.deepEqual(renewErrors(renew(), "2026-11-10", "2027-04-06"), {});
  assert.deepEqual(renewErrors(renew(), "2026-11-10"), {});
});

test("renewErrors uses the server's messages", () => {
  const blank = { date: "", amount: "", account_id: "", period_start: "", period_end: "", sum_insured: "" };
  assert.deepEqual(renewErrors(blank, "2026-11-10"), {
    period_start: "Choose the date the period starts.",
    period_end: "Choose the date the period ends.",
    sum_insured: "Enter the sum insured.",
    amount: "Enter an amount.",
    date: "Choose a date.",
    account_id: "Choose an account.",
  });
});

test("renewErrors checks the period, the dates and the money", () => {
  assert.equal(
    renewErrors({ ...renew(), period_start: "2027-04-06" }, "2026-11-10", "2027-04-06").period_start,
    "The new period must start after the current one ends.",
  );
  assert.equal(
    renewErrors({ ...renew(), period_end: "2029-04-06" }, "2026-11-10").period_end,
    "The period must end after it starts, within a year.",
  );
  assert.equal(renewErrors({ ...renew(), period_end: "2027-04-07" }, "2026-11-10").period_end, "The period must end after it starts, within a year.");
  assert.equal(renewErrors({ ...renew(), date: "2026-11-11" }, "2026-11-10").date, "The date can't be in the future.");
  assert.equal(renewErrors({ ...renew(), date: "10/11/2026" }, "2026-11-10").date, "Enter a date, like 2026-01-15.");
  assert.equal(renewErrors({ ...renew(), amount: "0" }, "2026-11-10").amount, "Amount must be greater than 0.");
  assert.equal(renewErrors({ ...renew(), sum_insured: "0" }, "2026-11-10").sum_insured, "Sum insured must be greater than 0.");
  assert.equal(renewErrors({ ...renew(), amount: "12,500" }, "2026-11-10").amount, undefined);
});

test("policyFormFrom reads the latest period's payment date and the funding", () => {
  const form = policyFormFrom(policy());
  assert.equal(form.account_id, "5");
  assert.equal(form.funded_by_id, "8");
  assert.equal(form.paid_on, "2026-04-01");
  assert.equal(form.details, "");
  assert.equal(policyFormFrom(policy({ funded_by: null })).funded_by_id, "");
});

test("policyPayload sends the kind only on create", () => {
  const form = { ...policyFormFrom(policy()), premium: "11,936", details: " " };
  const create = policyPayload(form, "create");
  assert.equal(create.kind, "health");
  assert.equal(create.premium, "11936");
  assert.equal(create.details, null);
  assert.equal(create.account_id, 5);
  assert.equal(create.funded_by_id, 8);
  assert.ok(!("kind" in policyPayload(form, "edit")));
  assert.equal(policyPayload({ ...form, funded_by_id: "" }, "edit").funded_by_id, null);
});

test("policyErrors is empty for a valid policy and uses the server's messages otherwise", () => {
  assert.deepEqual(policyErrors(policyFormFrom(policy()), "2026-11-10"), {});
  assert.deepEqual(policyErrors(policyFormBlank()), {
    insurer: "Enter the insurer.",
    plan: "Enter the plan.",
    policy_number: "Enter the policy number.",
    insured: "Enter who is insured.",
    sum_insured: "Enter the sum insured.",
    premium: "Enter the premium.",
    period_start: "Choose the date the period starts.",
    period_end: "Choose the date the period ends.",
    account_id: "Choose an account.",
    paid_on: "Choose the date it was paid.",
  });
});

test("policyErrors checks lengths, money, period and payment date", () => {
  const form = policyFormFrom(policy());
  assert.equal(policyErrors({ ...form, insurer: "x".repeat(53) }).insurer, "Use 52 characters or fewer.");
  assert.equal(policyErrors({ ...form, policy_number: "x".repeat(41) }).policy_number, "Use 40 characters or fewer.");
  assert.equal(policyErrors({ ...form, details: "x".repeat(2001) }).details, "Use 2000 characters or fewer.");
  assert.equal(policyErrors({ ...form, premium: "0" }).premium, "Premium must be greater than 0.");
  assert.equal(policyErrors({ ...form, sum_insured: "-1" }).sum_insured, "Sum insured must be greater than 0.");
  assert.equal(policyErrors({ ...form, premium: "9.999" }).premium, "Use at most 2 decimal places.");
  assert.equal(policyErrors({ ...form, period_end: "2026-04-07" }).period_end, "The period must end after it starts, within a year.");
  assert.equal(policyErrors({ ...form, period_end: "2027-04-07" }).period_end, undefined);
  assert.equal(policyErrors({ ...form, period_end: "2027-04-08" }).period_end, "The period must end after it starts, within a year.");
  assert.equal(policyErrors({ ...form, paid_on: "2026-11-11" }, "2026-11-10").paid_on, "The date can't be in the future.");
  assert.equal(policyErrors({ ...form, paid_on: "2026-11-11" }).paid_on, undefined);
  assert.equal(policyErrors({ ...form, paid_on: "yesterday" }).paid_on, "Enter a date, like 2026-01-15.");
});

test("changedPolicy sends only what changed", () => {
  const original = policy();
  assert.deepEqual(changedPolicy(policyFormFrom(original), original), {});
  assert.deepEqual(
    changedPolicy({ ...policyFormFrom(original), premium: "12,500", funded_by_id: "", details: "Floater" }, original),
    { premium: "12500", funded_by_id: null, details: "Floater" },
  );
  assert.deepEqual(changedPolicy({ ...policyFormFrom(original), paid_on: "2026-03-30" }, original), { paid_on: "2026-03-30" });
});

test("fundingText says matured once the server says the RD has matured", () => {
  assert.equal(
    fundingText(policy({}, { matured: true })),
    "Funded by Bank of India RD: matured 19 May 2027, about ₹18,643. Covers the ₹11,936 premium.",
  );
});
