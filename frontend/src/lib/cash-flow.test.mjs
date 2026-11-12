import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeFilterCount,
  blankFilters,
  categoryLink,
  changeText,
  changeTone,
  filtersFromParams,
  paramsFromFilters,
  searchQuery,
  shortDate,
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
  assert.equal(categoryLink("2026-11", "Food and dining", "expense"), "/transactions?month=2026-11&category=Food+and+dining");
  assert.equal(categoryLink("2026-11", "Other", "income"), "/transactions?month=2026-11&category=Other&type=income");
  assert.equal(activeFilterCount(blankFilters("2026-11")), 0);
  assert.equal(activeFilterCount({ ...blankFilters("2026-11"), q: "x", min: "1", to: "2026-01-01" }), 2);
});
