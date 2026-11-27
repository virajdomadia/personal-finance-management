"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { logout } from "@/app/login/actions";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CalendarDay,
  type SpendCalendar,
  calendarPath,
  calendarWeeks,
  dayTone,
  dayTransactionsHref,
  netText,
  netWords,
  shortDate,
} from "@/lib/cash-flow";
import { formatMonth } from "@/lib/transactions";
import { FOCUS, PageHeader, buttonClass } from "@/components/ui/chunky";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: SpendCalendar };

const CARD = "min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky";
const MONTH_BUTTON = `${buttonClass("alt")} !rounded-full !px-3 !py-1.5 !text-xs !font-extrabold !shadow-chunky-sm`;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TONE = {
  spent: "bg-card border-ink text-ink",
  gained: "bg-gain/10 border-gain text-gain",
  none: "bg-card border-zinc-300 text-zinc-500",
  future: "bg-zinc-100 border-zinc-300 text-zinc-500",
} as const;

// The spending calendar: one figure a day, what was spent less what came in.
export function SpendCalendarView({ month }: { month: string | null }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let current = true;
    apiFetch<SpendCalendar>(calendarPath(month))
      .then((data) => {
        if (current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (current) setLoad({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [month]);

  const title = load.status === "ready" ? formatMonth(load.data.month) : month ? formatMonth(month) : "This month";
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`Spending calendar · ${title}`}
        action={load.status === "ready" ? <MonthNav data={load.data} /> : null}
      />
      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading the month...
        </p>
      )}
      {load.status === "error" && (
        <p role="alert" className={`${CARD} font-extrabold`}>
          We couldn&apos;t load this month. Reload the page to try again.
        </p>
      )}
      {load.status === "ready" && <MonthGrid data={load.data} />}
    </div>
  );
}

function MonthNav({ data }: { data: SpendCalendar }) {
  const link = (target: string | null, label: string, text: string) =>
    target === null ? (
      <span className={`${MONTH_BUTTON} opacity-40`} aria-disabled="true" aria-label={label}>
        {text}
      </span>
    ) : (
      <Link href={calendarPath(target)} className={MONTH_BUTTON} aria-label={label}>
        {text}
      </Link>
    );
  return (
    <div className="flex items-center gap-2">
      {link(data.previous_month, "Previous month", "‹")}
      {link(data.next_month, "Next month", "›")}
    </div>
  );
}

function MonthGrid({ data }: { data: SpendCalendar }) {
  return (
    <section aria-labelledby="grid-title" className={CARD}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="grid-title" className="text-xs font-extrabold">
          <span aria-hidden="true">🗓️ </span>Spent each day (₹)
        </h2>
        <p className="text-xs font-bold text-zinc-600">
          <span className="text-gain">+ green</span>: more came in than went out
        </p>
      </div>
      <table className="w-full table-fixed border-separate border-spacing-1">
        <thead>
          <tr>
            {WEEKDAYS.map((d) => (
              <th key={d} scope="col" className="text-[11px] font-black text-zinc-600 uppercase">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {calendarWeeks(data.days).map((week, i) => (
            <tr key={i}>
              {week.map((day, j) => (
                <td key={j} className="p-0 align-top">
                  {day === null ? null : <DayCell day={day} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs font-bold text-zinc-600">
        Each day is what you spent less what came in (income and refunds). Moving money between your own accounts
        doesn&apos;t count. Pick a day to see its transactions.
      </p>
    </section>
  );
}

function DayCell({ day }: { day: CalendarDay }) {
  const tone = dayTone(day);
  const box = `flex h-16 flex-col justify-between rounded-[10px] border-2 px-0.5 py-1 sm:h-20 sm:p-1.5 ${TONE[tone]}`;
  const number = <span className="text-xs font-black">{Number(day.date.slice(8))}</span>;
  if (day.net === null) {
    return (
      <div className={box} aria-label={`${shortDate(day.date)}, still to come`}>
        {number}
      </div>
    );
  }
  const text = netText(day.net);
  return (
    <Link
      href={dayTransactionsHref(day.date)}
      className={`${box} hover:-translate-y-0.5 ${FOCUS}`}
      aria-label={`${shortDate(day.date)}, ${netWords(day.net)}`}
    >
      {number}
      {/* A phone's cell is too narrow for the ₹; the header says these are rupees. */}
      <span className="text-right text-[10px] leading-none font-black tracking-tight tabular-nums sm:hidden" aria-hidden="true">
        {text.replace("₹", "")}
      </span>
      <span className="hidden truncate text-right text-sm font-black tabular-nums sm:block" aria-hidden="true">
        {text}
      </span>
    </Link>
  );
}
