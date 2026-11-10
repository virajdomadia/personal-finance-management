"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { logout } from "@/app/login/actions";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/accounts", label: "Accounts" },
  { href: "/transactions", label: "Transactions" },
  { href: "/investments", label: "Investments" },
  { href: "/recurring", label: "Recurring" },
  { href: "/insurance", label: "Insurance" },
] as const;

// The pathname of a page under a dynamic segment (a stock's page) is only known at request time,
// so the links render unmarked during prerendering and the current one is marked once it streams in.
function CurrentLinks() {
  return <Links pathname={usePathname()} />;
}

function Links({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {LINKS.map(({ href, label }) => {
        const current = pathname !== null && (pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)));
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-sm ${
              current
                ? "bg-zinc-100 font-medium dark:bg-zinc-800"
                : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 flex h-screen w-36 shrink-0 flex-col border-r border-zinc-200 p-3 sm:w-52 dark:border-zinc-800">
      <Suspense fallback={<Links pathname={null} />}>
        <CurrentLinks />
      </Suspense>
      <form action={logout} className="mt-auto">
        <button
          type="submit"
          className="w-full rounded-md px-3 py-2 text-left text-sm text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900"
        >
          Log out
        </button>
      </form>
    </aside>
  );
}
