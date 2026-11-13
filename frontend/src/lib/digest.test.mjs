import assert from "node:assert/strict";
import { test } from "node:test";

import { changeLine, changeTone, digestKey, dueLine, monthHref, riskText, usualLine, weekRange } from "./digest.ts";

test("digestKey is per user and per week", () => {
  assert.equal(digestKey(7, "2026-11-02"), "gullak.digest-hidden.7.2026-11-02");
  assert.notEqual(digestKey(7, "2026-11-02"), digestKey(8, "2026-11-02"));
  assert.notEqual(digestKey(7, "2026-11-02"), digestKey(7, "2026-11-09"));
});

test("weekRange", () => {
  assert.equal(weekRange("2026-11-02", "2026-11-08"), "2–8 Nov");
  assert.equal(weekRange("2026-11-30", "2026-12-06"), "30 Nov – 6 Dec");
});

test("changeTone and changeLine follow the server's sign and ±5%", () => {
  assert.equal(changeTone(null), "same");
  assert.equal(changeTone({ amount: "600.00", percent: 16 }), "more");
  assert.equal(changeTone({ amount: "-650.00", percent: -18 }), "less");
  assert.equal(changeTone({ amount: "50.00", percent: 1 }), "same");
  assert.equal(changeTone({ amount: "0.00", percent: null }), "same");
  assert.equal(changeTone({ amount: "4250.00", percent: null }), "more");
  assert.equal(changeLine({ amount: "600.00", percent: 16 }), "₹600.00 more than usual (16%)");
  assert.equal(changeLine({ amount: "-650.00", percent: -18 }), "₹650.00 less than usual (18%)");
  assert.equal(changeLine({ amount: "4250.00", percent: null }), "₹4,250.00 more than usual");
  assert.equal(changeLine(null), null);
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
