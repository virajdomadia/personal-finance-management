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
  headlineBalance,
  investmentsIn,
  maskLast4,
  nextDueDate,
} from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { freeBalanceText, overSetAsideText } from "@/lib/goals";
import { emiForm, todayIndia } from "@/lib/transactions";
import { depositLines, instalmentForm, interestForm, ppfDepositForm, ppfInterestText, rdDueText } from "@/lib/deposits";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import { FOCUS, PageHeader, ProgressBar, Tile, buttonClass } from "@/components/ui/chunky";
import { accountEmoji } from "@/lib/fun";

import { AccountDialog } from "./account-dialog";
import { CloseRdDialog } from "./close-rd-dialog";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: AccountList };
type Dialog =
  | { kind: "none" }
  | { kind: "form"; account: Account | null }
  | { kind: "archive"; account: Account }
  | { kind: "emi"; loan: Account }
  | { kind: "instalment"; account: Account }
  | { kind: "ppf-deposit"; account: Account }
  | { kind: "ppf-interest"; account: Account }
  | { kind: "close-rd"; account: Account };

const PRIMARY = `${buttonClass("primary")} uppercase`;
const QUIET = `${buttonClass("alt")} uppercase`;
const ROW_ACTION = `${buttonClass("alt")} !px-2.5 !py-1`;
const CARD = "rounded-[18px] border-[2.5px] border-ink bg-card p-5 shadow-chunky";
const SOON_DAYS = 5; // a card due within this many days gets the "due" tone

// Whole days from one "YYYY-MM-DD" to another, from the text so no timezone shifts the day.
function daysUntil(date: string, from: string): number {
  const ms = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(date) - ms(from)) / 86_400_000);
}

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
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={archived ? "Archived accounts" : "Accounts"}
        action={
          <>
            <button type="button" className={QUIET} onClick={() => switchView(!archived)}>
              {archived ? "Back to accounts" : "View archived"}
            </button>
            {!archived && (
              <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form", account: null })}>
                + Add account
              </button>
            )}
          </>
        }
      />

      {notice ? (
        <p role="alert" className="mb-4 rounded-[14px] border-[2.5px] border-ink bg-pink/15 px-3 py-2 text-sm font-extrabold text-ink">
          {notice}
        </p>
      ) : null}

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading accounts...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className={CARD}>
          <p className="text-4xl" aria-hidden="true">
            🙈
          </p>
          <p className="mt-1 font-extrabold">We couldn&apos;t load your accounts.</p>
          <button type="button" className={`${QUIET} mt-3`} onClick={() => switchView(archived)}>
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
          onDeposit={(account, kind) => setDialog({ kind, account })}
          onCloseRd={(account) => setDialog({ kind: "close-rd", account })}
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

      {(dialog.kind === "instalment" || dialog.kind === "ppf-deposit" || dialog.kind === "ppf-interest") && (
        <TransactionDialog
          transaction={null}
          accounts={activeAccounts}
          defaultAccountId={dialog.kind === "ppf-interest" ? dialog.account.id : dialog.account.pay_from_id}
          initialForm={
            dialog.kind === "instalment"
              ? instalmentForm(dialog.account, todayIndia())
              : dialog.kind === "ppf-deposit"
                ? ppfDepositForm(dialog.account, todayIndia())
                : interestForm(dialog.account)
          }
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

      {dialog.kind === "close-rd" && (
        <CloseRdDialog
          account={dialog.account}
          accounts={activeAccounts}
          onClose={closeDialog}
          onDone={() => {
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
  onDeposit,
  onCloseRd,
}: {
  data: AccountList;
  archived: boolean;
  onAdd: () => void;
  onEdit: (account: Account) => void;
  onArchive: (account: Account) => void;
  onRestore: (account: Account) => Promise<void>;
  onRecordEmi: (loan: Account) => void;
  onDeposit: (account: Account, kind: "instalment" | "ppf-deposit" | "ppf-interest") => void;
  onCloseRd: (account: Account) => void;
}) {
  const dueLines = archived
    ? []
    : data.accounts.flatMap((account) => {
        const rd = rdDueText(account);
        const ppf = ppfInterestText(account);
        return [
          ...(rd ? [{ key: `rd-${account.id}`, text: rd, label: "Record instalment", run: () => onDeposit(account, "instalment") }] : []),
          ...(ppf ? [{ key: `ppf-${account.id}`, text: ppf, label: "Record interest", run: () => onDeposit(account, "ppf-interest") }] : []),
        ];
      });
  const groups = TYPE_ORDER.map((type) => ({
    type,
    accounts: data.accounts.filter((a) => a.type === type),
  })).filter((g) => g.accounts.length > 0);

  // PPF and RD share one "Deposits" group.
  const sections: { key: string; title: string; accounts: Account[] }[] = [];
  for (const g of groups) {
    const deposit = g.type === "ppf" || g.type === "rd";
    const last = sections[sections.length - 1];
    if (deposit && last?.key === "deposits") last.accounts.push(...g.accounts);
    else sections.push({ key: deposit ? "deposits" : g.type, title: deposit ? "Deposits" : TYPE_LABELS[g.type], accounts: [...g.accounts] });
  }

  // Credit used across the cards that have a limit. Available credit already counts loans paid from a card.
  const limited = archived ? [] : data.accounts.filter((a) => a.type === "credit_card" && a.credit_limit !== null && a.available_credit !== null);
  const limit = limited.reduce((sum, a) => sum + Number(a.credit_limit), 0);
  // Each card is clamped at 0, so an overpaid card doesn't cancel another's usage.
  const used = limited.reduce((sum, a) => sum + Math.max(0, Number(a.credit_limit) - Number(a.available_credit)), 0);
  const usedPercent = limit > 0 ? Math.max(0, Math.round((used * 100) / limit)) : null;

  return (
    <>
      {!archived && (
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Tile tone="yellow" emoji="💰" label="You have" value={formatRupees(data.total_have)}>
            {includedHint(data) ? <span className="mt-0.5 block text-xs font-extrabold break-words">{includedHint(data)}</span> : null}
          </Tile>
          <Tile tone="pink" emoji="🧾" label="You owe" value={formatRupees(data.total_owe)} />
          {usedPercent !== null ? (
            <div className="sm:col-span-2 lg:col-span-1">
              <Tile label="Credit used" emoji="💳" value={`${usedPercent}%`}>
                <ProgressBar percent={usedPercent} reached={false} warn={usedPercent >= 80} label="Credit used" className="mt-2" />
                <span className="mt-1.5 block text-xs font-extrabold break-words">
                  {formatRupees(used.toFixed(2))} of {formatRupees(limit.toFixed(2))}
                </span>
              </Tile>
            </div>
          ) : null}
        </div>
      )}

      {dueLines.length > 0 && (
        <ul aria-label="Due now" className="mb-6 flex flex-col gap-2.5">
          {dueLines.map((line) => (
            <li
              key={line.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border-[2.5px] border-ink bg-due px-4 py-2 text-sm font-extrabold shadow-chunky-sm"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span aria-hidden="true">⏰ </span>
                {line.text}
              </span>
              <button type="button" className={ROW_ACTION} onClick={line.run}>
                {line.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {groups.length === 0 ? (
        <div className={`${CARD} px-6 py-10 text-center`}>
          <p className="text-4xl" aria-hidden="true">
            {archived ? "📦" : "👛"}
          </p>
          {archived ? (
            <p className="mt-2 text-sm font-extrabold">No archived accounts.</p>
          ) : (
            <>
              <p className="mt-2 font-black">Add your first account</p>
              <p className="mt-1 text-sm font-bold text-zinc-600">
                Bank accounts, credit cards, cash, broker balances, wallets and loans all live here.
              </p>
              <button type="button" className={`${PRIMARY} mt-4`} onClick={onAdd}>
                + Add account
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {sections.map(({ key, title, accounts }) => (
            <section key={key} aria-labelledby={`group-${key}`}>
              <h2 id={`group-${key}`} className="mb-2 text-xs font-black tracking-wide uppercase">
                <span aria-hidden="true">{key === "deposits" ? "🐷" : accountEmoji(key)} </span>
                {title}
              </h2>
              <ul className="overflow-hidden rounded-[18px] border-[2.5px] border-ink bg-card shadow-chunky">
                {accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    onEdit={onEdit}
                    onArchive={onArchive}
                    onRestore={onRestore}
                    onRecordEmi={onRecordEmi}
                    onDeposit={onDeposit}
                    onCloseRd={onCloseRd}
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

function includedHint(data: AccountList): string | null {
  const investments = investmentsIn(data);
  return investments === null ? null : `Includes investments ${formatRupees(investments)}`;
}

function AccountRow({
  account,
  onEdit,
  onArchive,
  onRestore,
  onRecordEmi,
  onDeposit,
  onCloseRd,
}: {
  account: Account;
  onEdit: (account: Account) => void;
  onArchive: (account: Account) => void;
  onRestore: (account: Account) => Promise<void>;
  onRecordEmi: (loan: Account) => void;
  onDeposit: (account: Account, kind: "instalment" | "ppf-deposit" | "ppf-interest") => void;
  onCloseRd: (account: Account) => void;
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
  const figures = account.deposit;
  const lines = depositLines(account);
  const details = [
    account.institution && account.institution !== account.name ? account.institution : null,
    account.type === "bank" && account.bank_kind
      ? account.bank_kind.charAt(0).toUpperCase() + account.bank_kind.slice(1)
      : null,
    account.last4 ? maskLast4(account.last4) : null,
  ].filter(Boolean);

  const dueSoon =
    card && Number(account.balance) > 0 && account.due_day !== null && daysUntil(nextDueDate(account.due_day, today), today) <= SOON_DAYS;
  const freeText = freeBalanceText(account);
  const overText = overSetAsideText(account);

  return (
    <li
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b-[1.5px] border-zinc-200 px-4 py-3 last:border-b-0 ${dueSoon ? "bg-due" : ""}`}
    >
      <span
        aria-hidden="true"
        className={`inline-flex size-9 shrink-0 items-center justify-center rounded-[11px] border-[2.5px] border-ink text-lg ${dueSoon ? "bg-yellow" : "bg-zinc-100"}`}
      >
        {accountEmoji(account.type)}
      </span>
      <div className="min-w-32 flex-1">
        <p className="text-sm font-extrabold [overflow-wrap:anywhere]">
          {account.name}
          {account.in_goal && (
            <>
              {" "}
              <Link href={`/goals/${account.in_goal.id}`} className={`rounded text-xs font-bold text-zinc-600 underline ${FOCUS}`}>
                For: {account.in_goal.name}
              </Link>
            </>
          )}
        </p>
        {details.length > 0 && (
          <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{details.join(" · ")}</p>
        )}
        {lines.length > 0 && (
          <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{lines.join(" · ")}</p>
        )}
        {loanDetails.length > 0 && (
          <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{loanDetails.join(" · ")}</p>
        )}
        {dueSoon && account.due_day !== null && (
          <p className="mt-0.5 text-xs font-black [overflow-wrap:anywhere]">
            <span aria-hidden="true">⏰ </span>Due {formatDueDate(nextDueDate(account.due_day, today))}
          </p>
        )}
        {overText && (
          <p role="note" className="mt-1 text-xs font-extrabold text-loss [overflow-wrap:anywhere]">
            {overText}
          </p>
        )}
      </div>
      <div className="min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]">
        <p className="text-sm font-black">
          {owed && (
            <span className="mr-1.5 text-xs font-bold text-zinc-600">{paidOff ? "Paid off" : "Owed"}</span>
          )}
          {formatRupees(headlineBalance(account))}
        </p>
        {freeText && <p className="text-xs font-bold text-zinc-600">{freeText}</p>}
        {card && account.available_credit !== null && (
          <p className="text-xs font-bold text-zinc-600">
            Available <span className="tabular-nums">{formatRupees(account.available_credit)}</span>
          </p>
        )}
      </div>
      <div className="flex max-w-full flex-wrap gap-1.5">
        <Link href={`/transactions?account=${account.id}`} className={ROW_ACTION} aria-label={`Transactions for ${account.name}`}>
          Transactions
        </Link>
        {account.type === "broker" && (
          <Link href={`/investments?broker=${account.id}`} className={ROW_ACTION} aria-label={`Trades in ${account.name}`}>
            Trades
          </Link>
        )}
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
            {account.type === "ppf" && (
              <button type="button" className={ROW_ACTION} aria-label={`Deposit into ${account.name}`} onClick={() => onDeposit(account, "ppf-deposit")}>
                Deposit
              </button>
            )}
            {figures?.kind === "ppf" && figures.interest_due !== null && (
              <button type="button" className={ROW_ACTION} aria-label={`Record interest for ${account.name}`} onClick={() => onDeposit(account, "ppf-interest")}>
                Record interest
              </button>
            )}
            {figures?.kind === "rd" && figures.due.length > 0 && (
              <button type="button" className={ROW_ACTION} aria-label={`Record an instalment for ${account.name}`} onClick={() => onDeposit(account, "instalment")}>
                Record instalment
              </button>
            )}
            {account.type === "rd" && (
              <button type="button" className={ROW_ACTION} aria-label={`Close ${account.name}`} onClick={() => onCloseRd(account)}>
                Close RD
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
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <div className="px-5 py-4">
        <h2 id="archive-title" className="text-base font-black">
          Archive {account.name}?
        </h2>
        <p className="mt-2 text-sm font-bold text-zinc-600">
          It leaves your list and totals. Nothing is deleted, and you can restore it from the archived view.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t-[2.5px] border-ink px-5 py-3">
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
