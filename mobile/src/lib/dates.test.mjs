import assert from "node:assert/strict";
import { test } from "node:test";

import { dateToIso, isoToDate } from "./dates.ts";

test("isoToDate builds a local-midnight date from the parts", () => {
  const date = isoToDate("2026-03-05");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 2);
  assert.equal(date.getDate(), 5);
  assert.equal(date.getHours(), 0);
});

test("dateToIso reads local parts, so a late local time keeps its day", () => {
  assert.equal(dateToIso(new Date(2026, 0, 1, 0, 30)), "2026-01-01");
  assert.equal(dateToIso(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
  assert.equal(dateToIso(new Date(2026, 2, 5)), "2026-03-05");
});

test("a round trip returns the same text", () => {
  for (const iso of ["2026-02-28", "2024-02-29", "2026-10-01"]) assert.equal(dateToIso(isoToDate(iso)), iso);
});

test("isoToDate falls back to the fallback date for blank or malformed text", () => {
  const fallback = new Date(2026, 5, 15);
  assert.equal(isoToDate("", fallback), fallback);
  assert.equal(isoToDate("12-05-2026", fallback), fallback);
  assert.equal(isoToDate("2026-02-31", fallback), fallback);
});
