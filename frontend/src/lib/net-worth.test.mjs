import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changeSpoken,
  changeText,
  estimatedNote,
  lineSegments,
  longDate,
  monthLabel,
  monthTicks,
  nearestIndex,
  niceTicks,
  scale,
  shortRupees,
  stackLayers,
  stackTotals,
  stackValues,
} from "./net-worth.ts";

const FRAME = { width: 200, height: 100, left: 0, right: 0, top: 0, bottom: 0 };

const alloc = (o = {}) => ({
  bank_cash: "0.00",
  deposits: "0.00",
  stocks: "0.00",
  funds: "0.00",
  crypto: "0.00",
  ...o,
});
const pt = (date, worth, estimated = false, allocation = alloc({ bank_cash: worth })) => ({
  date,
  net_worth: worth,
  total_have: worth,
  total_owe: "0.00",
  allocation,
  estimated,
});

test("the change reads with an arrow and whole rupees", () => {
  const since = "since last month";
  assert.equal(changeText({ amount: "22000.00", from_date: "2026-10-12" }, since), "▲ ₹22,000 since last month");
  assert.equal(changeText({ amount: "-1500.50", from_date: "2026-10-12" }, since), "▼ ₹1,500.50 since last month");
  assert.equal(changeText({ amount: "0.00", from_date: "2026-10-12" }, since), "No change since last month");
  assert.equal(changeText({ amount: "-0.00", from_date: "2026-10-12" }, since), "No change since last month");
  assert.equal(changeText(null, since), null);
});

test("the spoken change says up or down instead of an arrow", () => {
  assert.equal(changeSpoken({ amount: "250000.00", from_date: "x" }, "since 1 Nov"), "Up ₹2,50,000 since 1 Nov");
  assert.equal(changeSpoken({ amount: "-5.00", from_date: "x" }, "since 1 Nov"), "Down ₹5 since 1 Nov");
  assert.equal(changeSpoken(null, "since 1 Nov"), null);
});

test("axis labels use thousands, lakhs and crores", () => {
  assert.equal(shortRupees(0), "₹0");
  assert.equal(shortRupees(950), "₹950");
  assert.equal(shortRupees(40000), "₹40K");
  assert.equal(shortRupees(500000), "₹5L");
  assert.equal(shortRupees(1250000), "₹12.5L");
  assert.equal(shortRupees(12000000), "₹1.2Cr");
  assert.equal(shortRupees(-200000), "-₹2L");
});

test("dates read from the text", () => {
  assert.equal(longDate("2026-10-02"), "2 Oct 2026");
  assert.equal(monthLabel("2026-01-01"), "Jan '26");
});

test("ticks are round and cover the values", () => {
  assert.deepEqual(niceTicks(0, 100), [0, 25, 50, 75, 100]);
  const ticks = niceTicks(312000, 498000);
  assert.ok(ticks[0] <= 312000 && ticks.at(-1) >= 498000);
  assert.ok(ticks.length >= 3 && ticks.length <= 7);
  // One value still gives a range to draw in.
  const flat = niceTicks(500, 500);
  assert.ok(flat[0] < 500 && flat.at(-1) > 500);
});

test("x is spaced by date, so a gap takes room", () => {
  const s = scale(["2026-01-01", "2026-01-11", "2026-01-21"].map(String), [0, 100], FRAME);
  assert.equal(s.x("2026-01-01"), 0);
  assert.equal(s.x("2026-01-11"), 100);
  assert.equal(s.x("2026-01-21"), 200);
  // Tight fits the values exactly, for a sparkline.
  const tight = scale(["2026-01-01", "2026-01-21"], [300, 500], FRAME, true);
  assert.deepEqual([tight.y(500), tight.y(300)], [0, 100]);
  // A single point sits in the middle.
  assert.equal(scale(["2026-01-01"], [5], FRAME).x("2026-01-01"), 100);
});

test("the line splits into estimated and real runs, and breaks on a long gap", () => {
  const points = [
    pt("2026-01-31", "100.00", true),
    pt("2026-02-28", "120.00", true),
    pt("2026-03-05", "130.00"),
    pt("2026-03-06", "140.00"),
    pt("2026-06-01", "150.00"), // 87 days later
    pt("2026-06-02", "160.00"),
  ];
  const s = scale(points.map((p) => p.date), points.map((p) => Number(p.net_worth)), FRAME);
  const segs = lineSegments(points, s);
  assert.deepEqual(
    segs.map((g) => [g.estimated, g.path.split(" L ").length]),
    [
      [true, 3], // Jan -> Feb -> Mar 5 (the link into the first real point is still estimated)
      [false, 2], // Mar 5 -> Mar 6
      [false, 2], // Jun 1 -> Jun 2, after the gap
    ],
  );
  assert.ok(segs[0].path.startsWith("M 0 "));
});

test("a single point draws no line", () => {
  const points = [pt("2026-11-13", "10.00")];
  assert.deepEqual(lineSegments(points, scale(["2026-11-13"], [10], FRAME)), []);
});

test("stacks draw negative groups as zero and skip empty groups", () => {
  const p = pt("2026-11-13", "50.00", false, alloc({ bank_cash: "-20.00", stocks: "70.00" }));
  assert.deepEqual(stackValues(p), { bank_cash: 0, deposits: 0, stocks: 70, funds: 0, crypto: 0 });
  assert.deepEqual(stackTotals([p]), [70]);

  const points = [
    pt("2026-11-01", "30.00", false, alloc({ bank_cash: "10.00", funds: "20.00" })),
    pt("2026-11-13", "40.00", false, alloc({ bank_cash: "15.00", funds: "25.00" })),
  ];
  const s = scale(["2026-11-01", "2026-11-13"], [0, 40], FRAME);
  const layers = stackLayers(points, s);
  assert.deepEqual(
    layers.map((l) => l.group),
    ["bank_cash", "funds"],
  );
  assert.ok(layers.every((l) => l.path.startsWith("M ") && l.path.endsWith(" Z")));
});

test("the nearest point to the pointer", () => {
  assert.equal(nearestIndex([0, 50, 100], 70), 1);
  assert.equal(nearestIndex([0, 50, 100], 80), 2);
  assert.equal(nearestIndex([10], 999), 0);
});

test("month ticks are month starts inside the range, thinned to fit", () => {
  assert.deepEqual(monthTicks("2026-08-13", "2026-11-13"), ["2026-09-01", "2026-10-01", "2026-11-01"]);
  const year = monthTicks("2025-11-13", "2026-11-13", 6);
  assert.equal(year.length, 6);
  assert.equal(year[0], "2025-12-01");
  assert.deepEqual(monthTicks("2026-11-13", "2026-11-13"), []);
});

test("the estimated note names the day snapshots began", () => {
  const history = {
    range: "1y",
    today: "2026-11-13",
    points: [pt("2026-10-31", "1.00", true), pt("2026-11-13", "2.00")],
    since_last_month: null,
    since_start: null,
    tracked_since: "2026-11-13",
  };
  assert.equal(
    estimatedNote(history),
    "History before 13 Nov 2026 is estimated from your transactions and leaves out stocks, funds and coins.",
  );
  assert.equal(estimatedNote({ ...history, points: [pt("2026-11-13", "2.00")] }), null);
});
