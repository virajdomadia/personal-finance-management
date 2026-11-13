"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { logout } from "@/app/login/actions";
import { FOCUS } from "@/components/ui/chunky";
import { Logo } from "@/components/ui/logo";
import { StreakNote } from "@/components/streak-note";
import { apiFetch } from "@/lib/api";
import { REVIEW_CHANGED, type ReviewList } from "@/lib/review";

const LINKS = [
  { href: "/", emoji: "🏠", label: "Dashboard" },
  { href: "/net-worth", emoji: "📊", label: "Net worth" },
  { href: "/review", emoji: "📥", label: "To review" },
  { href: "/accounts", emoji: "👛", label: "Accounts" },
  { href: "/transactions", emoji: "💸", label: "Transactions" },
  { href: "/cash-flow", emoji: "🗓️", label: "Cash flow" },
  { href: "/budgets", emoji: "📊", label: "Budgets" },
  { href: "/investments", emoji: "📈", label: "Investments" },
  { href: "/recurring", emoji: "🔁", label: "Recurring" },
  { href: "/insurance", emoji: "🛡️", label: "Insurance" },
  { href: "/goals", emoji: "🎯", label: "Goals" },
] as const;

// The pathname of a page under a dynamic segment (a stock's page) is only known at request time,
// so the links render unmarked during prerendering and the current one is marked once it streams in.
function CurrentLinks() {
  return <Links pathname={usePathname()} />;
}

// How many SMS messages wait in To review. It reloads on navigation and after each answer; a failed
// call just hides the count.
function useReviewCount(pathname: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let current = true;
    const load = () => {
      apiFetch<ReviewList>("/sms/review")
        .then((data) => {
          if (current) setCount(data.items.length);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(REVIEW_CHANGED, load);
    return () => {
      current = false;
      window.removeEventListener(REVIEW_CHANGED, load);
    };
  }, [pathname]);
  return count;
}

function Links({ pathname }: { pathname: string | null }) {
  const reviewCount = useReviewCount(pathname);
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {LINKS.map(({ href, emoji, label }) => {
        const current = pathname !== null && (pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)));
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`flex items-center gap-2 rounded-xl border-[2.5px] px-2.5 py-2 text-sm font-extrabold ${
              current ? "border-ink bg-yellow shadow-chunky-sm" : "border-transparent hover:bg-due"
            } ${FOCUS}`}
          >
            <span aria-hidden="true">{emoji}</span>
            {label}
            {href === "/review" && reviewCount > 0 ? (
              <span className="ml-auto rounded-full border-2 border-ink bg-pink-strong px-1.5 text-[11px] leading-4 font-black text-white tabular-nums">
                {reviewCount}
                <span className="sr-only"> waiting</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 flex h-screen w-36 shrink-0 flex-col gap-1 overflow-y-auto border-r-[2.5px] border-ink bg-card p-3 sm:w-52">
      <div className="mx-1 mb-3 flex items-center gap-2 text-lg font-black">
        <Logo size={32} decorative />
        Gullak
      </div>
      <Suspense fallback={<Links pathname={null} />}>
        <CurrentLinks />
      </Suspense>
      <div className="mt-auto pt-3">
        <Suspense fallback={null}>
          <StreakNote />
        </Suspense>
        <form action={logout}>
          <button
            type="submit"
            className={`flex w-full items-center gap-2 rounded-xl border-[2.5px] border-transparent px-2.5 py-2 text-left text-sm font-extrabold hover:bg-due ${FOCUS}`}
          >
            <span aria-hidden="true">👋</span>
            Log out
          </button>
        </form>
      </div>
    </aside>
  );
}
