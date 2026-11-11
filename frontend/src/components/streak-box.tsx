"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";

// The owner's logging streak. It hides itself when there is no streak or the call fails: it is a
// nicety, never worth an error message.
export function StreakBox() {
  const [days, setDays] = useState(0);

  useEffect(() => {
    let current = true;
    apiFetch<{ days: number }>("/streak")
      .then((data) => {
        if (current && Number.isFinite(data.days)) setDays(data.days);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  if (!(days > 0)) return null;
  return (
    <div className="mb-2 rounded-[14px] border-[2.5px] border-ink bg-orange-strong p-2.5 font-black text-white shadow-chunky-sm">
      <p>
        <span aria-hidden="true">🔥 </span>
        {days} {days === 1 ? "day" : "days"}
      </p>
      <p className="text-[11px] font-extrabold">Log today to keep it going</p>
    </div>
  );
}
