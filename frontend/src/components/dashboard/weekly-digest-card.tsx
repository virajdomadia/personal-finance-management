"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatDueDate, formatRupees } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { FALLBACK_COLOUR, iconEmoji } from "@/lib/categories";
import {
  type Digest,
  changeLine,
  digestKey,
  dueLine,
  monthHref,
  riskText,
  usualLine,
  weekRange,
} from "@/lib/digest";
import { signedAmountText } from "@/lib/upcoming";
import { FOCUS, ProgressBar, buttonClass } from "@/components/ui/chunky";

const TONE_CLASS = { more: "text-loss", less: "text-gain", same: "text-zinc-600" } as const;
const DUE_SHOWN = 3;

function isHidden(d: Digest): boolean {
  try {
    return window.localStorage.getItem(digestKey(d.user_id, d.week_start)) !== null;
  } catch {
    return false;
  }
}

// "Your week": last week's spending against the usual, budgets at risk and what's due in the next
// 7 days, all worked out by the server. The server's default week turns over on Sunday at 6 pm, so
// the card shows a new week from Sunday evening until it's hidden for that week. A failed call
// hides it: the rest of the dashboard says the same things in more detail.
export function WeeklyDigestCard() {
  const [data, setData] = useState<Digest | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    let current = true;
    apiFetch<Digest>("/digest")
      .then((d) => {
        if (!current) return;
        setData(d);
        setHidden(isHidden(d));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  if (data === null || hidden) return null;

  const hide = () => {
    try {
      window.localStorage.setItem(digestKey(data.user_id, data.week_start), "1");
    } catch {
      // Not remembered on this browser; it still goes away until the page reloads.
    }
    setHidden(true);
  };

  const tone = data.tone ?? "same";
  const change = changeLine(data);
  const risks = data.budgets.at_risk;

  return (
    <section
      aria-labelledby="digest-title"
      className="min-w-0 rounded-[18px] border-[2.5px] border-ink bg-due p-4 shadow-chunky"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="digest-title" className="text-xs font-extrabold">
            <span aria-hidden="true">🗞️ </span>Your week · {weekRange(data.week_start, data.through)}
          </h2>
          <p className="mt-1 text-xl leading-snug font-black">{data.headline}</p>
        </div>
        <button type="button" className={`${buttonClass("alt")} !px-2.5 !py-1 text-xs uppercase`} onClick={hide}>
          Hide for this week
        </button>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="min-w-0">
          <p className="text-xs font-extrabold text-zinc-600">Spent</p>
          <p className="text-[22px] leading-tight font-black tabular-nums">{formatRupees(data.spending)}</p>
          {change ? <p className={`text-xs font-extrabold ${TONE_CLASS[tone]}`}>{change}</p> : null}
          <p className="text-xs font-bold text-zinc-600">{usualLine(data)}</p>
          {data.top_spending.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1" aria-label="Top categories">
              {data.top_spending.map((c) => (
                <li key={c.id ?? c.name} className="flex items-center gap-2 text-sm font-extrabold">
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-[3px] border-2 border-ink"
                    style={{ background: c.colour ?? FALLBACK_COLOUR }}
                  />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span aria-hidden="true">{iconEmoji(c.icon)} </span>
                    {c.name}
                  </span>
                  <span className="tabular-nums">{formatRupees(c.amount)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="min-w-0">
          <p className="text-xs font-extrabold text-zinc-600">Budgets at risk</p>
          {risks.length === 0 ? (
            <p className="mt-1 text-sm font-bold">None. Every budget is on track.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-2">
              {risks.map((r) => (
                <li key={r.category_id}>
                  <Link href="/budgets" className={`block rounded ${FOCUS}`}>
                    <span className="flex items-baseline justify-between gap-2 text-sm font-extrabold">
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <span aria-hidden="true">{iconEmoji(r.icon)} </span>
                        {r.name}
                      </span>
                      <span className="tabular-nums">{r.percent ?? 0}%</span>
                    </span>
                    <ProgressBar
                      percent={r.bar}
                      reached={false}
                      warn={r.status === "over"}
                      label={`${r.name} budget used`}
                      className="mt-0.5 !h-3"
                    />
                    <span className={`text-xs font-extrabold ${r.status === "over" ? "text-loss" : "text-orange-strong"}`}>
                      {riskText(r)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="min-w-0">
          <p className="text-xs font-extrabold text-zinc-600">Coming up</p>
          <p className="mt-1 text-sm font-bold">{dueLine(data)}</p>
          {data.due.items.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1">
              {data.due.items.slice(0, DUE_SHOWN).map((item, i) => (
                <li
                  key={`${i}-${item.kind}-${item.ref_id}-${item.date}`}
                  className="flex items-baseline justify-between gap-2 text-sm font-extrabold"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="tabular-nums">{formatDueDate(item.date)}</span> · {item.name}
                    {item.overdue ? <span className="text-loss"> (overdue)</span> : null}
                  </span>
                  <span className="tabular-nums">{signedAmountText(item)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t-[2.5px] border-ink pt-2">
        <Link href={monthHref(data)} className={`rounded text-xs font-black underline ${FOCUS}`}>
          Month report
        </Link>
        <Link href="/budgets" className={`rounded text-xs font-black underline ${FOCUS}`}>
          Budgets
        </Link>
      </div>
    </section>
  );
}
