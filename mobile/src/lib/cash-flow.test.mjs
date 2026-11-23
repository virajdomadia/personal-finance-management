import assert from "node:assert/strict";
import { test } from "node:test";

import {
  barWidth,
  biggestDay,
  calendarPath,
  calendarWeeks,
  cashFlowPath,
  changeText,
  changeTone,
  dailySummary,
  dayTone,
  isEmptyMonth,
  isZero,
  leadMark,
  marksByDate,
  markText,
  monthLabel,
  paceText,
  percentText,
  shortDay,
  shortRupees,
  signedWhole,
  sliceText,
  sliceType,
  splitTemplates,
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

// --- Spend calendar ---------------------------------------------------------------------------


const novemberDays = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-11-${String(i + 1).padStart(2, "0")}`,
  spent: i < 12 ? "100.00" : null,
  over: i < 12 ? false : null,
}));

test("calendarPath", () => {
  assert.equal(calendarPath(null), "/calendar");
  assert.equal(calendarPath("2026-10"), "/calendar?month=2026-10");
});

test("calendarWeeks starts on Monday and pads with nulls", () => {
  const weeks = calendarWeeks(novemberDays);
  assert.equal(weeks.length, 6);
  assert.deepEqual(weeks[0].slice(0, 6), [null, null, null, null, null, null]);
  assert.equal(weeks[0][6].date, "2026-11-01");
  assert.equal(weeks[5][0].date, "2026-11-30");
  assert.ok(weeks.every((w) => w.length === 7));
});

test("shortRupees", () => {
  assert.equal(shortRupees("0.00"), "₹0");
  assert.equal(shortRupees("420.00"), "₹420");
  assert.equal(shortRupees("999.60"), "₹1,000");
  assert.equal(shortRupees("1234.00"), "₹1.2k");
  assert.equal(shortRupees("125000.00"), "₹1.3L");
  assert.equal(shortRupees("-1500.00"), "−₹1.5k");
});

test("dayTone", () => {
  assert.equal(dayTone({ date: "2026-11-13", spent: null, over: null }), "future");
  assert.equal(dayTone({ date: "2026-11-05", spent: "600.00", over: false }), "under");
  assert.equal(dayTone({ date: "2026-11-05", spent: "1600.00", over: true }), "over");
  assert.equal(dayTone({ date: "2026-11-05", spent: "600.00", over: null }), "plain");
});

test("paceText", () => {
  assert.equal(paceText("2000.00"), "₹2,000 under pace");
  assert.equal(paceText("-500.00"), "₹500 over pace");
  assert.equal(paceText("0.00"), "Right on pace");
  assert.equal(paceText(null), null);
});

const mark = (date, name, state, kind = "out") => ({ date, template_id: 1, name, amount: "16000.00", kind, state });

test("marksByDate groups a month's marks by day", () => {
  const byDate = marksByDate([mark("2026-11-05", "Rent", "paid"), mark("2026-11-05", "Gym", "due"), mark("2026-11-10", "PPF", "coming")]);
  assert.deepEqual([...byDate.keys()], ["2026-11-05", "2026-11-10"]);
  assert.equal(byDate.get("2026-11-05").length, 2);
});

test("markText", () => {
  assert.equal(markText(mark("2026-11-05", "Rent", "paid")), "Rent ₹16,000 paid");
  assert.equal(markText(mark("2026-11-05", "Rent", "due")), "Rent ₹16,000 due");
  assert.equal(markText(mark("2026-11-05", "Rent", "skipped")), "Rent ₹16,000 skipped");
  assert.equal(markText(mark("2026-11-01", "Salary", "paid", "income")), "Salary ₹16,000 received");
});

test("splitTemplates: fixed is active monthly, other is yearly or stopped", () => {
  const t = (id, frequency, active) => ({ id, frequency, active });
  const { fixed, other } = splitTemplates([t(1, "monthly", true), t(2, "yearly", true), t(3, "monthly", false)]);
  assert.deepEqual(fixed.map((x) => x.id), [1]);
  assert.deepEqual(other.map((x) => x.id), [2, 3]);
});

test("leadMark picks the most urgent mark and counts the rest", () => {
  assert.equal(leadMark([]), null);
  const lead = leadMark([mark("2026-11-05", "Rent", "paid"), mark("2026-11-05", "EMI", "due"), mark("2026-11-05", "Gym", "coming")]);
  assert.equal(lead.mark.name, "EMI");
  assert.equal(lead.more, 2);
  assert.equal(leadMark([mark("2026-11-05", "Gym", "skipped"), mark("2026-11-05", "PPF", "coming")]).mark.name, "PPF");
});
