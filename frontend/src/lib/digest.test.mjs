import assert from "node:assert/strict";
import { test } from "node:test";

import { changeLine, digestKey, dueLine, monthHref, riskText, usualLine, weekRange } from "./digest.ts";

test("digestKey is per user and per week", () => {
  assert.equal(digestKey(7, "2026-11-02"), "gullak.digest-hidden.7.2026-11-02");
  assert.notEqual(digestKey(7, "2026-11-02"), digestKey(8, "2026-11-02"));
  assert.notEqual(digestKey(7, "2026-11-02"), digestKey(7, "2026-11-09"));
});

test("weekRange", () => {
  assert.equal(weekRange("2026-11-02", "2026-11-08"), "2–8 Nov");
  assert.equal(weekRange("2026-11-30", "2026-12-06"), "30 Nov – 6 Dec");
});

test("changeLine words the server's tone", () => {
  assert.equal(changeLine({ change: { amount: "600.00", percent: 16 }, tone: "more" }), "₹600.00 more than usual (16%)");
  assert.equal(changeLine({ change: { amount: "-650.00", percent: -18 }, tone: "less" }), "₹650.00 less than usual (18%)");
  // +5.4% rounds to 5%, but the server says more: the line follows the server.
  assert.equal(changeLine({ change: { amount: "54.00", percent: 5 }, tone: "more" }), "₹54.00 more than usual (5%)");
  assert.equal(changeLine({ change: { amount: "-50.00", percent: -5 }, tone: "same" }), "About the same as usual");
  assert.equal(changeLine({ change: { amount: "4250.00", percent: null }, tone: "more" }), "₹4,250.00 more than usual");
  assert.equal(changeLine({ change: null, tone: null }), null);
});

test("usualLine", () => {
  assert.equal(usualLine({ usual: "3650.00", usual_weeks: 4 }), "Usual: ₹3,650.00 (4-week average)");
  assert.equal(usualLine({ usual: "1000.00", usual_weeks: 1 }), "Usual: ₹1,000.00 (last week)");
  assert.equal(usualLine({ usual: null, usual_weeks: 0 }), "Not enough history to compare yet");
});

test("riskText, monthHref and dueLine", () => {
  const base = { amount: "8000.00", over_by: "0.00", projected: "16500.00" };
  assert.equal(riskText({ ...base, status: "on_pace" }), "On pace for ₹16,500.00 of ₹8,000.00");
  assert.equal(riskText({ ...base, status: "over", over_by: "200.00" }), "Over by ₹200.00");
  assert.equal(monthHref({ budgets: { month: "2026-11" } }), "/cash-flow?month=2026-11");
  assert.equal(dueLine({ due: { through: "2026-11-16", total: "0.00", items: [] } }), "Nothing due by 16 Nov");
  assert.equal(
    dueLine({ due: { through: "2026-11-16", total: "20649.00", items: [{}, {}] } }),
    "2 things due by 16 Nov, ₹20,649.00 going out",
  );
});
