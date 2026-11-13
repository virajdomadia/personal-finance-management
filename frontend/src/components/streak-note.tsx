"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { streakLabel } from "@/lib/fun";

type Streak = { days: number; logged_today: boolean };

// The owner's logging streak. It hides itself when there is no streak or the call fails: it is a
// nicety, never worth an error message. It reloads on navigation, so it catches a new transaction.
export function StreakBox() {
  const pathname = usePathname();
  const [streak, setStreak] = useState<Streak | null>(null);

  useEffect(() => {
    let current = true;
    apiFetch<Streak>("/streak")
      .then((data) => {
        if (current && Number.isFinite(data.days)) setStreak(data);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [pathname]);

  const label = streak ? streakLabel(streak.days) : null;
  if (!streak || !label) return null;
  return (
    <div className="mb-2 rounded-[14px] border-[2.5px] border-ink bg-orange-strong p-2.5 font-black text-white shadow-chunky-sm">
      <p>
        <span aria-hidden="true">{label.slice(0, 2)}</span>
        {label.slice(2)}
      </p>
      <p className="text-[11px] font-extrabold">
        {streak.days} {streak.days === 1 ? "day" : "days"} in a row
        {streak.logged_today ? "" : ". Log today to keep it going"}
      </p>
    </div>
  );
}
