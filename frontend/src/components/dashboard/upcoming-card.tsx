"use client";

import { useEffect, useState } from "react";

import { formatDueDate, formatRupees } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { type Upcoming, itemMeta, signedAmountText } from "@/lib/upcoming";
import { FOCUS } from "@/components/ui/chunky";

const SHOWN = 8;
const negative = (amount: string) => amount.startsWith("-");

// Everything due in the next 30 days (and anything overdue) with the bank, cash and wallet balance
// after each item, all from the server. It hides if the call fails.
export function UpcomingCard({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Upcoming | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let current = true;
    apiFetch<Upcoming>("/upcoming")
      .then((u) => {
        if (current) setData(u);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [refreshKey]);

  if (data === null) return null;
  const items = all ? data.items : data.items.slice(0, SHOWN);

  return (
    <section
      aria-labelledby="upcoming-title"
      className="min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="upcoming-title" className="text-xs font-extrabold">
          <span aria-hidden="true">📅 </span>Next 30 days
        </h2>
        <p className="text-xs font-extrabold text-zinc-600">
          Bank, cash and wallet now:{" "}
          <span className={`font-black tabular-nums ${negative(data.starting_balance) ? "text-loss" : "text-ink"}`}>
            {formatRupees(data.starting_balance)}
          </span>
        </p>
      </div>

      {data.items.length === 0 ? (
        <p className="mt-2 text-sm font-bold">Nothing due between today and {formatDueDate(data.through)}.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Due by {formatDueDate(data.through)}, with the balance after each</caption>
            <thead>
              <tr className="text-[11px] font-black tracking-wider text-zinc-600 uppercase">
                <th scope="col" className="pb-1 text-left">
                  Date
                </th>
                <th scope="col" className="pb-1 pl-3 text-left">
                  What
                </th>
                <th scope="col" className="pb-1 pl-3 text-right">
                  Amount
                </th>
                <th scope="col" className="pb-1 pl-3 text-right">
                  Balance after
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={`${i}-${item.kind}-${item.ref_id}-${item.date}`}
                  className={item.overdue ? "bg-pink/10" : ""}
                >
                  <td className="border-t-[1.5px] border-zinc-200 py-1.5 align-top font-extrabold whitespace-nowrap tabular-nums">
                    {formatDueDate(item.date)}
                    {item.overdue ? (
                      <span className="mt-0.5 block w-fit rounded-full border-[1.5px] border-ink bg-pink-strong px-1.5 text-[10px] leading-4 font-black text-white uppercase">
                        Overdue
                      </span>
                    ) : null}
                  </td>
                  <td className="border-t-[1.5px] border-zinc-200 py-1.5 pl-3 align-top font-extrabold [overflow-wrap:anywhere]">
                    {item.name}
                    <span className="block text-[11px] font-bold text-zinc-600">{itemMeta(item)}</span>
                  </td>
                  <td
                    className={`border-t-[1.5px] border-zinc-200 py-1.5 pl-3 text-right align-top font-black tabular-nums ${item.direction === "in" ? "text-gain" : item.direction === "none" ? "text-zinc-600" : ""}`}
                  >
                    {signedAmountText(item)}
                    {item.direction === "none" ? (
                      <span className="block text-[11px] font-bold">doesn&apos;t move the balance</span>
                    ) : null}
                  </td>
                  <td
                    className={`border-t-[1.5px] border-zinc-200 py-1.5 pl-3 text-right align-top font-bold whitespace-nowrap tabular-nums ${negative(item.balance_after) ? "text-loss" : ""}`}
                  >
                    {formatRupees(item.balance_after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 border-t-[2.5px] border-ink pt-2">
        {data.items.length > SHOWN ? (
          <button
            type="button"
            aria-expanded={all}
            className={`rounded text-xs font-black underline ${FOCUS}`}
            onClick={() => setAll((v) => !v)}
          >
            {all ? "Show fewer" : `Show all ${data.items.length}`}
          </button>
        ) : (
          <span />
        )}
        <p className="text-xs font-extrabold">
          On {formatDueDate(data.through)}:{" "}
          <span className={`font-black tabular-nums ${negative(data.ending_balance) ? "text-loss" : ""}`}>
            {formatRupees(data.ending_balance)}
          </span>
        </p>
      </div>
    </section>
  );
}
