"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Dashboard, formatDueDate, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: Dashboard };

const FOCUS = "focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none";
const CARD = `block min-w-0 rounded-lg border border-zinc-200 px-4 py-3 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900 ${FOCUS}`;
const LABEL = "text-sm text-zinc-600 dark:text-zinc-400";
const AMOUNT = "mt-1 text-2xl font-semibold tabular-nums [overflow-wrap:anywhere]";

export function DashboardView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const latest = useRef(0);

  const fetchDashboard = useCallback(() => {
    const request = ++latest.current;
    apiFetch<Dashboard>("/dashboard")
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  return (
    <div className="mx-auto max-w-3xl">
      {load.status === "loading" && (
        <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading your dashboard...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load your dashboard.</p>
          <button
            type="button"
            className={`mt-2 -ml-1 rounded-md px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 ${FOCUS}`}
            onClick={() => {
              setLoad({ status: "loading" });
              fetchDashboard();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" && <Content data={load.data} />}
    </div>
  );
}

function Content({ data }: { data: Dashboard }) {
  const due = data.next_card_due;
  const used = data.credit_used;

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="net-worth-label" className="rounded-lg border border-zinc-200 px-5 py-6 dark:border-zinc-800">
        <p id="net-worth-label" className={LABEL}>
          Net worth
        </p>
        <p className="mt-1 text-lg font-semibold tabular-nums [overflow-wrap:anywhere] min-[480px]:text-3xl sm:text-5xl">
          {formatRupees(data.net_worth)}
        </p>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Investments and loans not included yet</p>
        {!data.has_accounts && (
          <Link
            href="/accounts"
            className={`mt-4 inline-block rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 ${FOCUS}`}
          >
            Add your first account
          </Link>
        )}
      </section>

      {data.has_accounts && (
        <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <Link href="/accounts" className={CARD}>
            <p className={LABEL}>You have</p>
            <p className={AMOUNT}>{formatRupees(data.total_have)}</p>
          </Link>
          <span aria-hidden="true" className="self-center text-center text-xl text-zinc-400">
            &minus;
          </span>
          <Link href="/accounts" className={CARD}>
            <p className={LABEL}>You owe</p>
            <p className={AMOUNT}>{formatRupees(data.total_owe)}</p>
          </Link>
        </div>
      )}

      {(due || used) && (
        <section aria-labelledby="attention-title">
          <h2 id="attention-title" className="mb-1 px-1 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            Needs attention
          </h2>
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {due && (
              <li>
                <Link href="/accounts" className={`block px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 [overflow-wrap:anywhere] ${FOCUS}`}>
                  {due.name} due {formatDueDate(due.due_date)}
                </Link>
              </li>
            )}
            {used && (
              <li>
                <Link href="/accounts" className={`block px-4 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 ${FOCUS}`}>
                  {used.percent}% of credit limit used
                </Link>
              </li>
            )}
          </ul>
        </section>
      )}
    </div>
  );
}
