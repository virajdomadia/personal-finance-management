"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import type { SpendCalendar } from "@/lib/cash-flow";
import { whole } from "@/lib/recurring";
import { FOCUS } from "@/components/ui/chunky";

// This month's monthly reminders summed up: income − fixed = free, and the daily amount.
export function FreeToSpend({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<SpendCalendar | null>(null);

  useEffect(() => {
    let current = true;
    apiFetch<SpendCalendar>("/calendar")
      .then((d) => {
        if (current) setData(d);
      })
      .catch(() => {}); // only a summary; the page works without it
    return () => {
      current = false;
    };
  }, [refreshKey]);

  if (data === null || data.fixed.length === 0) return null;
  return (
    <p className="mb-4 rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold shadow-chunky-sm">
      <span aria-hidden="true">🧮 </span>
      Every month: {whole(data.income)} in − {whole(data.fixed_out)} fixed = <span className="font-black">{whole(data.free)} free</span>
      {data.per_day !== null ? ` · ${whole(data.per_day)} a day` : ""}.{" "}
      <Link href="/calendar" className={`rounded underline ${FOCUS}`}>
        Spending calendar
      </Link>
    </p>
  );
}
