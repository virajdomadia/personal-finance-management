"use client";

import { Sparkline } from "@/components/net-worth/charts";
import { useNetWorth } from "@/components/net-worth/use-net-worth";
import { lastMonthSpoken, lastMonthText } from "@/lib/net-worth";

// The trend inside the dashboard's net worth tile: the last year as a white line and the change
// since last month. It loads on its own, so a failure just leaves the tile as it was.
export function NetWorthTrend() {
  const { load } = useNetWorth("1y");
  if (load.status !== "ready" || load.data.points.length === 0) return null;
  const { points, since_last_month: change } = load.data;
  return (
    <span className="block">
      {points.length > 1 ? <Sparkline points={points} /> : null}
      <span className="mt-1.5 inline-block rounded-full border-2 border-ink bg-card px-2 py-0.5 text-xs font-extrabold text-ink tabular-nums">
        <span aria-hidden="true">{lastMonthText(change) ?? "Your trend starts today"}</span>
        <span className="sr-only">{lastMonthSpoken(change) ?? "Your trend starts today"}</span>
      </span>
    </span>
  );
}
