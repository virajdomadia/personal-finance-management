"use client";

import Link from "next/link";
import { useState } from "react";

import { AllocationChart, AllocationLegend, NetWorthLine } from "@/components/net-worth/charts";
import { useNetWorth } from "@/components/net-worth/use-net-worth";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Segmented, Tile, buttonClass } from "@/components/ui/chunky";
import { formatRupees } from "@/lib/accounts";
import {
  type Change,
  GROUP_LABELS,
  GROUPS,
  type NetWorthHistory,
  type NetWorthRange,
  RANGES,
  changeSpoken,
  changeText,
  direction,
  estimatedNote,
  longDate,
} from "@/lib/net-worth";

const CARD = "min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky";

export function NetWorthView() {
  const [range, setRange] = useState<NetWorthRange>("1y");
  const { load, retry } = useNetWorth(range);
  const switching = load.status === "ready" && load.data.range !== range;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Net worth"
        action={<Segmented options={RANGES} value={range} onChange={setRange} label="How far back" />}
      />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your net worth history...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className={CARD}>
          <p className="text-4xl" aria-hidden="true">
            🙈
          </p>
          <p className="mt-1 font-extrabold">We couldn&apos;t load your net worth history.</p>
          <button type="button" className={`mt-3 ${buttonClass("alt")}`} onClick={retry}>
            TRY AGAIN
          </button>
        </div>
      )}

      {load.status === "ready" && (
        <div aria-busy={switching} className={switching ? "opacity-60 motion-safe:transition-opacity" : ""}>
          <History data={load.data} />
        </div>
      )}
    </div>
  );
}

function ChangeTile({
  label,
  change,
  since,
  showFrom = false,
}: {
  label: string;
  change: Change | null;
  since: string;
  showFrom?: boolean; // name the compared date, when `since` doesn't already
}) {
  const text = changeText(change, since);
  const tone = change === null ? "text-zinc-600" : direction(change) === "down" ? "text-loss" : "text-gain";
  return (
    <Tile label={label}>
      <span className={`mt-1 block text-lg leading-tight font-black tabular-nums ${tone}`}>
        <span aria-hidden="true">{text ?? "Not enough history yet"}</span>
        <span className="sr-only">{changeSpoken(change, since) ?? "Not enough history yet"}</span>
      </span>
      {change && showFrom ? (
        <span className="mt-0.5 block text-xs font-bold text-zinc-600">
          Compared with {longDate(change.from_date)}
        </span>
      ) : null}
    </Tile>
  );
}

function History({ data }: { data: NetWorthHistory }) {
  const points = data.points;
  if (points.length === 0) {
    return (
      <EmptyState
        emoji="📈"
        title="Your trend starts with your first account"
        action={
          <Link href="/accounts" className={buttonClass("primary")}>
            ADD AN ACCOUNT
          </Link>
        }
      >
        Add the accounts you have and owe. A point is saved every night, so the line grows on its own.
      </EmptyState>
    );
  }

  const today = points[points.length - 1];
  const negative = today.net_worth.startsWith("-");
  const note = estimatedNote(data);
  const startLabel = data.since_start ? `since ${longDate(data.since_start.from_date)}` : "since the start";

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <Tile tone={negative ? "pink" : "green"} label="Today" value={formatRupees(today.net_worth)} />
        <ChangeTile label="Since last month" change={data.since_last_month} since="since last month" showFrom />
        <ChangeTile label="Over this range" change={data.since_start} since={startLabel} />
      </div>

      <section aria-labelledby="line-title" className={CARD}>
        <h2 id="line-title" className="mb-2 text-sm font-black">
          <span aria-hidden="true">📈 </span>Net worth
        </h2>
        <NetWorthLine points={points} />
        {points.length < 2 ? (
          <p className="mt-2 text-sm font-bold text-zinc-600">
            Your trend starts today. A new point is saved every night.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="alloc-title" className={CARD}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="alloc-title" className="text-sm font-black">
            <span aria-hidden="true">🧭 </span>Where it is over time
          </h2>
          <AllocationLegend points={points} />
        </div>
        <AllocationChart points={points} />
      </section>

      {note ? (
        <p className="rounded-[14px] border-[2.5px] border-dashed border-ink bg-due px-3.5 py-2.5 text-xs font-extrabold">
          <span aria-hidden="true">✏️ </span>
          {note}
        </p>
      ) : null}

      <table className="sr-only">
        <caption>Net worth by date</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Net worth</th>
            <th scope="col">Have</th>
            <th scope="col">Owe</th>
            {GROUPS.map((g) => (
              <th key={g} scope="col">
                {GROUP_LABELS[g]}
              </th>
            ))}
            <th scope="col">Estimated</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">{longDate(p.date)}</th>
              <td>{formatRupees(p.net_worth)}</td>
              <td>{formatRupees(p.total_have)}</td>
              <td>{formatRupees(p.total_owe)}</td>
              {GROUPS.map((g) => (
                <td key={g}>{formatRupees(p.allocation[g])}</td>
              ))}
              <td>{p.estimated ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
