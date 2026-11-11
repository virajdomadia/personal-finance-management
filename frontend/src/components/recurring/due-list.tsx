"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { EarmarkDialog } from "@/components/goals/earmark-dialog";
import { RenewDialog } from "@/components/insurance/renew-dialog";
import { Notice, QUIET, isUnauthorized } from "@/components/investments/shared";
import { buttonClass } from "@/components/ui/chunky";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import { type GoalDue, goalDueText } from "@/lib/goals";
import { type DueItem, type DueList as DueListData, canSkip, dueText, transactionFormFromTemplate } from "@/lib/recurring";
import type { Policy } from "@/lib/insurance";
import { todayIndia } from "@/lib/transactions";

const GROUP_TITLE = "mb-0.5 text-xs font-black tracking-wide uppercase";
const ROW = "flex flex-wrap items-center gap-x-4 gap-y-2 border-b-[1.5px] border-dashed border-zinc-300 py-2 last:border-b-0";
const SMALL_GREEN = `${buttonClass("green")} !px-3 !py-1`;
const SMALL_ALT = `${buttonClass("alt")} !px-2.5 !py-1`;

const itemKey = (item: DueItem) => `${item.template.id}-${item.occurrence}`;

type ListProps = {
  items: DueItem[];
  onRecord: (item: DueItem) => void;
  onSkipped: () => void;
  onError: (message: string) => void;
  onClearError: () => void;
};

// Due and coming-up reminders, each with Record and Skip, or just Renew for an insurance premium.
export function DueList({ items, onRecord, onSkipped, onError, onClearError }: ListProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const busy = useRef(false);
  const due = items.filter((i) => i.state === "due");
  const comingUp = items.filter((i) => i.state === "coming_up");

  async function skip(item: DueItem) {
    if (busy.current) return;
    busy.current = true;
    setSkipping(itemKey(item));
    try {
      await apiFetch(`/recurring/${item.template.id}/skip`, {
        method: "POST",
        body: JSON.stringify({ occurrence: item.occurrence }),
      });
      setConfirming(null);
      onClearError();
      onSkipped();
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else {
        setConfirming(null);
        onError(errorMessage(err));
        onSkipped(); // the row may be stale (already skipped or recorded elsewhere)
      }
    } finally {
      busy.current = false;
      setSkipping(null);
    }
  }

  const group = (title: string, id: string, rows: DueItem[]) =>
    rows.length === 0 ? null : (
      <section aria-labelledby={id}>
        <h2 id={id} className={GROUP_TITLE}>
          {title}
        </h2>
        <ul>
          {rows.map((item) => {
            const key = itemKey(item);
            const isPolicy = item.template.policy_id !== null;
            const asking = confirming === key;
            return (
              <li key={key} className={ROW}>
                <p className="min-w-32 flex-1 text-sm font-extrabold [overflow-wrap:anywhere]">{dueText(item)}</p>
                <div className="flex shrink-0 items-center justify-end gap-1">
                  {asking ? (
                    <>
                      <span className="px-1 text-xs font-bold">Skip this one?</span>
                      <button type="button" className={SMALL_ALT} disabled={skipping === key} onClick={() => skip(item)}>
                        {skipping === key ? "Skipping..." : "Yes, skip"}
                      </button>
                      <button type="button" className={SMALL_ALT} disabled={skipping === key} onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={SMALL_GREEN}
                        aria-label={isPolicy ? `Renew ${item.template.name}` : `Done: record ${item.template.name}`}
                        onClick={() => onRecord(item)}
                      >
                        {isPolicy ? "RENEW" : "✓ DONE"}
                      </button>
                      {canSkip(item) && (
                        <button
                          type="button"
                          className={SMALL_ALT}
                          aria-label={`Skip ${item.template.name}`}
                          onClick={() => setConfirming(key)}
                        >
                          Skip
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );

  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {group("Due", "due-title", due)}
      {group("Coming up", "coming-up-title", comingUp)}
    </div>
  );
}

// What Record opens: the renewal form for an insurance premium, the transaction form for anything else.
function RecordFlow({
  item,
  onClose,
  onDone,
}: {
  item: DueItem;
  onClose: () => void;
  onDone: (message: string | null, recordedDate?: string) => void;
}) {
  const policyId = item.template.policy_id;
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  // The page's callback changes every render; the load below must run once.
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  useEffect(() => {
    let current = true;
    const fail = (err: unknown) => {
      if (!current) return;
      if (isUnauthorized(err)) void logout();
      else done.current(err instanceof ApiError ? errorMessage(err) : "We couldn't open that form. Try again.");
    };
    if (policyId !== null) {
      apiFetch<{ policies: Policy[] }>("/insurance")
        .then((list) => {
          if (!current) return;
          const found = list.policies.find((p) => p.id === policyId);
          if (found) setPolicy(found);
          else done.current("That policy isn't there any more.");
        })
        .catch(fail);
    } else {
      apiFetch<AccountList>("/accounts")
        .then((list) => {
          if (current) setAccounts(list.accounts);
        })
        .catch(fail);
    }
    return () => {
      current = false;
    };
  }, [policyId]);

  if (policy) {
    return <RenewDialog policy={policy} onClose={onClose} onRenewed={() => onDone(null)} />;
  }
  if (accounts) {
    return (
      <TransactionDialog
        transaction={null}
        accounts={accounts}
        defaultAccountId={item.template.account_id}
        initialForm={transactionFormFromTemplate(item.template, item.occurrence, todayIndia())}
        onClose={onClose}
        onSaved={(saved) => onDone(null, saved.date)}
        onConflict={(message) => onDone(message)}
      />
    );
  }
  return null;
}

// Goals with money still to set aside this month. Record opens the set-aside form pre-filled.
function GoalsDue({ goals, onRecord }: { goals: GoalDue[]; onRecord: (due: GoalDue) => void }) {
  if (goals.length === 0) return null;
  return (
    <section aria-labelledby="goals-due-title">
      <h2 id="goals-due-title" className={GROUP_TITLE}>
        Set aside
      </h2>
      <ul>
        {goals.map((due) => (
          <li key={due.goal_id} className={ROW}>
            <p className="min-w-32 flex-1 text-sm font-extrabold [overflow-wrap:anywhere]">{goalDueText(due)}</p>
            <div className="flex shrink-0 items-center justify-end gap-1">
              <button
                type="button"
                className={SMALL_GREEN}
                aria-label={`Done: set aside for ${due.name}`}
                onClick={() => onRecord(due)}
              >
                ✓ DONE
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

type SectionProps = {
  // Items the page already has (the dashboard's); without them the section loads its own.
  items?: DueItem[];
  goals?: GoalDue[];
  // Change to reload the section's own items, e.g. after the page's transactions changed.
  refreshKey?: number;
  // Called after something was recorded or skipped, so the page can reload what it shows. A recorded
  // transaction passes its date.
  onChanged?: (recordedDate?: string) => void;
  // Draw the rows bare, for a card the page already provides; otherwise they sit in their own card.
  embedded?: boolean;
};

// The due and coming-up lists with their Record and Skip, ready to drop into a page.
export function DueSection({ items: given, goals: givenGoals, refreshKey = 0, onChanged, embedded = false }: SectionProps) {
  const [fetched, setFetched] = useState<DueItem[]>([]);
  const [fetchedGoals, setFetchedGoals] = useState<GoalDue[]>([]);
  const [recordGoal, setRecordGoal] = useState<GoalDue | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [record, setRecord] = useState<DueItem | null>(null);
  const latest = useRef(0);
  const own = given === undefined;

  const load = useCallback(() => {
    const request = ++latest.current;
    apiFetch<DueListData>("/recurring/due")
      .then((data) => {
        if (request !== latest.current) return;
        setFetched(data.items);
        setFetchedGoals(data.goals_due ?? []);
        setFailed(false);
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setFailed(true);
      });
  }, []);

  useEffect(() => {
    if (own) load();
  }, [own, load, refreshKey]);

  const changed = (recordedDate?: string) => {
    if (own) load();
    onChanged?.(recordedDate);
  };
  const closeRecord = useCallback(() => setRecord(null), []);
  const recorded = (message: string | null, recordedDate?: string) => {
    setRecord(null);
    setNotice(message);
    changed(recordedDate);
  };

  const items = given ?? fetched;
  const goals = (own ? fetchedGoals : givenGoals) ?? [];
  return (
    <>
      <Notice message={notice} />
      {own && failed && (
        <p role="alert" className="mb-4 text-sm font-bold">
          We couldn&apos;t load your reminders.{" "}
          <button type="button" className={QUIET} onClick={load}>
            Try again
          </button>
        </p>
      )}
      {(items.length > 0 || goals.length > 0) && (
        <div
          className={
            embedded
              ? "flex flex-col gap-3"
              : "mb-6 flex flex-col gap-3 rounded-[18px] border-[2.5px] border-ink bg-due p-3.5 shadow-chunky"
          }
        >
          <DueList items={items} onRecord={setRecord} onSkipped={() => changed()} onError={setNotice} onClearError={() => setNotice(null)} />
          <GoalsDue goals={goals} onRecord={setRecordGoal} />
        </div>
      )}
      {record && <RecordFlow key={itemKey(record)} item={record} onClose={closeRecord} onDone={recorded} />}
      {recordGoal && (
        <EarmarkDialog
          key={recordGoal.goal_id}
          goal={{ id: recordGoal.goal_id, name: recordGoal.name }}
          action="set_aside"
          initialAmount={recordGoal.amount}
          onClose={() => setRecordGoal(null)}
          onSaved={() => {
            setRecordGoal(null);
            setNotice(null);
            changed();
          }}
          onConflict={(message) => {
            setRecordGoal(null);
            setNotice(message);
            changed();
          }}
        />
      )}
    </>
  );
}
