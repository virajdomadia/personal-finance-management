import assert from "node:assert/strict";
import { test } from "node:test";

import {
  barWidth,
  biggestDay,
  cashFlowPath,
  changeText,
  changeTone,
  dailySummary,
  isEmptyMonth,
  isZero,
  monthLabel,
  percentText,
  shortDay,
  signedWhole,
  sliceText,
  sliceType,
} from "./cash-flow.ts";

const slice = (o = {}) => ({
  id: 1,
  name: "Food",
  icon: "food",
  colour: "#f3a712",
  amount: "4500.00",
  percent: 32,
  direct: "4500.00",
  children: [],
  ...o,
});

test("cashFlowPath asks for the month, or the current one", () => {
  assert.equal(cashFlowPath(null), "/cash-flow");
  assert.equal(cashFlowPath("2026-10"), "/cash-flow?month=2026-10");
});

test("monthLabel", () => {
  assert.equal(monthLabel("2026-11"), "November 2026");
  assert.equal(monthLabel("2027-01"), "January 2027");
});

test("isZero", () => {
  assert.equal(isZero("0.00"), true);
  assert.equal(isZero("-0.00"), true);
  assert.equal(isZero("0"), true);
  assert.equal(isZero("0.01"), false);
  assert.equal(isZero("-10.00"), false);
});

test("signedWhole keeps the sign and drops .00", () => {
  assert.equal(signedWhole("45000.00"), "₹45,000");
  assert.equal(signedWhole("-1200.00"), "-₹1,200");
  assert.equal(signedWhole("-1200.50"), "-₹1,200.50");
  assert.equal(signedWhole("-0.00"), "₹0");
});

test("changeText words the server's signed change", () => {
  assert.equal(changeText({ amount: "1200.00", percent: 12 }, "spending"), "₹1,200 more than last month by this day");
  assert.equal(changeText({ amount: "-800.00", percent: -8 }, "spending"), "₹800 less than last month by this day");
  assert.equal(changeText({ amount: "0.00", percent: 0 }, "income"), "Same as last month by this day");
  assert.equal(changeText({ amount: "5000.00", percent: null }, "spending"), "No spending last month by this day");
  assert.equal(changeText({ amount: "5000.00", percent: null }, "income"), "No income last month by this day");
  // The net can be compared even when the month before was 0.
  assert.equal(changeText({ amount: "-300.00", percent: null }, "net"), "₹300 less than last month by this day");
});

test("percentText", () => {
  assert.equal(percentText({ amount: "1200.00", percent: 12 }), "+12%");
  assert.equal(percentText({ amount: "-800.00", percent: -8 }), "-8%");
  assert.equal(percentText({ amount: "5000.00", percent: null }), null);
  assert.equal(percentText({ amount: "0.00", percent: 0 }), null);
});

test("changeTone: less spending and more income are good news", () => {
  assert.equal(changeTone({ amount: "100.00", percent: 5 }, "spending"), "loss");
  assert.equal(changeTone({ amount: "-100.00", percent: -5 }, "spending"), "gain");
  assert.equal(changeTone({ amount: "100.00", percent: 5 }, "income"), "gain");
  assert.equal(changeTone({ amount: "-100.00", percent: -5 }, "net"), "loss");
  assert.equal(changeTone({ amount: "0.00", percent: 0 }, "spending"), null);
});

test("barWidth clamps the server's percent", () => {
  assert.equal(barWidth(32), 32);
  assert.equal(barWidth(140), 100);
  assert.equal(barWidth(-3), 0);
  assert.equal(barWidth(null), 0);
});

test("shortDay", () => {
  assert.equal(shortDay("2026-11-05"), "5 Nov");
});

test("biggestDay and dailySummary", () => {
  const daily = [
    { date: "2026-11-01", spent: "100.00", height: 10 },
    { date: "2026-11-02", spent: "1000.00", height: 100 },
    { date: "2026-11-03", spent: null, height: null },
  ];
  assert.equal(biggestDay(daily)?.date, "2026-11-02");
  assert.equal(dailySummary(daily), "Daily spending. Biggest day: 2 Nov, ₹1,000.00");
  const none = [{ date: "2026-11-01", spent: "0.00", height: 0 }];
  assert.equal(biggestDay(none), null);
  assert.equal(dailySummary(none), "Daily spending: nothing spent yet");
});

test("sliceText", () => {
  assert.equal(sliceText(slice()), "Food · ₹4,500 · 32%");
});

test("isEmptyMonth", () => {
  assert.equal(isEmptyMonth({ income: "0.00", spending: "0.00" }), true);
  assert.equal(isEmptyMonth({ income: "0.00", spending: "1.00" }), false);
});

test("sliceType keeps an income and a spending category of one name apart", () => {
  const data = { income_by_category: [slice({ name: "Other" }), slice({ name: "Salary", children: [slice({ name: "Bonus" })] })] };
  assert.equal(sliceType("income", "Salary", data), "income");
  assert.equal(sliceType("spending", "Food", data), null);
  assert.equal(sliceType("spending", "other", data), "expense");
  assert.equal(sliceType("spending", "Bonus", data), "expense");
});
