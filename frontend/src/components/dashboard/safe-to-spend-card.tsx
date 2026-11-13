"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatRupees } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { type SafeToSpend, breakdown, safeFigure, untilText } from "@/lib/upcoming";
import { FOCUS } from "@/components/ui/chunky";

const SUMMARY = `flex cursor-pointer list-none items-baseline justify-between gap-3 rounded-lg py-1.5 font-extrabold [&::-webkit-details-marker]:hidden ${FOCUS}`;

// How much can be spent before payday (or the month's end) once bills, goal set-asides and the
// rest of this month's budgets are covered. Every figure is the server's; it hides if the call fails.
export function SafeToSpendCard({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<SafeToSpend | null>(null);

  useEffect(() => {
    let current = true;
    apiFetch<SafeToSpend>("/safe-to-spend")
      .then((s) => {
        if (current) setData(s);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [refreshKey]);

  if (data === null) return null;
  const figure = safeFigure(data.amount);
  const lines = breakdown(data);

  return (
    <section
      aria-labelledby="safe-to-spend-title"
      className={`min-w-0 rounded-[18px] border-[2.5px] border-ink p-3.5 shadow-chunky ${figure.short ? "bg-pink/15" : "bg-card"}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="safe-to-spend-title" className="text-xs font-extrabold">
          <span aria-hidden="true">🛟 </span>Safe to spend
        </h2>
        <Link href="/budgets" className={`rounded text-xs font-black underline ${FOCUS}`}>
          Budgets
        </Link>
      </div>
      <p
        className={`text-[clamp(1.5rem,3vw,2.25rem)] leading-tight font-black tracking-tight tabular-nums ${figure.short ? "text-loss" : ""}`}
      >
        {figure.text}
      </p>
      <p className="text-xs font-extrabold text-zinc-600">
        {untilText(data)}, after bills, goal set-asides and what&apos;s left of this month&apos;s budgets.
      </p>
      {data.note && <p className="mt-1 text-xs font-black text-loss">{data.note}</p>}

      <details className="group mt-2.5 border-t-[1.5px] border-dashed border-zinc-300 pt-1.5">
        <summary className={`${SUMMARY} text-xs`}>
          <span>
            <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open:rotate-90">
              ›
            </span>
            How this is worked out
          </span>
        </summary>
        <ul className="mt-1 text-sm">
          {lines.map((line) => (
            <li key={line.key} className="border-b-[1.5px] border-zinc-200 last:border-b-0">
              <details className="group/line">
                <summary className={SUMMARY}>
                  <span className="min-w-0">
                    <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open/line:rotate-90">
                      ›
                    </span>
                    {line.sign ? <span aria-hidden="true">{line.sign} </span> : null}
                    {line.label}
                    {line.sign ? <span className="sr-only"> (taken away)</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatRupees(line.amount)}</span>
                </summary>
                {line.items.length === 0 ? (
                  <p className="pb-2 pl-5 text-xs font-bold text-zinc-600">{line.empty}</p>
                ) : (
                  <ul className="pb-2 pl-5">
                    {line.items.map((item) => (
                      <li key={item.key} className="flex items-baseline justify-between gap-3 py-0.5 text-xs font-bold">
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {item.label}
                          {item.note ? <span className="block text-[11px] text-zinc-600">{item.note}</span> : null}
                        </span>
                        <span className="shrink-0 tabular-nums">{formatRupees(item.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 border-t-[2.5px] border-ink py-1.5 font-black">
            <span>= Safe to spend</span>
            <span className={`tabular-nums ${figure.short ? "text-loss" : ""}`}>{figure.text}</span>
          </li>
        </ul>
      </details>
    </section>
  );
}
