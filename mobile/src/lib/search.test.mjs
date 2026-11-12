import assert from "node:assert/strict";
import { test } from "node:test";

import {
  amountLabel,
  blankFilters,
  dateRangeLabel,
  filterChips,
  filterErrors,
  hasDateRange,
  isNarrowed,
  removeFilter,
  transactionsQuery,
} from "./search.ts";

const names = { 3: "HDFC" };
const accountName = (id) => names[id];

test("transactionsQuery sends the month and the page", () => {
  assert.equal(transactionsQuery(blankFilters("2026-11"), 0, 50), "/transactions?month=2026-11&limit=50&offset=0");
});

test("transactionsQuery sends every filter, encoded", () => {
  const f = {
    ...blankFilters("2026-11", 3),
    q: "  chai & snacks ",
    type: "expense",
    category: "Food and dining",
    amountMin: "₹1,500",
    amountMax: "2000.50",
  };
  assert.equal(
    transactionsQuery(f, 50, 50),
    "/transactions?month=2026-11&limit=50&offset=50&account_id=3&type=expense&q=chai%20%26%20snacks&category=Food%20and%20dining&amount_min=1500&amount_max=2000.50",
  );
});

test("a date range replaces the month", () => {
  const f = { ...blankFilters("2026-11"), dateFrom: "2026-10-01", dateTo: "2026-10-15" };
  assert.equal(hasDateRange(f), true);
  assert.equal(transactionsQuery(f, 0, 50), "/transactions?date_from=2026-10-01&date_to=2026-10-15&limit=50&offset=0");
  const open = { ...blankFilters("2026-11"), dateTo: "2026-10-15" };
  assert.equal(transactionsQuery(open, 0, 50), "/transactions?date_to=2026-10-15&limit=50&offset=0");
});

test("blank text filters are left out", () => {
  const f = { ...blankFilters("2026-11"), q: "   ", category: " ", amountMin: " " };
  assert.equal(transactionsQuery(f, 0, 50), "/transactions?month=2026-11&limit=50&offset=0");
});

test("amountLabel", () => {
  assert.equal(amountLabel("500", "2000"), "₹500 – ₹2,000");
  assert.equal(amountLabel("500", ""), "₹500 or more");
  assert.equal(amountLabel("", "2000.50"), "Up to ₹2,000.50");
  assert.equal(amountLabel("", ""), null);
});

test("dateRangeLabel", () => {
  assert.equal(dateRangeLabel("2026-11-01", "2026-11-12"), "1 Nov 2026 – 12 Nov 2026");
  assert.equal(dateRangeLabel("2026-11-01", "2026-11-01"), "1 Nov 2026");
  assert.equal(dateRangeLabel("2026-11-01", ""), "From 1 Nov 2026");
  assert.equal(dateRangeLabel("", "2026-11-12"), "Until 12 Nov 2026");
  assert.equal(dateRangeLabel("", ""), null);
});

test("filterChips lists the active filters", () => {
  assert.deepEqual(filterChips(blankFilters("2026-11"), accountName), []);
  const f = {
    ...blankFilters("2026-11", 3),
    dateFrom: "2026-11-01",
    type: "income",
    category: "Uncategorised",
    amountMin: "500",
  };
  assert.deepEqual(filterChips(f, accountName), [
    { key: "dates", label: "From 1 Nov 2026" },
    { key: "type", label: "Income" },
    { key: "account", label: "HDFC" },
    { key: "category", label: "Uncategorised" },
    { key: "amount", label: "₹500 or more" },
  ]);
  // One account's own list doesn't show it as a filter.
  assert.equal(
    filterChips(f, accountName, true).some((c) => c.key === "account"),
    false,
  );
  assert.equal(filterChips({ ...blankFilters("2026-11", 9) }, accountName)[0].label, "One account");
});

test("removeFilter clears just that filter", () => {
  const f = { ...blankFilters("2026-11", 3), dateFrom: "2026-11-01", dateTo: "2026-11-02", type: "expense", amountMax: "9", q: "x" };
  assert.deepEqual(removeFilter(f, "dates"), { ...f, dateFrom: "", dateTo: "" });
  assert.deepEqual(removeFilter(f, "amount"), { ...f, amountMin: "", amountMax: "" });
  assert.equal(removeFilter(f, "account").accountId, null);
  assert.equal(removeFilter(f, "type").type, null);
  assert.equal(removeFilter(f, "q").q, "");
  assert.equal(removeFilter({ ...f, category: "Food" }, "category").category, null);
});

test("isNarrowed", () => {
  assert.equal(isNarrowed(blankFilters("2026-11")), false);
  assert.equal(isNarrowed({ ...blankFilters("2026-11"), dateFrom: "2026-11-01" }), false);
  assert.equal(isNarrowed({ ...blankFilters("2026-11"), q: "rent" }), true);
  assert.equal(isNarrowed({ ...blankFilters("2026-11"), category: "Food" }), true);
  assert.equal(isNarrowed(blankFilters("2026-11", 3), true), false);
});

test("filterErrors", () => {
  assert.deepEqual(filterErrors(blankFilters("2026-11")), {});
  assert.deepEqual(filterErrors({ ...blankFilters("2026-11"), dateFrom: "2026-11-05", dateTo: "2026-11-01" }), {
    dateTo: "The end date can't be before the start.",
  });
  assert.deepEqual(filterErrors({ ...blankFilters("2026-11"), amountMin: "abc" }), {
    amountMin: "Enter an amount like 500 or 500.50.",
  });
  assert.deepEqual(filterErrors({ ...blankFilters("2026-11"), amountMin: "2,000", amountMax: "500" }), {
    amountMax: "The highest amount can't be below the lowest.",
  });
  assert.deepEqual(filterErrors({ ...blankFilters("2026-11"), amountMin: "500", amountMax: "500.00" }), {});
});
