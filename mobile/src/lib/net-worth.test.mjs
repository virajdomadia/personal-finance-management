import assert from "node:assert/strict";
import { test } from "node:test";

import { changeSpoken, changeText, estimatedNote, lineRuns, monthRows, monthYear } from "./net-worth.ts";

const pt = (date, worth, estimated = false) => ({
  date,
  net_worth: worth,
  total_have: worth,
  total_owe: "0.00",
  allocation: { bank_cash: worth, deposits: "0.00", stocks: "0.00", funds: "0.00", crypto: "0.00" },
  estimated,
});

test("the change has an arrow, whole rupees, and a spoken form", () => {
  assert.equal(changeText({ amount: "22000.00", from_date: "2026-10-12" }), "▲ ₹22,000 since last month");
  assert.equal(changeText({ amount: "-1500.50", from_date: "2026-10-12" }), "▼ ₹1,500.50 since last month");
  assert.equal(changeText({ amount: "0.00", from_date: "2026-10-12" }), "No change since last month");
  assert.equal(changeText(null), null);
  assert.equal(changeSpoken({ amount: "-250000.00", from_date: "x" }), "Down ₹2,50,000 since last month");
  assert.equal(changeSpoken({ amount: "5.00", from_date: "x" }, "since 1 Nov"), "Up ₹5 since 1 Nov");
});

test("month labels read from the text", () => {
  assert.equal(monthYear("2026-10-31"), "Oct 2026");
});

test("the line is placed by date and split into estimated, real and gap runs", () => {
  const points = [
    pt("2026-01-01", "100.00", true),
    pt("2026-01-11", "200.00", true),
    pt("2026-01-21", "300.00"),
    pt("2026-01-31", "300.00"),
    pt("2026-05-01", "400.00"), // 90 days later
    pt("2026-05-02", "400.00"),
  ];
  const { dots, runs } = lineRuns(points, 120, 50, 0);
  assert.deepEqual(dots[0], { x: 0, y: 50, estimated: true });
  assert.equal(dots[1].x, Math.round(((10 / 121) * 120) * 10) / 10);
  assert.equal(dots[5].y, 0);
  assert.deepEqual(
    runs.map((r) => [r.estimated, r.points.split(" ").length]),
    [
      [true, 3],
      [false, 2],
      [false, 2],
    ],
  );
});

test("one point sits in the middle with no line", () => {
  const { dots, runs } = lineRuns([pt("2026-11-13", "10.00")], 100, 40, 0);
  assert.deepEqual(dots, [{ x: 50, y: 20, estimated: false }]);
  assert.deepEqual(runs, []);
  assert.deepEqual(lineRuns([], 100, 40), { dots: [], runs: [] });
});

test("month rows keep each month's last point, newest first, with today on top", () => {
  const rows = monthRows([
    pt("2026-09-30", "1.00", true),
    pt("2026-10-31", "2.00", true),
    pt("2026-11-10", "3.00"),
    pt("2026-11-13", "4.00"),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.label, r.point.net_worth, r.today]),
    [
      ["Today", "4.00", true],
      ["Oct 2026", "2.00", false],
      ["Sep 2026", "1.00", false],
    ],
  );
});

test("the estimated note names the day snapshots began", () => {
  const history = {
    range: "1y",
    today: "2026-11-13",
    points: [pt("2026-10-31", "1.00", true), pt("2026-11-13", "2.00")],
    since_last_month: null,
    since_start: null,
    tracked_since: "2026-11-03",
  };
  assert.equal(
    estimatedNote(history),
    "History before 3 Nov 2026 is estimated from your transactions and leaves out stocks, funds and coins.",
  );
  assert.equal(estimatedNote({ ...history, points: [pt("2026-11-13", "2.00")] }), null);
});
