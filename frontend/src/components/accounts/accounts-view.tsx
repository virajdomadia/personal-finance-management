"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import {
  type Account,
  type AccountList,
  OWED_TYPES,
  TYPE_LABELS,
  TYPE_ORDER,
  errorMessage,
  formatDueDate,
  formatRupees,
  maskLast4,
  nextDueDate,
} from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { emiForm, todayIndia } from "@/lib/transactions";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";

import { AccountDialog } from "./account-dialog";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: AccountList };
type Dialog =
  | { kind: "none" }
  | { kind: "form"; account: Account | null }
  | { kind: "archive"; account: Account }
  | { kind: "emi"; loan: Account };

const BUTTON =
  "rounded-md px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none disabled:opacity-60";
const PRIMARY = `${BUTTON} bg-zinc-900 font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;
const QUIET = `${BUTTON} text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800`;
const ROW_ACTION =
  "rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export function AccountsView() {
  const [archived, setArchived] = useState(false);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);
  // The view on screen right now; a late reload must not read a stale `archived` from its closure.
  const archivedRef = useRef(false);

  const fetchList = useCallback((showArchived: boolean) => {
    const request = ++latest.current;
    apiFetch<AccountList>(showArchived ? "/accounts?archived=true" : "/accounts")
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, []);

  useEffect(() => {
    fetchList(false);
  }, [fetchList]);

  const reload = () => fetchList(archivedRef.current);

  const switchView = (showArchived: boolean) => {
    archivedRef.current = showArchived;
    setArchived(showArchived);
    setNotice(null);
    setLoad({ status: "loading" });
    fetchList(showArchived);
  };

  const closeDialog = () => setDialog({ kind: "none" });
  // Only the active list is ever on screen when adding, editing or recording an EMI.
  const activeAccounts = load.status === "ready" && !archived ? load.data.accounts : [];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">{archived ? "Archived accounts" : "Accounts"}</h1>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={QUIET} onClick={() => switchView(!archived)}>
            {archived ? "Back to accounts" : "View archived"}
          </button>
          {!archived && (
            <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form", account: null })}>
              Add account
            </button>
          )}
        </div>
      </div>

      {notice ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {notice}
        </p>
      ) : null}

      {load.status === "loading" && (
        <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading accounts...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load your accounts.</p>
          <button type="button" className={`${QUIET} mt-2 -ml-3`} onClick={() => switchView(archived)}>
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" && (
        <Content
          data={load.data}
          archived={archived}
          onAdd={() => setDialog({ kind: "form", account: null })}
          onEdit={(account) => setDialog({ kind: "form", account })}
          onArchive={(account) => setDialog({ kind: "archive", account })}
          onRecordEmi={(loan) => setDialog({ kind: "emi", loan })}
          onRestore={async (account) => {
            setNotice(null);
            try {
              await apiFetch(`/accounts/${account.id}/restore`, { method: "POST" });
            } catch (err) {
              if (isUnauthorized(err)) return void logout();
              setNotice(errorMessage(err));
            }
            reload();
          }}
        />
      )}

      {dialog.kind === "form" && (
        <AccountDialog
          key={dialog.account?.id ?? "new"}
          account={dialog.account}
          accounts={activeAccounts}
          onClose={closeDialog}
          onSaved={() => {
            setNotice(null);
            closeDialog();
            reload();
          }}
          onConflict={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}

      {dialog.kind === "emi" && (
        <TransactionDialog
          transaction={null}
          accounts={activeAccounts}
          defaultAccountId={dialog.loan.pay_from_id}
          initialForm={emiForm(dialog.loan, todayIndia())}
          onClose={closeDialog}
          onSaved={() => {
            setNotice(null);
            closeDialog();
            reload();
          }}
          onConflict={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}

      {dialog.kind === "archive" && (
        <ArchiveDialog
          account={dialog.account}
          onClose={closeDialog}
          onDone={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}
    </div>
  );
}

function Content({
  data,
  archived,
  onAdd,
  onEdit,
  onArchive,
  onRestore,
  onRecordEmi,
}: {
  data: AccountList;
  archived: boolean;
  onAdd: () => void;
  onEdit: (account: Account) => void;
  onArchive: (account: Account) => void;
  onRestore: (account: Account) => Promise<void>;
  onRecordEmi: (loan: Account) => void;
}) {
  const groups = TYPE_ORDER.map((type) => ({
    type,
    accounts: data.accounts.filter((a) => a.type === type),
  })).filter((g) => g.accounts.length > 0);

  return (
    <>
      {!archived && (
        <dl className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Total label="You have" value={data.total_have} />
          <Total label="You owe" value={data.total_owe} />
        </dl>
      )}

      {groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
          {archived ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No archived accounts.</p>
          ) : (
            <>
              <p className="font-medium">Add your first account</p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Bank accounts, credit cards, cash, broker balances, wallets and loans all live here.
              </p>
              <button type="button" className={`${PRIMARY} mt-4`} onClick={onAdd}>
                Add account
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map(({ type, accounts }) => (
            <section key={type} aria-labelledby={`group-${type}`}>
              <h2 id={`group-${type}`} className="mb-1 px-1 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                {TYPE_LABELS[type]}
              </h2>
              <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    onEdit={onEdit}
                    onArchive={onArchive}
                    onRestore={onRestore}
                    onRecordEmi={onRecordEmi}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <dt className="text-sm text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums [overflow-wrap:anywhere]">{formatRupees(value)}</dd>
    </div>
  );
}

function AccountRow({
  account,
  onEdit,
  onArchive,
  onRestore,
  onRecordEmi,
}: {
  account: Account;
  onEdit: (account: Account) => void;
  onArchive: (account: Account) => void;
  onRestore: (account: Account) => Promise<void>;
  onRecordEmi: (loan: Account) => void;
}) {
  const [restoring, setRestoring] = useState(false);
  const [today] = useState(todayIndia);
  const card = account.type === "credit_card";
  const owed = OWED_TYPES.has(account.type);
  const loan = account.type === "loan";
  const paidOff = loan && account.balance === "0.00";
  const loanDetails = loan
    ? [
        account.emi_amount ? `EMI ${formatRupees(account.emi_amount)}` : null,
        account.emis_left !== null ? `${account.emis_left} left` : null,
        account.due_day !== null && !paidOff ? `next ${formatDueDate(nextDueDate(account.due_day, today))}` : null,
        account.interest_rate !== null ? `${account.interest_rate}% a year` : null,
      ].filter(Boolean)
    : [];
  const details = [
    account.institution && account.institution !== account.name ? account.institution : null,
    account.type === "bank" && account.bank_kind
      ? account.bank_kind.charAt(0).toUpperCase() + account.bank_kind.slice(1)
      : null,
    account.last4 ? maskLast4(account.last4) : null,
  ].filter(Boolean);

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-32 flex-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{account.name}</p>
        {details.length > 0 && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">{details.join(" · ")}</p>
        )}
        {loanDetails.length > 0 && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">{loanDetails.join(" · ")}</p>
        )}
      </div>
      <div className="min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]">
        <p className="text-sm font-medium">
          {owed && (
            <span className="mr-1.5 text-xs font-normal text-zinc-500 dark:text-zinc-400">{paidOff ? "Paid off" : "Owed"}</span>
          )}
          {formatRupees(account.balance)}
        </p>
        {card && account.available_credit !== null && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Available <span className="tabular-nums">{formatRupees(account.available_credit)}</span>
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        <Link href={`/transactions?account=${account.id}`} className={ROW_ACTION} aria-label={`Transactions for ${account.name}`}>
          Transactions
        </Link>
        {account.archived ? (
          <button
            type="button"
            className={ROW_ACTION}
            disabled={restoring}
            aria-label={`Restore ${account.name}`}
            onClick={async () => {
              setRestoring(true);
              try {
                await onRestore(account);
              } finally {
                setRestoring(false);
              }
            }}
          >
            Restore
          </button>
        ) : (
          <>
            {loan && !paidOff && (
              <button
                type="button"
                className={ROW_ACTION}
                aria-label={`Record an EMI for ${account.name}`}
                onClick={() => onRecordEmi(account)}
              >
                Record EMI
              </button>
            )}
            <button type="button" className={ROW_ACTION} aria-label={`Edit ${account.name}`} onClick={() => onEdit(account)}>
              Edit
            </button>
            <button type="button" className={ROW_ACTION} aria-label={`Archive ${account.name}`} onClick={() => onArchive(account)}>
              Archive
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function ArchiveDialog({
  account,
  onClose,
  onDone,
}: {
  account: Account;
  onClose: () => void;
  onDone: (message: string | null) => void;
}) {
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
      await apiFetch(`/accounts/${account.id}/archive`, { method: "POST" });
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
      aria-labelledby="archive-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div className="px-5 py-4">
        <h2 id="archive-title" className="text-base font-semibold">
          Archive {account.name}?
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          It leaves your list and totals. Nothing is deleted, and you can restore it from the archived view.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
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
