"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useId, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { useProfile } from "@/components/family/profile";
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
  { href: "/calendar", emoji: "📅", label: "Spending calendar" },
  { href: "/reminders", emoji: "🔁", label: "Reminders" },
  { href: "/budgets", emoji: "📊", label: "Budgets" },
  { href: "/investments", emoji: "📈", label: "Investments" },
  { href: "/family", emoji: "👨‍👩‍👧", label: "Family" },
  { href: "/insurance", emoji: "🛡️", label: "Insurance" },
  { href: "/goals", emoji: "🎯", label: "Goals" },
] as const;

// The pathname of a page under a dynamic segment (a stock's page) is only known at request time,
// so the links render unmarked during prerendering and the current one is marked once it streams in.
function CurrentLinks() {
  return <Links pathname={usePathname()} />;
}

// How many SMS messages wait in To review. It reloads on navigation and after each answer; a failed
// call just hides the count. SMS are always the owner's, and To review only works on the owner's
// profile, so while a family member is viewed there is no count: it would point at a page that
// can't act on it.
function useReviewCount(pathname: string | null, enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
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
  }, [pathname, enabled]);
  return enabled ? count : 0;
}

function Links({ pathname }: { pathname: string | null }) {
  const { ready, viewingMember } = useProfile();
  const reviewCount = useReviewCount(pathname, ready && !viewingMember);
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

// Your data sits by Log out: an account matter, not a daily page.
function CurrentDataLink() {
  return <DataLink current={usePathname() === "/data"} />;
}

function DataLink({ current }: { current: boolean }) {
  return (
    <Link
      href="/data"
      aria-current={current ? "page" : undefined}
      className={`flex items-center gap-2 rounded-xl border-[2.5px] px-2.5 py-2 text-sm font-extrabold ${
        current ? "border-ink bg-yellow shadow-chunky-sm" : "border-transparent hover:bg-due"
      } ${FOCUS}`}
    >
      <span aria-hidden="true">💾</span>
      Your data
    </Link>
  );
}

// "Viewing: Me ▾": whose profile every page shows and adds to. Choosing someone reloads the app for them.
function ProfileSwitcher() {
  const { ready, viewingMember, member, family, familyStatus, switchTo } = useProfile();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  // Focus moved somewhere else on the page (tabbing away). A click that doesn't move focus (Safari
  // doesn't focus buttons) has no target here, and outside clicks are caught on pointerdown instead.
  const leftBox = (next: EventTarget | null) => next instanceof Node && !box.current?.contains(next);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = !ready ? "…" : viewingMember ? (member?.name ?? "…") : "Me";
  const people = family ? [family.me, ...family.members] : [];
  const chosenId = viewingMember ? member?.id : family?.me.id;
  const ITEM = `flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-extrabold hover:bg-due ${FOCUS}`;

  return (
    <div ref={box} className="relative mb-3">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        onBlur={(e) => {
          if (leftBox(e.relatedTarget)) setOpen(false);
        }}
        className={`flex w-full items-center gap-1 rounded-xl border-[2.5px] border-ink px-2.5 py-2 text-left text-sm font-extrabold shadow-chunky-sm ${
          viewingMember ? "bg-purple-strong text-white" : "bg-card hover:bg-due"
        } ${FOCUS}`}
      >
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="block text-[11px] font-black tracking-wider uppercase opacity-80">Viewing</span>
          {name}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          id={menuId}
          className="absolute inset-x-0 top-full z-40 mt-1.5 rounded-xl border-[2.5px] border-ink bg-card p-1.5 shadow-chunky"
          onBlur={(e) => {
            if (leftBox(e.relatedTarget)) setOpen(false);
          }}
        >
          {people.length > 0 ? (
            <ul aria-label="Profiles">
              {people.map((p) => {
                const chosen = p.id === chosenId;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-current={chosen ? "true" : undefined}
                      className={`${ITEM} ${chosen ? "bg-yellow" : ""}`}
                      onClick={() => {
                        setOpen(false);
                        if (!chosen) switchTo(p.id === family?.me.id ? null : p.id);
                      }}
                    >
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{p.name}</span>
                      {chosen ? <span aria-hidden="true">✓</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p role="status" className="px-2 py-1.5 text-xs font-bold text-zinc-600">
              {familyStatus === "loading" ? "Loading..." : "Couldn't load your family."}
            </p>
          )}
          <Link
            href="/family/manage"
            onClick={() => setOpen(false)}
            className={`${ITEM} mt-1 border-t-[1.5px] border-zinc-200 pt-2`}
          >
            <span aria-hidden="true">⚙️</span>
            Manage family
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 flex h-screen w-36 shrink-0 flex-col gap-1 overflow-y-auto border-r-[2.5px] border-ink bg-card p-3 sm:w-52">
      <div className="mx-1 mb-3 flex items-center gap-2 text-lg font-black">
        <Logo size={32} decorative />
        Gullak
      </div>
      <ProfileSwitcher />
      <Suspense fallback={<Links pathname={null} />}>
        <CurrentLinks />
      </Suspense>
      <div className="mt-auto pt-3">
        <Suspense fallback={null}>
          <StreakNote />
        </Suspense>
        <Suspense fallback={<DataLink current={false} />}>
          <CurrentDataLink />
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
