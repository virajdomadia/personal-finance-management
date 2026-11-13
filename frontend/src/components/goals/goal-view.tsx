"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage, formatFullDate } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  ConfirmDelete,
  DIALOG,
  LIST,
  Notice,
  PRIMARY,
  QUIET,
  ROW_ACTION,
  SECONDARY,
  SECTION_TITLE,
  isUnauthorized,
} from "@/components/investments/shared";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import {
  type EarmarkAction,
  type GoalDetail,
  type HistoryLine,
  type HoldingLine,
  efText,
  holdingName,
  paceText,
  progressText,
} from "@/lib/goals";
import { whole } from "@/lib/recurring";
import { expenseFormFromRelease, todayIndia } from "@/lib/transactions";

import { EarmarkDialog } from "./earmark-dialog";
import { GoalDialog } from "./goal-dialog";
import { EmojiSquare, Ring, buttonClass } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";
import { EmergencyBadge, Warnings, goalEmoji } from "./goals-view";
import { HoldingDialog } from "./holding-dialog";

type Load = { status: "loading" } | { status: "error" } | { status: "missing" } | { status: "ready"; goal: GoalDetail };
type Dialog =
  | { kind: "none" }
  | { kind: "edit" }
  | { kind: "earmark"; action: EarmarkAction }
  | { kind: "expense"; release: HistoryLine; accounts: Account[] }
  | { kind: "holding" }
  | { kind: "remove-holding"; holding: HoldingLine }
  | { kind: "delete-entry"; entry: HistoryLine }
  | { kind: "archive" }
  | { kind: "delete" };

const HOLDING_EMOJI: Record<HoldingLine["kind"], string> = { stock: "📈", mutual_fund: "🥧", crypto: "🪙", ppf: "🏛️", rd: "🏦" };

const HOLDING_KIND: Record<HoldingLine["kind"], string> = {
  stock: "Stock",
  mutual_fund: "Fund",
  crypto: "Coin",
  ppf: "PPF",
  rd: "RD",
};

// A history line's amount is negative for a release.
const released = (entry: HistoryLine) => entry.amount.startsWith("-");
const entryTitle = (entry: HistoryLine) =>
  released(entry) ? `Released ${whole(entry.amount.slice(1))}` : `Set aside ${whole(entry.amount)}`;

export function GoalView({ goalId }: { goalId: number }) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const latest = useRef(0);
  const busy = useRef(false);

  const fetchGoal = useCallback(() => {
    const request = ++latest.current;
    apiFetch<GoalDetail>(`/goals/${goalId}`)
      .then((goal) => {
        if (request === latest.current) setLoad({ status: "ready", goal });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request !== latest.current) return;
        else if (err instanceof ApiError && err.status === 404) setLoad({ status: "missing" });
        else setLoad({ status: "error" });
      });
  }, [goalId]);

  useEffect(() => {
    fetchGoal();
  }, [fetchGoal]);

  const closeDialog = () => setDialog({ kind: "none" });
  const done = (message: string | null) => {
    setNotice(message);
    closeDialog();
    fetchGoal();
  };

  // "Release and record an expense": the release is saved; now the ordinary expense form, pre-filled.
  async function recordExpense(release: HistoryLine) {
    closeDialog();
    setNotice(null);
    fetchGoal();
    try {
      const list = await apiFetch<AccountList>("/accounts");
      setDialog({ kind: "expense", release, accounts: list.accounts });
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else setNotice("The money is released, but we couldn't open the expense form. Add the expense on the Transactions page.");
    }
  }

  async function restore(goal: GoalDetail) {
    if (busy.current) return;
    busy.current = true;
    setRestoring(true);
    setNotice(null);
    try {
      await apiFetch(`/goals/${goal.id}/restore`, { method: "POST" });
    } catch (err) {
      if (isUnauthorized(err)) return void logout();
      setNotice(errorMessage(err));
    } finally {
      busy.current = false;
      setRestoring(false);
    }
    fetchGoal();
  }

  const goal = load.status === "ready" ? load.goal : null;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/goals" className={`${buttonClass("alt")} mb-4 !px-3 !py-1.5 uppercase`}>
        ‹ Goals
      </Link>

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading the goal...
        </p>
      )}

      {load.status === "missing" && (
        <div className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-6 py-12 text-center">
          <p className="font-black">Goal not found</p>
          <p className="mt-1 text-sm font-bold text-zinc-600">It may have been deleted.</p>
        </div>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <p>We couldn&apos;t load this goal.</p>
          <button
            type="button"
            className={`${QUIET} mt-2`}
            onClick={() => {
              setLoad({ status: "loading" });
              fetchGoal();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {goal && (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              {/* The badges sit beside the heading, not in it, so its name is just the goal's. */}
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-black [overflow-wrap:anywhere]">
                  <span aria-hidden="true">{goalEmoji(goal)} </span>
                  {goal.name}
                </h1>
                {goal.kind === "emergency" && <EmergencyBadge />}
                {goal.archived && (
                  <span className="rounded-full border-2 border-ink bg-card px-2 py-0.5 text-xs font-black">Archived</span>
                )}
              </div>
              <p className="text-sm font-bold text-zinc-600 tabular-nums">{progressText(goal)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {goal.archived ? (
                <button type="button" className={QUIET} disabled={restoring} onClick={() => restore(goal)}>
                  {restoring ? "Restoring..." : "Restore"}
                </button>
              ) : (
                <>
                  <button type="button" className={QUIET} onClick={() => setDialog({ kind: "edit" })}>
                    Edit
                  </button>
                  <button type="button" className={QUIET} onClick={() => setDialog({ kind: "archive" })}>
                    Archive
                  </button>
                </>
              )}
              {goal.history.length === 0 && (
                <button type="button" className={QUIET} onClick={() => setDialog({ kind: "delete" })}>
                  Delete
                </button>
              )}
            </div>
          </div>

          <Notice message={notice} />

          <div className="flex flex-col gap-8">
            <Summary goal={goal} />

            {goal.archived ? (
              <p className="text-sm font-bold text-zinc-600">
                This goal is archived. Its set-aside money and holdings count for nothing until you restore it.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "earmark", action: "set_aside" })}>
                  + Set aside
                </button>
                {goal.earmarks.length > 0 && (
                  <button type="button" className={SECONDARY} onClick={() => setDialog({ kind: "earmark", action: "release" })}>
                    Release
                  </button>
                )}
                <button type="button" className={SECONDARY} onClick={() => setDialog({ kind: "holding" })}>
                  + Add holding
                </button>
              </div>
            )}

            <Basket goal={goal} onRemove={(holding) => setDialog({ kind: "remove-holding", holding })} />

            <History goal={goal} onDelete={(entry) => setDialog({ kind: "delete-entry", entry })} />
          </div>

          {dialog.kind === "edit" && (
            <GoalDialog
              goal={goal}
              hasEmergency={false}
              onClose={closeDialog}
              onSaved={() => done(null)}
              onConflict={done}
            />
          )}

          {dialog.kind === "earmark" && (
            <EarmarkDialog
              goal={goal}
              action={dialog.action}
              earmarks={goal.earmarks}
              onClose={closeDialog}
              onSaved={(release) => (release ? void recordExpense(release) : done(null))}
              onConflict={done}
            />
          )}

          {dialog.kind === "expense" && (
            <TransactionDialog
              transaction={null}
              accounts={dialog.accounts}
              defaultAccountId={dialog.release.account_id}
              initialForm={expenseFormFromRelease(dialog.release, todayIndia())}
              onClose={closeDialog}
              onSaved={() => done(null)}
              onConflict={done}
            />
          )}

          {dialog.kind === "holding" && (
            <HoldingDialog goal={goal} onClose={closeDialog} onSaved={() => done(null)} onConflict={done} />
          )}

          {dialog.kind === "remove-holding" && (
            <ConfirmDelete
              title={`Take ${dialog.holding.name} out of ${goal.name}?`}
              body="It stops counting toward this goal and is free to join another. The holding itself isn't touched."
              path={`/goals/${goal.id}/holdings/${dialog.holding.id}`}
              onClose={closeDialog}
              onDone={done}
            />
          )}

          {dialog.kind === "delete-entry" && (
            <ConfirmDelete
              title={`Delete "${entryTitle(dialog.entry)}" on ${formatFullDate(dialog.entry.date)}?`}
              body={`The entry is removed from the history, and ${goal.name}'s money in ${dialog.entry.account_name} changes back. No transaction is touched.`}
              path={`/goals/${goal.id}/earmarks/${dialog.entry.id}`}
              onClose={closeDialog}
              onDone={done}
            />
          )}

          {dialog.kind === "archive" && <ArchiveDialog goal={goal} onClose={closeDialog} onDone={done} />}

          {dialog.kind === "delete" && (
            <ConfirmDelete
              title={`Delete ${goal.name}?`}
              body="The goal and its basket are removed for good. Your accounts and holdings aren't touched."
              path={`/goals/${goal.id}`}
              onClose={closeDialog}
              onDone={(message) => {
                if (message === null) router.push("/goals");
                else done(message);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function Summary({ goal }: { goal: GoalDetail }) {
  const pace = paceText(goal);
  return (
    <section aria-label="Progress" className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-5 rounded-[18px] border-[2.5px] border-ink bg-purple-strong p-5 text-white shadow-chunky sm:flex-row">
        <Ring percent={goal.percent} reached={goal.reached} label={`${goal.name} progress`} size={140} />
        <dl className="grid w-full min-w-0 grid-cols-2 gap-3">
          <Fact label="Saved" value={whole(goal.saved)} />
          <Fact label="Target" value={goal.target === null ? "—" : whole(goal.target)} />
          <Fact label="Set aside" value={whole(goal.earmarked)} />
          <Fact label="Holdings" value={whole(goal.holdings_value)} />
        </dl>
      </div>
      {(goal.kind === "emergency" || pace || goal.target_date || goal.monthly_amount) && (
        <div className="flex flex-col gap-1 text-sm font-bold text-zinc-700">
          {goal.kind === "emergency" && <p>{efText(goal)}</p>}
          {goal.target_date && !goal.reached && (
            <p>
              Reach it by {formatFullDate(goal.target_date)}
              {goal.months_left !== null && goal.months_left > 0
                ? ` · ${goal.months_left} ${goal.months_left === 1 ? "month" : "months"} left`
                : ""}
            </p>
          )}
          {pace && <p className={goal.overdue ? "font-black text-ink" : ""}>{pace}</p>}
          {goal.monthly_amount && goal.reminder_day !== null && (
            <p>
              Reminder to set aside {whole(goal.monthly_amount)} on day {goal.reminder_day} of each month
            </p>
          )}
        </div>
      )}
      {goal.note && <p className="text-sm font-bold whitespace-pre-line [overflow-wrap:anywhere]">{goal.note}</p>}
      <Warnings warnings={goal.warnings} />
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[14px] border-[2.5px] border-ink bg-card p-2.5 text-ink">
      <dt className="text-xs font-extrabold text-zinc-600">{label}</dt>
      <dd className="mt-0.5 text-lg leading-tight font-black tabular-nums [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function Basket({ goal, onRemove }: { goal: GoalDetail; onRemove: (holding: HoldingLine) => void }) {
  if (goal.earmarks.length === 0 && goal.holdings.length === 0) {
    return (
      <EmptyState emoji="🧺" title="The basket is empty">
        {goal.archived
          ? "Restore this goal to put money toward it again."
          : "Use Set aside to label money in a bank, cash or wallet account for this goal, or Add holding for a fund, stock, coin, PPF or RD you own."}
      </EmptyState>
    );
  }
  return (
    <>
      {goal.earmarks.length > 0 && (
        <section aria-labelledby="earmarks-title">
          <h2 id="earmarks-title" className={SECTION_TITLE}>
            Set aside by account
          </h2>
          <ul className={LIST}>
            {goal.earmarks.map((e) => (
              <li key={e.account_id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                <span className="min-w-0 text-sm font-extrabold [overflow-wrap:anywhere]">
                  <EmojiSquare emoji="🏦" tone="blue" />
                  {e.account_name}
                </span>
                <span className="text-sm font-black tabular-nums">{whole(e.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {goal.holdings.length > 0 && (
        <section aria-labelledby="holdings-title">
          <h2 id="holdings-title" className={SECTION_TITLE}>
            Holdings
          </h2>
          <ul className={LIST}>
            {goal.holdings.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-40 flex-1">
                  <p className={`text-sm font-extrabold [overflow-wrap:anywhere] ${h.status === "held" ? "" : "text-zinc-600"}`}>
                    <EmojiSquare emoji={HOLDING_EMOJI[h.kind]} tone="purple" />
                    {holdingName(h)}
                  </p>
                  <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">
                    {[HOLDING_KIND[h.kind], h.note].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <p className="text-right text-sm font-black tabular-nums">{whole(h.value)}</p>
                <div className="flex shrink-0 justify-end gap-1">
                  <button type="button" className={ROW_ACTION} aria-label={`Remove ${h.name} from ${goal.name}`} onClick={() => onRemove(h)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function History({ goal, onDelete }: { goal: GoalDetail; onDelete: (entry: HistoryLine) => void }) {
  if (goal.history.length === 0) return null;
  return (
    <section aria-labelledby="history-title">
      <h2 id="history-title" className={SECTION_TITLE}>
        History
      </h2>
      <ul className={LIST}>
        {goal.history.map((entry) => {
          const title = entryTitle(entry);
          const details = [formatFullDate(entry.date), entry.account_name, entry.note].filter(Boolean);
          return (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-40 flex-1">
                <p className="text-sm font-extrabold tabular-nums [overflow-wrap:anywhere]">{title}</p>
                <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{details.join(" · ")}</p>
              </div>
              {!goal.archived && (
                <div className="flex shrink-0 justify-end gap-1">
                  <button
                    type="button"
                    className={ROW_ACTION}
                    aria-label={`Delete ${title} on ${formatFullDate(entry.date)}`}
                    onClick={() => onDelete(entry)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!goal.archived && (
        <p className="mt-2 px-1 text-xs font-bold text-zinc-600">
          Entries aren&apos;t edited. To correct one, delete it and set aside or release again.
        </p>
      )}
    </section>
  );
}

function ArchiveDialog({ goal, onClose, onDone }: { goal: GoalDetail; onClose: () => void; onDone: (message: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function confirm() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await apiFetch(`/goals/${goal.id}/archive`, { method: "POST" });
      onDone(null);
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else onDone(errorMessage(err));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="archive-goal-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(26rem,calc(100vw-2rem))]`}
    >
      <h2 id="archive-goal-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black [overflow-wrap:anywhere]">
        Archive {goal.name}?
      </h2>
      <div className="px-5 py-4">
        <p className="text-sm font-bold text-zinc-700">
          Its history stays, but the money set aside stops counting against your accounts and its holdings are free to join another goal.
          You can restore it later.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
        <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className={PRIMARY} disabled={saving} onClick={confirm}>
          {saving ? "Archiving..." : "Archive"}
        </button>
      </div>
    </dialog>
  );
}
