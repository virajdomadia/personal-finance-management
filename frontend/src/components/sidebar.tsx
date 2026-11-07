"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { logout } from "@/app/login/actions";

const LINKS = [{ href: "/", label: "Dashboard" }] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex h-screen w-36 shrink-0 flex-col border-r border-zinc-200 p-3 sm:w-52 dark:border-zinc-800">
      <nav aria-label="Main" className="flex flex-col gap-1">
        {LINKS.map(({ href, label }) => {
          const current = pathname === href;
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
