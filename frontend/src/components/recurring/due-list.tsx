"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { RenewDialog } from "@/components/insurance/renew-dialog";
import { LIST, Notice, PRIMARY, QUIET, ROW_ACTION, SECTION_TITLE, isUnauthorized } from "@/components/investments/shared";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import { type DueItem, canSkip, dueText, transactionFormFromTemplate } from "@/lib/recurring";
import type { Policy } from "@/lib/insurance";
import { todayIndia } from "@/lib/transactions";

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
        <h2 id={id} className={SECTION_TITLE}>
          {title}
        </h2>
        <ul className={LIST}>
          {rows.map((item) => {
            const key = itemKey(item);
            const isPolicy = item.template.policy_id !== null;
            const asking = confirming === key;
            return (
              <li key={key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <p className="min-w-32 flex-1 text-sm [overflow-wrap:anywhere]">{dueText(item)}</p>
                <div className="flex shrink-0 items-center justify-end gap-1">
                  {asking ? (
                    <>
                      <span className="px-1 text-xs text-zinc-600 dark:text-zinc-400">Skip this one?</span>
                      <button type="button" className={ROW_ACTION} disabled={skipping === key} onClick={() => skip(item)}>
                        {skipping === key ? "Skipping..." : "Yes, skip"}
                      </button>
                      <button type="button" className={ROW_ACTION} disabled={skipping === key} onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={`${PRIMARY} !px-3 !py-1 !text-xs`}
                        aria-label={`${isPolicy ? "Renew" : "Record"} ${item.template.name}`}
                        onClick={() => onRecord(item)}
                      >
                        {isPolicy ? "Renew" : "Record"}
                      </button>
                      {canSkip(item) && (
                        <button
                          type="button"
                          className={ROW_ACTION}
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
    <div className="flex flex-col gap-4">
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

type SectionProps = {
  // Items the page already has (the dashboard's); without them the section loads its own.
  items?: DueItem[];
  // Change to reload the section's own items, e.g. after the page's transactions changed.
  refreshKey?: number;
  // Called after something was recorded or skipped, so the page can reload what it shows. A recorded
  // transaction passes its date.
  onChanged?: (recordedDate?: string) => void;
};

// The due and coming-up lists with their Record and Skip, ready to drop into a page.
export function DueSection({ items: given, refreshKey = 0, onChanged }: SectionProps) {
  const [fetched, setFetched] = useState<DueItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [record, setRecord] = useState<DueItem | null>(null);
  const latest = useRef(0);
  const own = given === undefined;

  const load = useCallback(() => {
    const request = ++latest.current;
    apiFetch<{ items: DueItem[] }>("/recurring/due")
      .then((data) => {
        if (request !== latest.current) return;
        setFetched(data.items);
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
  return (
    <>
      <Notice message={notice} />
      {own && failed && (
        <p role="alert" className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          We couldn&apos;t load your reminders.{" "}
          <button type="button" className={QUIET} onClick={load}>
            Try again
          </button>
        </p>
      )}
      {items.length > 0 && (
        <div className="mb-6">
          <DueList items={items} onRecord={setRecord} onSkipped={() => changed()} onError={setNotice} onClearError={() => setNotice(null)} />
        </div>
      )}
      {record && <RecordFlow key={itemKey(record)} item={record} onClose={closeRecord} onDone={recorded} />}
    </>
  );
}
