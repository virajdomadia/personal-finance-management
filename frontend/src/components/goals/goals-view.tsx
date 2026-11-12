"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { ConfirmDelete, LIST, Notice, PRIMARY, QUIET, ROW_ACTION, SECTION_TITLE, isUnauthorized } from "@/components/investments/shared";
import { type Goal, type GoalList, efText, paceText, progressText } from "@/lib/goals";
import { whole } from "@/lib/recurring";
import { FOCUS, PageHeader, Ring, Sticker } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";

import { GoalDialog } from "./goal-dialog";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; active: Goal[]; archived: Goal[] };
type Dialog = { kind: "none" } | { kind: "form" } | { kind: "delete"; goal: Goal };

export function EmergencyBadge() {
  return (
    <span className="rounded-full border-2 border-ink bg-yellow px-2 py-0.5 text-xs font-black whitespace-nowrap text-ink">
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
          className="rounded-[14px] border-[2.5px] border-ink bg-due px-3 py-2 text-sm font-bold text-ink shadow-chunky-sm [overflow-wrap:anywhere]"
        >
          <span className="font-black">Heads up. </span>
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
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Goals"
        action={
          <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form" })}>
            + Add goal
          </button>
        }
      />

      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your goals...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <p>We couldn&apos;t load your goals.</p>
          <button
            type="button"
            className={`${QUIET} mt-2`}
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
        <div className="flex flex-col gap-10">
          {load.active.length === 0 ? (
            <EmptyState
              emoji="🎯"
              title="No goals yet"
              action={
                <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form" })}>
                  + Add goal
                </button>
              }
            >
              Save for an emergency fund, a trip or a bike, and watch how close you are. A goal only labels money you already have:
              nothing moves.
            </EmptyState>
          ) : (
            <ul className="grid grid-cols-1 items-start gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {load.active.map((goal, i) => (
                <li key={goal.id} className="min-w-0">
                  <GoalCard goal={goal} tone={TONES[i % TONES.length]} />
                </li>
              ))}
            </ul>
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
                      <p className="text-sm font-extrabold [overflow-wrap:anywhere]">
                        <Link href={`/goals/${goal.id}`} className={`rounded hover:underline ${FOCUS}`}>
                          {goal.name}
                        </Link>
                      </p>
                      <p className="text-xs font-bold text-zinc-600 tabular-nums">{progressText(goal)}</p>
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

const TONES = ["purple", "blue", "green", "orange"] as const;
const TILE: Record<(typeof TONES)[number] | "yellow", string> = {
  purple: "bg-purple-strong text-white",
  blue: "bg-blue-strong text-white",
  green: "bg-green-strong text-white",
  orange: "bg-orange-strong text-white",
  yellow: "bg-yellow text-ink",
};

export const goalEmoji = (goal: Pick<Goal, "kind">) => (goal.kind === "emergency" ? "🛟" : "🎯");

function GoalCard({ goal, tone }: { goal: Goal; tone: (typeof TONES)[number] }) {
  const pace = paceText(goal);
  const amounts = goal.target === null ? `${whole(goal.saved)} saved` : `${whole(goal.saved)} of ${whole(goal.target)}`;
  return (
    <div className="flex flex-col gap-3">
      <section
        aria-label={goal.name}
        className={`relative flex flex-col items-center gap-2.5 rounded-[18px] border-[2.5px] border-ink px-3.5 pt-5 pb-4 text-center shadow-chunky ${goal.reached ? TILE.yellow : TILE[tone]}`}
      >
        {goal.reached && <Sticker text="DONE!" />}
        <Ring percent={goal.percent} reached={goal.reached} label={`${goal.name} progress`} size={96} />
        <h2 className="max-w-full text-lg leading-tight font-black [overflow-wrap:anywhere]">
          <Link
            href={`/goals/${goal.id}`}
            className="rounded-[18px] outline-none after:absolute after:inset-0 after:rounded-[18px] hover:underline focus-visible:after:ring-[3px] focus-visible:after:ring-ink focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-bg"
          >
            <span aria-hidden="true">{goalEmoji(goal)} </span>
            {goal.name}
          </Link>
        </h2>
        <p className="text-sm font-extrabold tabular-nums [overflow-wrap:anywhere]">
          {amounts}
          {goal.reached ? " · Reached" : ""}
        </p>
        {goal.kind === "emergency" && (
          <div className="flex flex-col items-center gap-1 text-xs font-bold [overflow-wrap:anywhere]">
            <EmergencyBadge />
            <p>{efText(goal)}</p>
          </div>
        )}
        {pace && (
          <p
            className={`text-xs font-bold [overflow-wrap:anywhere] ${goal.overdue ? "rounded-full border-2 border-ink bg-due px-2.5 py-0.5 font-black text-ink" : ""}`}
          >
            {pace}
          </p>
        )}
      </section>
      <Warnings warnings={goal.warnings} />
    </div>
  );
}
