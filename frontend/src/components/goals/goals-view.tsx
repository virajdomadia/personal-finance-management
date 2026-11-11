"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { ConfirmDelete, LIST, Notice, PRIMARY, QUIET, ROW_ACTION, SECTION_TITLE, isUnauthorized } from "@/components/investments/shared";
import { type Goal, type GoalList, efText, paceText, progressText } from "@/lib/goals";

import { GoalDialog } from "./goal-dialog";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; active: Goal[]; archived: Goal[] };
type Dialog = { kind: "none" } | { kind: "form" } | { kind: "delete"; goal: Goal };

// Saved against the target. The bar stops at full; the text beside it says when a goal is past 100%.
export function ProgressBar({
  percent,
  reached,
  label,
  className = "",
}: {
  percent: number | null;
  reached: boolean;
  label: string;
  className?: string;
}) {
  const value = percent ?? 0;
  const width = Math.max(0, Math.min(value, 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={width}
      aria-valuetext={reached ? `${value}%, reached` : `${value}%`}
      className={`h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 ${className}`}
    >
      <div
        className={`h-full rounded-full ${reached ? "bg-green-600 dark:bg-green-500" : "bg-zinc-900 dark:bg-zinc-100"}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export function EmergencyBadge() {
  return (
    <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs font-medium whitespace-nowrap dark:border-zinc-700">
      Emergency fund
    </span>
  );
}

// Warnings from the server, such as more being set aside than an account holds.
export function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {warnings.map((w) => (
        <p
          key={w}
          role="note"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 [overflow-wrap:anywhere] dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <span className="font-medium">Heads up. </span>
          {w}
        </p>
      ))}
    </div>
  );
}

export function GoalsView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const latest = useRef(0);
  const busy = useRef(false);

  const fetchGoals = useCallback(() => {
    const request = ++latest.current;
    Promise.all([apiFetch<GoalList>("/goals"), apiFetch<GoalList>("/goals?archived=true")])
      .then(([active, archived]) => {
        if (request === latest.current) setLoad({ status: "ready", active: active.goals, archived: archived.goals });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, []);

  useEffect(() => {
    fetchGoals();
  }, [fetchGoals]);

  const closeDialog = () => setDialog({ kind: "none" });
  const done = (message: string | null) => {
    setNotice(message);
    closeDialog();
    fetchGoals();
  };

  async function restore(goal: Goal) {
    if (busy.current) return;
    busy.current = true;
    setRestoring(goal.id);
    setNotice(null);
    try {
      await apiFetch(`/goals/${goal.id}/restore`, { method: "POST" });
    } catch (err) {
      if (isUnauthorized(err)) return void logout();
      setNotice(errorMessage(err));
    } finally {
      busy.current = false;
      setRestoring(null);
    }
    fetchGoals();
  }

  const hasEmergency = load.status === "ready" && load.active.some((g) => g.kind === "emergency");

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">Goals</h1>
        <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form" })}>
          Add goal
        </button>
      </div>

      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading your goals...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load your goals.</p>
          <button
            type="button"
            className={`${QUIET} mt-2 -ml-3`}
            onClick={() => {
              setLoad({ status: "loading" });
              fetchGoals();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" && (
        <div className="flex flex-col gap-8">
          {load.active.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
              <p className="font-medium">No goals yet</p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Start an emergency fund or save toward something. A goal labels money you already have: set some aside in a bank account,
                or put a fund, stock, coin, PPF or RD in its basket. Nothing moves.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {load.active.map((goal) => (
                <GoalCard key={goal.id} goal={goal} />
              ))}
            </div>
          )}

          {load.archived.length > 0 && (
            <section aria-labelledby="archived-goals-title">
              <h2 id="archived-goals-title" className={SECTION_TITLE}>
                Archived
              </h2>
              <ul className={LIST}>
                {load.archived.map((goal) => (
                  <li key={goal.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-40 flex-1">
                      <p className="text-sm font-medium [overflow-wrap:anywhere]">
                        <Link href={`/goals/${goal.id}`} className="hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none">
                          {goal.name}
                        </Link>
                      </p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{progressText(goal)}</p>
                    </div>
                    <div className="flex shrink-0 justify-end gap-1">
                      <button
                        type="button"
                        className={ROW_ACTION}
                        aria-label={`Restore ${goal.name}`}
                        disabled={restoring === goal.id}
                        onClick={() => restore(goal)}
                      >
                        {restoring === goal.id ? "Restoring..." : "Restore"}
                      </button>
                      <button type="button" className={ROW_ACTION} aria-label={`Delete ${goal.name}`} onClick={() => setDialog({ kind: "delete", goal })}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {dialog.kind === "form" && (
        <GoalDialog goal={null} hasEmergency={hasEmergency} onClose={closeDialog} onSaved={() => done(null)} onConflict={done} />
      )}

      {dialog.kind === "delete" && (
        <ConfirmDelete
          title={`Delete ${dialog.goal.name}?`}
          body="The goal and its basket are removed for good. A goal with set-aside history can't be deleted; it stays archived."
          path={`/goals/${dialog.goal.id}`}
          onClose={closeDialog}
          onDone={done}
        />
      )}
    </div>
  );
}

function GoalCard({ goal }: { goal: Goal }) {
  const pace = paceText(goal);
  return (
    <section aria-label={goal.name} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold [overflow-wrap:anywhere]">
            <Link href={`/goals/${goal.id}`} className="rounded hover:underline focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none">
              {goal.name}
            </Link>
            {goal.kind === "emergency" && <EmergencyBadge />}
          </h2>
          <p className="text-sm tabular-nums">{progressText(goal)}</p>
        </div>
        {goal.target !== null && <ProgressBar percent={goal.percent} reached={goal.reached} label={`${goal.name} progress`} />}
        {(goal.kind === "emergency" || pace) && (
          <div className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
            {goal.kind === "emergency" && <p>{efText(goal)}</p>}
            {pace && <p className={goal.overdue ? "text-amber-800 dark:text-amber-300" : ""}>{pace}</p>}
          </div>
        )}
        <Warnings warnings={goal.warnings} />
      </div>
    </section>
  );
}
