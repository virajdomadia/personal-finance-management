import assert from "node:assert/strict";
import { test } from "node:test";

import { describeAction, describePreview, dividendLabel, isUpcoming } from "./corporate-actions.ts";

const base = {
  id: 1, stock_id: 7, symbol: "INFY", ex_date: "2026-03-12", status: "pending", purpose: null,
  ratio_new: null, ratio_old: null, amount_per_share: null, target_stock_id: null, cost_share_pct: null,
  preview: null, dividend: null,
};

test("describeAction words a split, bonus and dividend", () => {
  assert.equal(describeAction({ ...base, kind: "split", ratio_new: "5", ratio_old: "1" }), "Split 1:5 on 12 Mar 2026");
  assert.equal(describeAction({ ...base, kind: "bonus", ratio_new: "1", ratio_old: "1" }), "Bonus 1:1 on 12 Mar 2026");
  assert.equal(describeAction({ ...base, kind: "bonus", ratio_new: "2", ratio_old: "1" }), "Bonus 2:1 on 12 Mar 2026");
  assert.equal(describeAction({ ...base, kind: "dividend", amount_per_share: "2.5" }), "Dividend ₹2.50/share on 12 Mar 2026");
  assert.equal(describeAction({ ...base, kind: "dividend", amount_per_share: "1250.125" }), "Dividend ₹1,250.125/share on 12 Mar 2026");
});

test("describeAction handles the other kinds", () => {
  assert.equal(describeAction({ ...base, kind: "consolidation", ratio_new: "1", ratio_old: "10" }), "Consolidation 10:1 on 12 Mar 2026");
  assert.equal(describeAction({ ...base, kind: "merger" }), "Merger on 12 Mar 2026");
  assert.equal(describeAction({ ...base, kind: "demerger" }), "Demerger on 12 Mar 2026");
  assert.equal(describeAction({ ...base, kind: "other", purpose: "Rights issue" }), "Rights issue on 12 Mar 2026");
  assert.equal(describeAction({ ...base, kind: "other" }), "Other action on 12 Mar 2026");
});

test("describePreview shows shares and average cost before and after", () => {
  assert.equal(
    describePreview({ shares_before: 40, shares_after: 200, average_before: "1500.00", average_after: "300.00" }),
    "40 → 200 shares · avg ₹1,500.00 → ₹300.00",
  );
  assert.equal(describePreview(null), "");
});

test("dividendLabel names a zero dividend, an expected one and a received one", () => {
  assert.equal(dividendLabel({ ...base, kind: "dividend", status: "applied", dividend: { gross: "0.00", by_account: [] } }, "2026-03-01"), "Not held on record date");
  assert.equal(dividendLabel({ ...base, kind: "dividend", status: "applied", dividend: { gross: "200.00", by_account: [] } }, "2026-03-01"), "Expected ₹200.00");
  assert.equal(dividendLabel({ ...base, kind: "dividend", status: "applied", dividend: { gross: "1000.00", by_account: [] } }, "2026-03-12"), "Received ₹1,000.00");
  assert.equal(dividendLabel({ ...base, kind: "dividend", status: "pending", dividend: { gross: "1000.00", by_account: [] } }, "2026-03-12"), "Would pay ₹1,000.00");
  assert.equal(dividendLabel({ ...base, kind: "split" }, "2026-03-12"), "");
});

test("isUpcoming is true only for an ex-date after today", () => {
  assert.equal(isUpcoming({ ex_date: "2026-03-13" }, "2026-03-12"), true);
  assert.equal(isUpcoming({ ex_date: "2026-03-12" }, "2026-03-12"), false);
});
