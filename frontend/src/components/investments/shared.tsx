"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type GoalTag, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Trade, formatPercent, formatSigned, tone } from "@/lib/investments";
import { formatDate } from "@/lib/transactions";

const BUTTON_BASE =
  "rounded-md px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none disabled:opacity-60";
export const PRIMARY = `${BUTTON_BASE} bg-zinc-900 font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`;
export const SECONDARY = `${BUTTON_BASE} border border-zinc-300 font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900`;
export const QUIET = `${BUTTON_BASE} text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800`;
export const ROW_ACTION =
  "rounded px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";
export const INPUT =
  "w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:opacity-60 aria-[invalid=true]:border-red-600 dark:border-zinc-700";
export const DIALOG =
  "m-auto rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";
export const SECTION_TITLE = "mb-1 px-1 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400";
export const LIST = "divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800";

// The active goal each instrument is in, from the per-account holdings (all of an instrument's rows
// carry the same tag, since a whole instrument goes in a goal).
export function goalsByInstrument<T extends { in_goal: GoalTag | null }>(rows: T[], id: (row: T) => number): Map<number, GoalTag> {
  const tags = new Map<number, GoalTag>();
  for (const row of rows) {
    if (row.in_goal) tags.set(id(row), row.in_goal);
  }
  return tags;
}

// "For: Bike", linking to the goal a holding is in.
export function GoalTagLink({ tag, className = "" }: { tag: GoalTag | null | undefined; className?: string }) {
  if (!tag) return null;
  return (
    <Link
      href={`/goals/${tag.id}`}
      className={`text-xs text-zinc-500 underline hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none dark:text-zinc-400 dark:hover:text-zinc-100 ${className}`}
    >
      For: {tag.name}
    </Link>
  );
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

const TONE_CLASS = {
  gain: "text-gain",
  loss: "text-loss",
  flat: "",
} as const;
const TONE_WORD = { gain: "gain", loss: "loss", flat: "no change" } as const;

// A profit or loss: always signed, green or red, and named for screen readers, so colour is
// never the only signal.
// `percentOnly` shows a percentage instead of rupees.
export function Signed({ value, percentOnly = false }: { value: string; percentOnly?: boolean }) {
  const t = tone(value);
  return (
    <span className={`tabular-nums ${TONE_CLASS[t]}`}>
      {percentOnly ? formatPercent(value) : formatSigned(value)}
      <span className="sr-only"> {TONE_WORD[t]}</span>
    </span>
  );
}

export function Notice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
    >
      {message}
    </p>
  );
}

export function tradeTitle(trade: Trade): string {
  if (trade.opening) return `Existing ${trade.quantity} ${trade.symbol}`;
  return `${trade.side === "buy" ? "Bought" : "Sold"} ${trade.quantity} ${trade.symbol}`;
}

export function sideLabel(trade: { side: "buy" | "sell"; opening: boolean }): string {
  return trade.opening ? "Add existing shares" : trade.side === "buy" ? "Buy" : "Sell";
}

// One trade in a list. Trades in an archived broker are locked until it's restored.
export function TradeRow({
  trade,
  archived,
  showAccount,
  onEdit,
  onDelete,
}: {
  trade: Trade;
  archived: boolean;
  showAccount: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const title = tradeTitle(trade);
  const details = [
    formatDate(trade.date),
    showAccount ? trade.account_name : null,
    `${trade.quantity} × ${formatRupees(trade.price)}`,
    trade.charges !== "0.00" ? `${formatRupees(trade.charges)} charges` : null,
    trade.note,
  ].filter(Boolean);
  const cash = trade.opening ? "Cost" : trade.side === "buy" ? "Paid" : "Received";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-32 flex-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{title}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">{details.join(" · ")}</p>
      </div>
      <div className="min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]">
        <p className="text-sm font-medium">
          <span className="mr-1.5 text-xs font-normal text-zinc-500 dark:text-zinc-400">{cash}</span>
          {formatRupees(trade.amount)}
        </p>
        {trade.realised !== null && (
          <p className="text-xs">
            <span className="text-zinc-500 dark:text-zinc-400">P&amp;L </span>
            <Signed value={trade.realised} />
          </p>
        )}
      </div>
      <div className="flex w-24 shrink-0 justify-end gap-1">
        {archived ? (
          <span className="px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400">Archived</span>
        ) : (
          <>
            <button type="button" className={ROW_ACTION} aria-label={`Edit ${title}, ${trade.date}`} onClick={onEdit}>
              Edit
            </button>
            <button type="button" className={ROW_ACTION} aria-label={`Delete ${title}, ${trade.date}`} onClick={onDelete}>
              Delete
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export function archivedIds(archived: Account[]): Set<number> {
  return new Set(archived.map((a) => a.id));
}

// "Delete this?" with Cancel and Delete, as on the accounts and transactions screens.
export function ConfirmDelete({
  title,
  body,
  path,
  onClose,
  onDone,
}: {
  title: string;
  body: string;
  path: string;
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
      await apiFetch(path, { method: "DELETE" });
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
      className={`${DIALOG} w-[min(26rem,calc(100vw-2rem))]`}
    >
      <div className="px-5 py-4">
        <h2 id="delete-title" className="text-base font-semibold">
          {title}
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
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

export function tradeDeleteText(trade: Trade): { title: string; body: string } {
  return {
    title: `Delete ${tradeTitle(trade)} on ${formatDate(trade.date)}?`,
    body: trade.opening
      ? "It's removed for good, and the holding shrinks. This can't be undone."
      : `It's removed for good, and ${trade.account_name}'s cash moves back. This can't be undone.`,
  };
}
