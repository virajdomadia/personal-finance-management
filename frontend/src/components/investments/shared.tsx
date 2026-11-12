"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type GoalTag, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Trade, formatPercent, formatSigned, tone } from "@/lib/investments";
import { formatDate } from "@/lib/transactions";
import { FOCUS, TABLE, TD, TD_NUM, TH, buttonClass } from "@/components/ui/chunky";

export const PRIMARY = `${buttonClass("primary")} uppercase`;
export const SECONDARY = `${buttonClass("alt")} uppercase`;
export const QUIET = `${buttonClass("alt")} uppercase`;
export const BUY = `${buttonClass("green")} uppercase`;
export const SELL = `${buttonClass("pink")} uppercase`;
export const ROW_ACTION = `${buttonClass("alt")} !px-2.5 !py-1 uppercase`;
export const INPUT = `w-full rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold outline-none disabled:opacity-60 aria-[invalid=true]:border-loss aria-[invalid=true]:bg-pink/10 ${FOCUS}`;
export const DIALOG =
  "m-auto overflow-hidden rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60";
export const SECTION_TITLE = "mb-2 px-1 text-xs font-black tracking-wider uppercase";
export const LIST = "overflow-hidden rounded-[18px] border-[2.5px] border-ink bg-card shadow-chunky [&>li]:border-b-[1.5px] [&>li]:border-zinc-200 [&>li:last-child]:border-b-0";

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
      className={`text-xs font-extrabold text-zinc-700 underline hover:text-ink ${FOCUS} rounded ${className}`}
    >
      For: {tag.name}
    </Link>
  );
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

const TONE_CLASS = {
  gain: "text-gain font-black",
  loss: "text-loss font-black",
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

// A gain or loss written plainly, for coloured tiles where the green and red text tokens would not read.
export function PlainSigned({ value, percent }: { value: string; percent?: string }) {
  const t = tone(value);
  return (
    <>
      {formatSigned(value)}
      {percent !== undefined ? ` (${formatPercent(percent)})` : ""}
      <span className="sr-only"> {TONE_WORD[t]}</span>
    </>
  );
}

// Marks a price the nightly fetch recorded, as opposed to one typed in.
export function AutoBadge() {
  return (
    <span className="ml-2 rounded-full border-[1.5px] border-ink bg-yellow px-2 py-px text-[11px] font-black text-ink">auto</span>
  );
}

export function Notice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-4 rounded-[14px] border-[2.5px] border-ink bg-pink/20 px-3 py-2 text-sm font-extrabold shadow-chunky-sm"
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

// One trade as a table row. Trades in an archived broker are locked until it's restored.
export function TradeTr({
  title,
  date,
  details,
  cashLabel,
  amount,
  realised,
  archived,
  onEdit,
  onDelete,
}: {
  title: string;
  date: string;
  details: (string | null)[];
  cashLabel: string;
  amount: string;
  realised: string | null;
  archived: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td className={`${TD} whitespace-nowrap`}>{formatDate(date)}</td>
      <td className={`${TD} min-w-32 [overflow-wrap:anywhere]`}>
        <span className="block tabular-nums">{title}</span>
        <span className="block text-xs font-bold text-zinc-600">{details.filter(Boolean).join(" · ")}</span>
      </td>
      <td className={TD_NUM}>
        <span className="mr-1.5 text-xs font-bold text-zinc-600">{cashLabel}</span>
        <span className="whitespace-nowrap">{formatRupees(amount)}</span>
        {realised !== null && (
          <span className="block text-xs">
            <span className="font-bold text-zinc-600">P&amp;L </span>
            <Signed value={realised} />
          </span>
        )}
      </td>
      <td className={`${TD} w-px`}>
        <div className="flex justify-end gap-1.5">
          {archived ? (
            <span className="px-2 py-1 text-xs font-bold text-zinc-600">Archived</span>
          ) : (
            <>
              <button type="button" className={ROW_ACTION} aria-label={`Edit ${title}, ${date}`} onClick={onEdit}>
                Edit
              </button>
              <button type="button" className={ROW_ACTION} aria-label={`Delete ${title}, ${date}`} onClick={onDelete}>
                Delete
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

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
  return (
    <TradeTr
      title={tradeTitle(trade)}
      date={trade.date}
      details={[
        showAccount ? trade.account_name : null,
        `${trade.quantity} × ${formatRupees(trade.price)}`,
        trade.charges !== "0.00" ? `${formatRupees(trade.charges)} charges` : null,
        trade.note,
      ]}
      cashLabel={trade.opening ? "Cost" : trade.side === "buy" ? "Paid" : "Received"}
      amount={trade.amount}
      realised={trade.realised}
      archived={archived}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

// A trades table; the rows are TradeTr.
export function TradesTable({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto pb-1">
      <table className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              Date
            </th>
            <th scope="col" className={TH}>
              Trade
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Amount
            </th>
            <th scope="col" className={`${TH} w-px`}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function BackLink() {
  return (
    <Link href="/investments" className={`${buttonClass("alt")} mb-4 !px-3 !py-1.5 uppercase`}>
      ‹ Investments
    </Link>
  );
}

// A small line of the price over time, only worth drawing from two points. Points are newest first
// (as the API returns them); the line runs oldest to newest.
export function PriceLine({ points, label }: { points: { date: string; value: number }[]; label: string }) {
  if (points.length < 2) return null;
  const pts = [...points].reverse();
  const values = pts.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 600;
  const h = 120;
  const pad = 10;
  const xy = pts.map((p, i) => [pad + (i * (w - 2 * pad)) / (pts.length - 1), h - pad - ((p.value - min) / span) * (h - 2 * pad)]);
  const up = values[values.length - 1] >= values[0];
  const last = xy[xy.length - 1];
  const first = pts[0];
  const end = pts[pts.length - 1];
  return (
    <figure className="mt-2">
      <div className="relative">
        <svg
          role="img"
          aria-label={`${label}, ${formatDate(first.date)} to ${formatDate(end.date)}`}
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="h-28 w-full"
        >
          <polyline
            points={xy.map((p) => p.join(",")).join(" ")}
            fill="none"
            stroke="#1a1a1a"
            strokeWidth="3.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span
          aria-hidden="true"
          className={`absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-ink ${up ? "bg-green" : "bg-pink"}`}
          style={{ left: `${(last[0] / w) * 100}%`, top: `${(last[1] / h) * 100}%` }}
        />
      </div>
      <figcaption className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs font-extrabold text-zinc-700">
        <span>{label}</span>
        <span>
          {formatDate(first.date)} – {formatDate(end.date)}
        </span>
      </figcaption>
    </figure>
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
      <h2 id="delete-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black [overflow-wrap:anywhere]">
        {title}
      </h2>
      <p className="px-5 py-4 text-sm font-bold text-zinc-700">{body}</p>
      <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
        <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className={SELL} disabled={saving} onClick={confirm}>
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

// The current price (or NAV) with its line, when there are enough points to draw one.
export function PriceCard({
  label,
  value,
  sub,
  points,
  lineLabel,
}: {
  label: string;
  value: string;
  sub: string;
  points: { date: string; value: number }[];
  lineLabel: string;
}) {
  return (
    <div className="min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky">
      <p className="text-xs font-extrabold">{label}</p>
      <p className="mt-0.5 text-[22px] leading-tight font-black tabular-nums [overflow-wrap:anywhere]">{value}</p>
      <p className="text-xs font-bold text-zinc-600">{sub}</p>
      <PriceLine points={points} label={lineLabel} />
    </div>
  );
}
