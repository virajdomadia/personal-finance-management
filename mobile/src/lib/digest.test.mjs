import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WEEKLY_SUMMARY,
  changeBadge,
  changeTone,
  digestPath,
  dueSummary,
  hiddenKey,
  notificationTarget,
  parseSummaryPref,
  riskSummary,
  riskText,
  summaryPrefValue,
  usualText,
  weekRange,
} from "./digest.ts";

test("paths and keys", () => {
  assert.equal(digestPath(false), "/digest");
  assert.equal(digestPath(true), "/digest?week=current");
  assert.equal(hiddenKey(7, "2026-11-02"), "gullak.digest-hidden.7.2026-11-02");
  assert.match(hiddenKey(7, "2026-11-02"), /^[\w.-]+$/); // SecureStore's allowed characters
});

test("weekRange", () => {
  assert.equal(weekRange("2026-11-02", "2026-11-08"), "2–8 Nov");
  assert.equal(weekRange("2026-11-30", "2026-12-06"), "30 Nov – 6 Dec");
});

test("changeTone and changeBadge", () => {
  assert.equal(changeTone({ amount: "600.00", percent: 16 }), "more");
  assert.equal(changeTone({ amount: "-650.00", percent: -18 }), "less");
  assert.equal(changeTone({ amount: "50.00", percent: 1 }), "same");
  assert.equal(changeBadge({ amount: "600.00", percent: 16 }), "▲ ₹600 · 16%");
  assert.equal(changeBadge({ amount: "-650.50", percent: -18 }), "▼ ₹650.50 · 18%");
  assert.equal(changeBadge({ amount: "4250.00", percent: null }), "▲ ₹4,250");
  assert.equal(changeBadge({ amount: "0.00", percent: 0 }), "≈ usual");
  assert.equal(changeBadge(null), null);
});

test("usualText", () => {
  assert.equal(usualText({ usual: "3650.00", usual_weeks: 4 }), "Usually ₹3,650 (4-week average)");
  assert.equal(usualText({ usual: "1000.00", usual_weeks: 1 }), "Usually ₹1,000 (the week before)");
  assert.equal(usualText({ usual: null, usual_weeks: 0 }), "Not enough history to compare yet");
});

test("risk and due summaries", () => {
  const r = (status) => ({ status, amount: "8000.00", over_by: "200.00", projected: "16500.00" });
  assert.equal(riskText(r("over")), "Over by ₹200");
  assert.equal(riskText(r("on_pace")), "On pace for ₹16,500 of ₹8,000");
  assert.equal(riskSummary({ budgets: { at_risk: [] } }), "Budgets on track");
  assert.equal(riskSummary({ budgets: { at_risk: [r("over")] } }), "1 budget over");
  assert.equal(riskSummary({ budgets: { at_risk: [r("over"), r("on_pace")] } }), "2 budgets at risk");
  assert.equal(dueSummary({ due: { through: "2026-11-16", total: "0.00", items: [] } }), "Nothing due by 16 Nov");
  assert.equal(
    dueSummary({ due: { through: "2026-11-16", total: "20649.00", items: [{}, {}] } }),
    "2 due by 16 Nov · ₹20,649 out",
  );
});

test("the weekly summary schedule and preference", () => {
  assert.deepEqual([WEEKLY_SUMMARY.weekday, WEEKLY_SUMMARY.hour, WEEKLY_SUMMARY.minute], [1, 19, 0]);
  assert.equal(parseSummaryPref(null), false);
  assert.equal(parseSummaryPref("on"), true);
  assert.equal(parseSummaryPref(summaryPrefValue(false)), false);
  assert.equal(notificationTarget({ url: "/digest" }), "/digest");
  assert.equal(notificationTarget({ url: "/accounts" }), null);
  assert.equal(notificationTarget(null), null);
});
