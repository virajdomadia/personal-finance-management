"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { Select } from "@/components/ui/select";
import {
  TRANSACTION_TYPES,
  type Transaction,
  type TransactionList,
  type TransactionType,
  formatDate,
  formatMonth,
  groupByDate,
  shiftMonth,
  signedAmount,
  todayIndia,
} from "@/lib/transactions";

import { TransactionDialog } from "./transaction-dialog";

type Filters = { month: string; accountId: number | null; type: TransactionType | null };
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: TransactionList };
type Dialog = { kind: "none" } | { kind: "form"; transaction: Transaction | null } | { kind: "delete"; transaction: Transaction };
type Accounts = { active: Account[]; archived: Account[] };

const BUTTON =
  "rounded-md px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none disabled:opacity-60";
const PRIMARY = `${BUTTON} bg-zinc-900 font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;
const QUIET = `${BUTTON} text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800`;
const ROW_ACTION =
  "rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";

const PAGE_SIZE = 50;

function query(filters: Filters, offset: number): string {
  const params = new URLSearchParams({ month: filters.month, limit: String(PAGE_SIZE), offset: String(offset) });
  if (filters.accountId !== null) params.set("account_id", String(filters.accountId));
  if (filters.type !== null) params.set("type", filters.type);
  return `/transactions?${params}`;
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export function TransactionsView({ initialAccountId }: { initialAccountId: number | null }) {
  const [thisMonth] = useState(() => todayIndia().slice(0, 7));
  const [filters, setFilters] = useState<Filters>({ month: thisMonth, accountId: initialAccountId, type: null });
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const latest = useRef(0);
  // The filters on screen right now; a late reload must not read stale ones from its closure.
  const filtersRef = useRef(filters);

  const fetchFirstPage = useCallback((current: Filters) => {
    const request = ++latest.current;
    setLoadingMore(false);
    apiFetch<TransactionList>(query(current, 0))
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, []);

  const fetchAccounts = useCallback(() => {
    Promise.all([apiFetch<AccountList>("/accounts"), apiFetch<AccountList>("/accounts?archived=true")])
      .then(([active, archived]) => setAccounts({ active: active.accounts, archived: archived.accounts }))
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else setNotice("We couldn't load your accounts. Reload the page to add a transaction.");
      });
  }, []);

  useEffect(() => {
    fetchFirstPage(filtersRef.current);
    fetchAccounts();
  }, [fetchFirstPage, fetchAccounts]);

  const applyFilters = (change: Partial<Filters>) => {
    const next = { ...filtersRef.current, ...change };
    filtersRef.current = next;
    setFilters(next);
    setNotice(null);
    setLoad({ status: "loading" });
    fetchFirstPage(next);
  };

  const reload = () => fetchFirstPage(filtersRef.current);
  const closeDialog = () => setDialog({ kind: "none" });

  async function loadMore() {
    if (load.status !== "ready" || loadingMore) return;
    const loaded = load.data.transactions;
    const request = ++latest.current;
    setLoadingMore(true);
    try {
      const data = await apiFetch<TransactionList>(query(filtersRef.current, loaded.length));
      if (request === latest.current) {
        setLoad({ status: "ready", data: { ...data, transactions: [...loaded, ...data.transactions] } });
      }
    } catch (err) {
      if (isUnauthorized(err)) return void logout();
      if (request === latest.current) setNotice(errorMessage(err));
    } finally {
      if (request === latest.current) setLoadingMore(false);
    }
  }

  const canAdd = accounts !== null && accounts.active.length > 0;
  const noAccounts = accounts !== null && accounts.active.length === 0 && accounts.archived.length === 0;
  const openAdd = () => setDialog({ kind: "form", transaction: null });
  const defaultAccountId =
    accounts?.active.find((a) => a.id === filters.accountId)?.id ?? accounts?.active[0]?.id ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">Transactions</h1>
        {canAdd && (
          <button type="button" className={PRIMARY} onClick={openAdd}>
            Add transaction
          </button>
        )}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={QUIET}
            aria-label="Previous month"
            onClick={() => applyFilters({ month: shiftMonth(filters.month, -1) })}
          >
            ‹
          </button>
          <span className="w-36 text-center text-sm font-medium" aria-live="polite">
            {formatMonth(filters.month)}
          </span>
          <button
            type="button"
            className={QUIET}
            aria-label="Next month"
            disabled={filters.month >= thisMonth}
            onClick={() => applyFilters({ month: shiftMonth(filters.month, 1) })}
          >
            ›
          </button>
        </div>
        <Select
          ariaLabel="Filter by account"
          className="w-48"
          value={filters.accountId === null ? "" : String(filters.accountId)}
          placeholder="All accounts"
          options={[
            { value: "", label: "All accounts" },
            ...(accounts?.active.map((a) => ({ value: String(a.id), label: a.name })) ?? []),
            ...(accounts?.archived.map((a) => ({ value: String(a.id), label: `${a.name} (archived)` })) ?? []),
          ]}
          onChange={(value) => applyFilters({ accountId: value === "" ? null : Number(value) })}
        />
        <Select
          ariaLabel="Filter by type"
          className="w-36"
          value={filters.type ?? ""}
          options={[{ value: "", label: "All types" }, ...TRANSACTION_TYPES]}
          onChange={(value) => applyFilters({ type: value === "" ? null : (value as TransactionType) })}
        />
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
          Loading transactions...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load your transactions.</p>
          <button type="button" className={`${QUIET} mt-2 -ml-3`} onClick={() => applyFilters({})}>
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" && (
        <>
          <dl className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Total label="Income" value={load.data.total_income} />
            <Total label="Spent" value={load.data.total_expense} />
          </dl>

          {load.data.transactions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
              {noAccounts ? (
                <>
                  <p className="font-medium">Add an account first</p>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Every transaction belongs to an account.</p>
                  <Link href="/accounts" className={`${PRIMARY} mt-4 inline-block`}>
                    Go to accounts
                  </Link>
                </>
              ) : (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">No transactions match in {formatMonth(filters.month)}.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {groupByDate(load.data.transactions).map((group) => (
                <section key={group.date} aria-label={formatDate(group.date)}>
                  <h2 className="mb-1 px-1 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                    {formatDate(group.date)}
                  </h2>
                  <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                    {group.transactions.map((tx) => (
                      <TransactionRow
                        key={tx.id}
                        transaction={tx}
                        viewedAccountId={filters.accountId}
                        onEdit={() => setDialog({ kind: "form", transaction: tx })}
                        onDelete={() => setDialog({ kind: "delete", transaction: tx })}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              {load.data.has_more && (
                <button type="button" className={`${QUIET} self-center`} disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {dialog.kind === "form" && accounts !== null && (
        <TransactionDialog
          key={dialog.transaction?.id ?? "new"}
          transaction={dialog.transaction}
          accounts={accounts.active}
          defaultAccountId={defaultAccountId}
          onClose={closeDialog}
          onSaved={(saved) => {
            closeDialog();
            // Show the month the transaction landed in, or it would seem to have vanished.
            applyFilters({ month: saved.date.slice(0, 7) });
          }}
          onConflict={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}

      {dialog.kind === "delete" && (
        <DeleteDialog
          transaction={dialog.transaction}
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

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <dt className="text-sm text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums [overflow-wrap:anywhere]">{formatRupees(value)}</dd>
    </div>
  );
}

function TransactionRow({
  transaction: tx,
  viewedAccountId,
  onEdit,
  onDelete,
}: {
  transaction: Transaction;
  viewedAccountId: number | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const title = tx.type === "transfer" ? "Transfer" : tx.type === "emi" ? `EMI · ${tx.to_account_name}` : tx.category;
  const accountText =
    tx.type === "transfer"
      ? `${tx.account_name} → ${tx.to_account_name}`
      : tx.type === "emi" && tx.interest !== null
        ? `${tx.account_name} · ${formatRupees(tx.interest)} interest`
        : tx.account_name;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-32 flex-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{title}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">
          {tx.note ? `${accountText} · ${tx.note}` : accountText}
        </p>
      </div>
      <p className="min-w-0 max-w-full text-right text-sm font-medium tabular-nums [overflow-wrap:anywhere]">
        {signedAmount(tx, viewedAccountId)}
      </p>
      <div className="flex w-24 shrink-0 justify-end gap-1">
        {tx.editable ? (
          <>
            <button type="button" className={ROW_ACTION} aria-label={`Edit ${title}, ${tx.date}`} onClick={onEdit}>
              Edit
            </button>
            <button type="button" className={ROW_ACTION} aria-label={`Delete ${title}, ${tx.date}`} onClick={onDelete}>
              Delete
            </button>
          </>
        ) : (
          <span className="px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400">Archived</span>
        )}
      </div>
    </li>
  );
}

function DeleteDialog({
  transaction: tx,
  onClose,
  onDone,
}: {
  transaction: Transaction;
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
      await apiFetch(`/transactions/${tx.id}`, { method: "DELETE" });
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
      aria-labelledby="delete-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div className="px-5 py-4">
        <h2 id="delete-title" className="text-base font-semibold">
          Delete this {TRANSACTION_TYPES.find((t) => t.value === tx.type)?.label.toLowerCase()} of{" "}
          {formatRupees(tx.amount)}?
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          It&apos;s removed for good, and the account balance moves back. This can&apos;t be undone.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className={PRIMARY} disabled={saving} onClick={confirm}>
          {saving ? "Deleting..." : "Delete"}
        </button>
      </div>
    </dialog>
  );
}
