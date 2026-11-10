import assert from "node:assert/strict";
import { test } from "node:test";

import { cardBillText, fundingText, roundRupees, renewFormFrom, renewPayload, renewalText } from "./insurance.ts";

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
    ...f,
  },
  card_bill: { due: "2027-05-05", before_funding: true },
  periods: [],
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

test("renewPayload cleans grouped money", () => {
  const payload = renewPayload({ ...renewFormFrom(policy(), "2026-11-10"), amount: "12,500", sum_insured: "5,00,000" });
  assert.equal(payload.amount, "12500");
  assert.equal(payload.sum_insured, "500000");
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
