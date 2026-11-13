"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";

type Streak = { days: number; logged_today: boolean };

// The logging streak, kept as one quiet line in the sidebar footer: the weekly digest on the
// dashboard is the reason to come back now. It hides itself when there is no streak or the call
// fails, and reloads on navigation so it catches a new transaction.
export function StreakNote() {
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

  if (!streak || streak.days < 1) return null;
  return (
    <p className="mx-2.5 mb-1 text-[11px] font-bold text-zinc-600">
      <span aria-hidden="true">🔥 </span>
      {streak.days}-day logging streak
    </p>
  );
}
