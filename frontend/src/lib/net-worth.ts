// Net worth over time: the API's shapes, the change wording and the chart geometry.
// Amounts stay strings from the server; numbers are made only to place points on a chart.

import { formatRupees } from "./accounts.ts";

export const GROUPS = ["bank_cash", "deposits", "stocks", "funds", "crypto"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_LABELS: Record<Group, string> = {
  bank_cash: "Bank & cash",
  deposits: "Deposits",
  stocks: "Stocks",
  funds: "Funds",
  crypto: "Crypto",
};

// One fixed colour per group, so a group keeps its colour whichever others are shown.
export const GROUP_COLORS: Record<Group, string> = {
  bank_cash: "#58CC02",
  deposits: "#FFC800",
  stocks: "#FF4B8B",
  funds: "#1CB0F6",
  crypto: "#A560FF",
};

export type NetWorthPoint = {
  date: string;
  net_worth: string;
  total_have: string;
  total_owe: string;
  allocation: Record<Group, string>;
  estimated: boolean; // worked out from transactions, before snapshots began
};

export type Change = {
  amount: string; // today minus the compared snapshot, signed
  from_date: string;
  estimated: boolean; // against an estimate, so both sides leave out stocks, funds and coins
  on_target: boolean; // from_date is within 3 days of the day it looked for
};

export type NetWorthRange = "3m" | "6m" | "1y" | "all";

export type NetWorthHistory = {
  range: NetWorthRange;
  today: string;
  points: NetWorthPoint[]; // oldest first; the last is today
  since_last_month: Change | null;
  since_start: Change | null;
  tracked_since: string | null; // the first real snapshot
};

export const RANGES: { value: NetWorthRange; label: string }[] = [
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "1y", label: "1Y" },
  { value: "all", label: "All" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-12" -> "12 Oct 2026", from the text so no timezone can shift the day.
export function longDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

// "2026-10-12" -> "Oct '26", for the x axis.
export function monthLabel(iso: string): string {
  const [year, month] = iso.split("-");
  return `${MONTHS[Number(month) - 1]} '${year.slice(2)}`;
}

// ₹22,000 rather than ₹22,000.00; paise stay when there are any.
export function wholeRupees(money: string): string {
  return formatRupees(money.replace(/\.00$/, ""));
}

export type Direction = "up" | "down" | "flat";

export function direction(change: Change): Direction {
  if (/^-?0+(\.0+)?$/.test(change.amount)) return "flat";
  return change.amount.startsWith("-") ? "down" : "up";
}

// "▲ ₹22,000 since last month", "▼ ₹1,500 since last month" or "No change since last month".
export function changeText(change: Change | null, since: string): string | null {
  if (change === null) return null;
  const way = direction(change);
  if (way === "flat") return `No change ${since}`;
  const size = wholeRupees(change.amount.replace(/^-/, ""));
  return `${way === "up" ? "▲" : "▼"} ${size} ${since}`;
}

// Spoken form, without the arrows: "Up ₹22,000 since last month".
export function changeSpoken(change: Change | null, since: string): string | null {
  if (change === null) return null;
  const way = direction(change);
  if (way === "flat") return `No change ${since}`;
  const size = wholeRupees(change.amount.replace(/^-/, ""));
  return `${way === "up" ? "Up" : "Down"} ${size} ${since}`;
}

// "since last month", or the date itself when the compared point is an estimate or off the day:
// "since 30 Sep (estimated)".
function lastMonthSince(change: Change, spoken: boolean): string {
  if (!change.estimated && change.on_target) return "since last month";
  const [, month, day] = change.from_date.split("-");
  const since = `since ${Number(day)} ${MONTHS[Number(month) - 1]}`;
  if (!change.estimated) return since;
  return spoken ? `${since}, estimated` : `${since} (estimated)`;
}

export function lastMonthText(change: Change | null): string | null {
  return change === null ? null : changeText(change, lastMonthSince(change, false));
}

export function lastMonthSpoken(change: Change | null): string | null {
  return change === null ? null : changeSpoken(change, lastMonthSince(change, true));
}

// Axis labels the Indian way: ₹40K, ₹5L, ₹1.2Cr.
export function shortRupees(value: number): string {
  const sign = value < 0 ? "-" : "";
  const size = Math.abs(value);
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, "");
  if (size >= 1e7) return `${sign}₹${trim(size / 1e7)}Cr`;
  if (size >= 1e5) return `${sign}₹${trim(size / 1e5)}L`;
  if (size >= 1e3) return `${sign}₹${trim(size / 1e3)}K`;
  return `${sign}₹${Math.round(size)}`;
}

// Days since 1970 for an ISO date, read as UTC so no timezone moves it.
export function dayNumber(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

// A gap longer than this breaks the line instead of joining across it.
export const GAP_DAYS = 45;

export type Frame = { width: number; height: number; left: number; right: number; top: number; bottom: number };

// Round tick values spanning min..max (about `count` of them).
// The axis spans at least ₹4 or 4% of the values, so a step is never under ₹1 or 1%: values a few
// paise apart would otherwise get several ticks with the same label.
export function niceTicks(low: number, high: number, count = 4): number[] {
  const [min, max] = widened(low, high);
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const first = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = first; v < max + step - 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

// min..max, widened around its middle to the least span an axis may have (see niceTicks).
export function widened(min: number, max: number): [number, number] {
  const least = Math.max(4, Math.max(Math.abs(min), Math.abs(max)) * 0.04);
  if (max - min >= least) return [min, max];
  const mid = (min + max) / 2;
  return [mid - least / 2, mid + least / 2];
}

export type Scale = {
  x: (iso: string) => number;
  y: (value: number) => number;
  ticks: number[];
};

// x spaced by date; y over the ticks that cover the values, or exactly min..max when `tight`
// (a sparkline has no axis, so round ticks would only flatten it).
export function scale(dates: string[], values: number[], frame: Frame, tight = false): Scale {
  const innerW = frame.width - frame.left - frame.right;
  const innerH = frame.height - frame.top - frame.bottom;
  const first = dayNumber(dates[0]);
  const span = dayNumber(dates[dates.length - 1]) - first;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const ticks = tight ? widened(min, max) : niceTicks(min, max);
  const low = ticks[0];
  const high = ticks[ticks.length - 1];
  return {
    x: (iso) => frame.left + (span > 0 ? ((dayNumber(iso) - first) / span) * innerW : innerW / 2),
    y: (value) => frame.top + innerH - ((value - low) / (high - low)) * innerH,
    ticks,
  };
}

export type Segment = { path: string; estimated: boolean };

// The net worth line as runs of segments: a link touching an estimated point is dashed (estimated),
// and a gap over GAP_DAYS starts a new run.
export function lineSegments(points: NetWorthPoint[], s: Scale): Segment[] {
  type Run = { coords: string[]; estimated: boolean };
  const runs: Run[] = [];
  let current: Run | null = null;
  const at = (p: NetWorthPoint) => `${round(s.x(p.date))} ${round(s.y(Number(p.net_worth)))}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (dayNumber(b.date) - dayNumber(a.date) > GAP_DAYS) {
      current = null;
      continue;
    }
    const estimated = a.estimated || b.estimated;
    if (current === null || current.estimated !== estimated) {
      current = { coords: [at(a)], estimated };
      runs.push(current);
    }
    current.coords.push(at(b));
  }
  return runs.map((run) => ({ path: `M ${run.coords.join(" L ")}`, estimated: run.estimated }));
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// What each group contributes on a date for the stacked chart: below zero is drawn as zero.
export function stackValues(point: NetWorthPoint): Record<Group, number> {
  const out = {} as Record<Group, number>;
  for (const g of GROUPS) out[g] = Math.max(0, Number(point.allocation[g]));
  return out;
}

export type Layer = { group: Group; path: string };

// Stacked areas, bottom group first. Groups that are zero throughout are left out.
export function stackLayers(points: NetWorthPoint[], s: Scale): Layer[] {
  const values = points.map(stackValues);
  const base = points.map(() => 0);
  const layers: Layer[] = [];
  for (const g of GROUPS) {
    if (!values.some((v) => v[g] > 0)) continue;
    const top = values.map((v, i) => base[i] + v[g]);
    const xs = points.map((p) => round(s.x(p.date)));
    const upper = xs.map((x, i) => `${x} ${round(s.y(top[i]))}`);
    const lower = xs.map((x, i) => `${x} ${round(s.y(base[i]))}`).reverse();
    layers.push({ group: g, path: `M ${upper.join(" L ")} L ${lower.join(" L ")} Z` });
    top.forEach((t, i) => (base[i] = t));
  }
  return layers;
}

// The highest stack, for the allocation chart's y scale.
export function stackTotals(points: NetWorthPoint[]): number[] {
  return points.map((p) => {
    const v = stackValues(p);
    return GROUPS.reduce((sum, g) => sum + v[g], 0);
  });
}

// The index of the point whose x is closest to `x`.
export function nearestIndex(xs: number[], x: number): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
  return best;
}

// Up to `max` month starts between the first and last dates, evenly picked, for the x axis.
export function monthTicks(first: string, last: string, max = 6): string[] {
  const [fy, fm] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  const starts: string[] = [];
  let y = fy;
  let m = fm + 1;
  if (m > 12) [y, m] = [y + 1, 1];
  while (y < ly || (y === ly && m <= lm)) {
    starts.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  const step = Math.max(1, Math.ceil(starts.length / max));
  return starts.filter((_, i) => i % step === 0);
}

// The note shown when any point is estimated.
export function estimatedNote(history: NetWorthHistory): string | null {
  if (!history.points.some((p) => p.estimated)) return null;
  const from = history.tracked_since ? ` before ${longDate(history.tracked_since)}` : "";
  return `History${from} is estimated from your transactions and leaves out stocks, funds and coins.`;
}
