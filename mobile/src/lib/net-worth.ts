// Net worth over time for the app: the API's shapes, the change wording, the line's points and
// the month list. Amounts stay strings from the server; numbers are made only to draw the line.

import { formatRupees } from "./accounts.ts";
import { MONTHS } from "./dates.ts";

export type Group = "bank_cash" | "deposits" | "stocks" | "funds" | "crypto";

export type NetWorthPoint = {
  date: string;
  net_worth: string;
  total_have: string;
  total_owe: string;
  allocation: Record<Group, string>;
  estimated: boolean; // worked out from transactions, before snapshots began
};

export type Change = { amount: string; from_date: string };
export type NetWorthRange = "3m" | "6m" | "1y" | "all";

export type NetWorthHistory = {
  range: NetWorthRange;
  today: string;
  points: NetWorthPoint[]; // oldest first; the last is today
  since_last_month: Change | null;
  since_start: Change | null;
  tracked_since: string | null;
};

export const RANGES: { value: NetWorthRange; label: string }[] = [
  { value: "3m", label: "3M" },
  { value: "6m", label: "6M" },
  { value: "1y", label: "1Y" },
  { value: "all", label: "All" },
];

// ₹22,000 rather than ₹22,000.00; paise stay when there are any.
export const wholeRupees = (money: string) => formatRupees(money.replace(/\.00$/, ""));

export type Direction = "up" | "down" | "flat";

export function direction(change: Change): Direction {
  if (/^-?0+(\.0+)?$/.test(change.amount)) return "flat";
  return change.amount.startsWith("-") ? "down" : "up";
}

// "▲ ₹22,000 since last month", "▼ ₹1,500 since last month", "No change since last month".
export function changeText(change: Change | null, since = "since last month"): string | null {
  if (change === null) return null;
  const way = direction(change);
  if (way === "flat") return `No change ${since}`;
  return `${way === "up" ? "▲" : "▼"} ${wholeRupees(change.amount.replace(/^-/, ""))} ${since}`;
}

// What a screen reader says instead of the arrow.
export function changeSpoken(change: Change | null, since = "since last month"): string | null {
  if (change === null) return null;
  const way = direction(change);
  if (way === "flat") return `No change ${since}`;
  return `${way === "up" ? "Up" : "Down"} ${wholeRupees(change.amount.replace(/^-/, ""))} ${since}`;
}

// "2026-10-31" -> "Oct 2026"
export function monthYear(iso: string): string {
  const [year, month] = iso.split("-");
  return `${MONTHS[Number(month) - 1].slice(0, 3)} ${year}`;
}

function dayNumber(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export const GAP_DAYS = 45; // a longer gap breaks the line

export type Dot = { x: number; y: number; estimated: boolean };
export type Run = { points: string; estimated: boolean }; // an SVG polyline's points

// Places the points in a width × height box (x by date, y between the lowest and highest values)
// and splits the line into runs: a link touching an estimated point is an estimated run, and a gap
// over GAP_DAYS starts a new one.
export function lineRuns(
  points: NetWorthPoint[],
  width: number,
  height: number,
  pad = 6,
): { dots: Dot[]; runs: Run[] } {
  if (points.length === 0) return { dots: [], runs: [] };
  const values = points.map((p) => Number(p.net_worth));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const first = dayNumber(points[0].date);
  const span = dayNumber(points[points.length - 1].date) - first;
  const innerW = Math.max(width - pad * 2, 1);
  const innerH = Math.max(height - pad * 2, 1);
  const r = (n: number) => Math.round(n * 10) / 10;
  const dots = points.map((p, i) => ({
    x: r(pad + (span > 0 ? ((dayNumber(p.date) - first) / span) * innerW : innerW / 2)),
    y: r(max === min ? height / 2 : pad + (1 - (values[i] - min) / (max - min)) * innerH),
    estimated: p.estimated,
  }));
  const runs: { coords: string[]; estimated: boolean }[] = [];
  let current: { coords: string[]; estimated: boolean } | null = null;
  for (let i = 1; i < points.length; i++) {
    if (dayNumber(points[i].date) - dayNumber(points[i - 1].date) > GAP_DAYS) {
      current = null;
      continue;
    }
    const estimated = points[i - 1].estimated || points[i].estimated;
    if (current === null || current.estimated !== estimated) {
      current = { coords: [`${dots[i - 1].x},${dots[i - 1].y}`], estimated };
      runs.push(current);
    }
    current.coords.push(`${dots[i].x},${dots[i].y}`);
  }
  return { dots, runs: runs.map((run) => ({ points: run.coords.join(" "), estimated: run.estimated })) };
}

export type MonthRow = { key: string; label: string; point: NetWorthPoint; today: boolean };

// The last point of each month, newest first, with today on top.
export function monthRows(points: NetWorthPoint[]): MonthRow[] {
  const byMonth = new Map<string, NetWorthPoint>();
  for (const p of points) byMonth.set(p.date.slice(0, 7), p);
  const last = points[points.length - 1];
  return [...byMonth.entries()]
    .reverse()
    .map(([key, point]) => ({
      key,
      label: point === last ? "Today" : monthYear(point.date),
      point,
      today: point === last,
    }));
}

// The note shown when any point is estimated.
export function estimatedNote(history: NetWorthHistory): string | null {
  if (!history.points.some((p) => p.estimated)) return null;
  const from = history.tracked_since ? ` before ${formatDay(history.tracked_since)}` : "";
  return `History${from} is estimated from your transactions and leaves out stocks, funds and coins.`;
}

function formatDay(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1].slice(0, 3)} ${year}`;
}
