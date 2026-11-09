import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

// The same checks in zones either side of India, run in a child process because TZ is read at start.
const probe = `
import { dateToIso, isoToDate } from ${JSON.stringify(new URL("./dates.ts", import.meta.url).href)};
const now = new Date();
const local = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
const out = { local, today: dateToIso(now), roundTrip: dateToIso(isoToDate(local)), shifted: [] };
for (const iso of ["2026-01-01", "2026-03-29", "2026-10-25", "2024-02-29", "2026-12-31"]) {
  if (dateToIso(isoToDate(iso)) !== iso) out.shifted.push(iso);
}
console.log(JSON.stringify(out));
`;

for (const zone of ["America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata", "UTC"]) {
  test(`dates keep their day when the device is in ${zone}`, () => {
    const run = spawnSync(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", probe],
      { env: { ...process.env, TZ: zone }, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.today, out.local);
    assert.equal(out.roundTrip, out.local);
    assert.deepEqual(out.shifted, []);
  });
}
