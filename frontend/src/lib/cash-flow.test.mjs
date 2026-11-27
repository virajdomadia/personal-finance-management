import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeFilterCount,
  blankFilters,
  calendarPath,
  calendarWeeks,
  categoryLink,
  changeText,
  changeTone,
  dayTone,
  dayTransactionsHref,
  filtersFromParams,
  netText,
  netWords,
  paramsFromFilters,
  searchQuery,
  shortDate,
  shortRupees,
  sliceType,
} from "./cash-flow.ts";

const previous = { month: "2026-10", start: "2026-10-01", through: "2026-10-12", income: "0", spending: "0", net: "0" };

test("shortDate", () => {
  assert.equal(shortDate("2026-10-02"), "2 Oct");
});

test("changeText words the server's change", () => {
  assert.equal(
    changeText({ amount: "6200.00", percent: 155 }, previous, false),
    "₹6,200.00 more than 1–12 Oct (+155%)",
  );
  assert.equal(changeText({ amount: "-50.00", percent: -8 }, previous, false), "₹50.00 less than 1–12 Oct (-8%)");
  assert.equal(changeText({ amount: "300.00", percent: null }, previous, true), "₹300.00 more than Oct");
  assert.equal(changeText({ amount: "0.00", percent: 0 }, previous, false), "Same as 1–12 Oct");
});

test("changeTone: less spending and more income are good", () => {
  assert.equal(changeTone({ amount: "-1.00", percent: -1 }, "spending"), "good");
  assert.equal(changeTone({ amount: "1.00", percent: 1 }, "spending"), "bad");
  assert.equal(changeTone({ amount: "1.00", percent: 1 }, "income"), "good");
  assert.equal(changeTone({ amount: "0.00", percent: 0 }, "income"), "same");
});

test("searchQuery sends the month, or the range instead", () => {
  const f = { ...blankFilters("2026-11"), q: " plumber ", min: "100", category: "Food and dining" };
  assert.equal(
    searchQuery(f, 50, 0),
    "/transactions?limit=50&offset=0&month=2026-11&q=plumber&category=Food+and+dining&amount_min=100",
  );
  const ranged = { ...blankFilters("2026-11"), from: "2026-01-01", accountId: 3, type: "expense" };
  assert.equal(
    searchQuery(ranged, 50, 50),
    "/transactions?limit=50&offset=50&date_from=2026-01-01&account_id=3&type=expense",
  );
});

test("filters round-trip through the address and drop bad values", () => {
  const f = filtersFromParams(
    new URLSearchParams("month=2026-09&account=4&type=emi&q=rent&category=Housing&from=2026-01-01&min=10.5&max=abc"),
    "2026-11",
  );
  assert.deepEqual(f, {
    month: "2026-09",
    q: "rent",
    accountId: 4,
    type: "emi",
    category: "Housing",
    from: "2026-01-01",
    to: "",
    min: "10.5",
    max: "",
  });
  assert.equal(paramsFromFilters(f, "2026-11"), "?account=4&type=emi&q=rent&category=Housing&from=2026-01-01&min=10.5");
  assert.equal(filtersFromParams(new URLSearchParams("month=2027-01&type=x"), "2026-11").month, "2026-11");
  assert.equal(paramsFromFilters(blankFilters("2026-11"), "2026-11"), "");
});

test("categoryLink and activeFilterCount", () => {
  const none = { income_by_category: [] };
  assert.equal(categoryLink("2026-11", "Food and dining", "expense", none), "/transactions?month=2026-11&category=Food+and+dining");
  assert.equal(categoryLink("2026-11", "Other", "income", none), "/transactions?month=2026-11&category=Other&type=income");
  assert.equal(activeFilterCount(blankFilters("2026-11")), 0);
  assert.equal(activeFilterCount({ ...blankFilters("2026-11"), q: "x", min: "1", to: "2026-01-01" }), 2);
});

test("sliceType keeps spending apart from income of the same name", () => {
  const slice = (name, children = []) => ({ id: null, name, icon: null, colour: null, amount: "1.00", percent: 100, direct: "1.00", children });
  const data = { income_by_category: [slice("Other"), slice("Salary", [slice("Bonus")]), slice("Uncategorised")] };
  assert.equal(sliceType("expense", "Other", data), "expense");
  assert.equal(sliceType("expense", "uncategorised", data), "expense");
  assert.equal(sliceType("expense", "Bonus", data), "expense");
  assert.equal(sliceType("expense", "Loan interest", data), null);
  assert.equal(sliceType("income", "Salary", data), "income");
  assert.equal(
    categoryLink("2026-11", "Other", "expense", data),
    "/transactions?month=2026-11&category=Other&type=expense",
  );
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
  assert.deepEqual(weeks[5].slice(1), [null, null, null, null, null, null]);
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

test("dayTone: spent, gained, nothing, or still to come", () => {
  assert.equal(dayTone({ date: "2026-11-13", net: null }), "future");
  assert.equal(dayTone({ date: "2026-11-03", net: "4000.00" }), "spent");
  assert.equal(dayTone({ date: "2026-11-01", net: "-72000.00" }), "gained");
  assert.equal(dayTone({ date: "2026-11-02", net: "0.00" }), "none");
});

test("netText: what was spent, or + what came in on top", () => {
  assert.equal(netText("4000.00"), "₹4k");
  assert.equal(netText("-72000.00"), "+₹72k");
  assert.equal(netText("0.00"), "₹0");
  assert.equal(netText("420.00"), "₹420");
});

test("netWords for a screen reader", () => {
  assert.equal(netWords("4000.00"), "spent ₹4,000");
  assert.equal(netWords("-72000.00"), "₹72,000 more came in than went out");
  assert.equal(netWords("0.00"), "nothing spent");
});

test("dayTransactionsHref", () => {
  assert.equal(dayTransactionsHref("2026-11-05"), "/transactions?from=2026-11-05&to=2026-11-05");
});
