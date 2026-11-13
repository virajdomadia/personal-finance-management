"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatRupees } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { type CashFlowMonth, changeText, changeTone } from "@/lib/cash-flow";
import { FALLBACK_COLOUR, iconEmoji } from "@/lib/categories";
import { FOCUS } from "@/components/ui/chunky";

const TONE_CLASS = { good: "text-gain", bad: "text-loss", same: "text-zinc-600" } as const;

// This month so far against last month at the same day, and where the money went. It loads on its
// own and stays out of the way if the request fails.
export function MonthCard() {
  const [data, setData] = useState<CashFlowMonth | null>(null);

  useEffect(() => {
    let current = true;
    apiFetch<CashFlowMonth>("/cash-flow")
      .then((month) => {
        if (current) setData(month);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  if (data === null) return null;
  const spendTone = changeTone(data.spending_change, "spending");
  const earnTone = changeTone(data.income_change, "income");

  return (
    <section
      aria-labelledby="month-card-title"
      className="min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="month-card-title" className="text-xs font-extrabold">
          <span aria-hidden="true">🗓️ </span>This month so far
        </h2>
        <Link href="/cash-flow" className={`rounded text-xs font-black underline ${FOCUS}`}>
          Month report
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[1fr_1fr_1.4fr]">
        <div>
          <p className="text-xs font-extrabold text-zinc-600">Spent</p>
          <p className="text-[22px] leading-tight font-black tabular-nums">{formatRupees(data.spending)}</p>
          <p className={`text-xs font-extrabold ${TONE_CLASS[spendTone]}`}>
            {changeText(data.spending_change, data.previous, false)}
          </p>
        </div>
        <div>
          <p className="text-xs font-extrabold text-zinc-600">Earned</p>
          <p className="text-[22px] leading-tight font-black tabular-nums">{formatRupees(data.income)}</p>
          <p className={`text-xs font-extrabold ${TONE_CLASS[earnTone]}`}>
            {changeText(data.income_change, data.previous, false)}
          </p>
        </div>
        <div>
          <p className="text-xs font-extrabold text-zinc-600">Top categories</p>
          {data.top_spending.length === 0 ? (
            <p className="mt-1 text-sm font-bold">No spending recorded yet this month.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1.5">
              {data.top_spending.map((c) => (
                <li key={c.id ?? c.name}>
                  <div className="flex items-baseline justify-between gap-2 text-sm font-extrabold">
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span aria-hidden="true">{iconEmoji(c.icon)} </span>
                      {c.name}
                    </span>
                    <span className="tabular-nums">{formatRupees(c.amount)}</span>
                  </div>
                  <div className="mt-0.5 h-2 overflow-hidden rounded-full border-[1.5px] border-ink bg-zinc-100" aria-hidden="true">
                    <div
                      className="h-full"
                      style={{ width: `${c.percent}%`, background: c.colour ?? FALLBACK_COLOUR }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
