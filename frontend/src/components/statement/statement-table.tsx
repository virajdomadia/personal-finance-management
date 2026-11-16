"use client";

import { FOCUS, TABLE, TD, TD_NUM, TH } from "@/components/ui/chunky";
import type { Account } from "@/lib/accounts";
import { formatDate } from "@/lib/transactions";
import {
  type LineType,
  type Row,
  canKeep,
  categoryOptions,
  changeType,
  offersRemember,
  signedAmount,
  transferLabel,
  typeOptions,
} from "@/lib/statement-import";

// A native select: light enough for hundreds of rows, and it opens the phone's own picker.
const PICK = `w-full min-w-32 rounded-[12px] border-[2.5px] border-ink bg-card px-2 py-1.5 text-xs font-extrabold outline-none disabled:opacity-60 aria-[invalid=true]:border-loss ${FOCUS}`;
const BOX = `size-5 shrink-0 cursor-pointer accent-ink disabled:cursor-not-allowed ${FOCUS}`;
const BADGE = "inline-block rounded-full border-[1.5px] border-ink px-2 text-[11px] font-black whitespace-nowrap";

type Props = {
  rows: Row[];
  categories: { income: string[]; expense: string[] };
  others: Account[]; // the accounts a transfer can go to or come from
  lineErrors: Map<number, string[]>;
  disabled: boolean;
  onChange: (line: number, next: Row) => void;
};

// One row per statement line. Scrolls inside its own box, so the page never scrolls sideways.
export function StatementTable({ rows, categories, others, lineErrors, disabled, onChange }: Props) {
  return (
    <div className="max-h-[40rem] overflow-auto pb-1" tabIndex={0} role="region" aria-label="Lines in the statement">
      <table className={`${TABLE} min-w-[52rem]`}>
        <caption className="sr-only">Each line of the statement, with what it will be saved as</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              <span className="sr-only">Import</span>
            </th>
            <th scope="col" className={TH}>
              Date
            </th>
            <th scope="col" className={TH}>
              Details
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Amount
            </th>
            <th scope="col" className={TH}>
              Type
            </th>
            <th scope="col" className={TH}>
              Category or account
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <LineRow
              key={row.line.line}
              row={row}
              categories={categories}
              others={others}
              saveErrors={lineErrors.get(row.line.line) ?? []}
              disabled={disabled}
              onChange={(next) => onChange(row.line.line, next)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineRow({
  row,
  categories,
  others,
  saveErrors,
  disabled,
  onChange,
}: {
  row: Row;
  categories: { income: string[]; expense: string[] };
  others: Account[];
  saveErrors: string[];
  disabled: boolean;
  onChange: (next: Row) => void;
}) {
  const { line } = row;
  const n = line.line;
  const keepable = canKeep(line);
  const problem = !keepable || saveErrors.length > 0;
  const off = disabled || !row.include || !keepable;
  const transfer = row.type === "transfer";
  const missing = row.include && transfer && row.other === "";
  const tone = problem ? "bg-pink/10" : row.include ? undefined : "bg-zinc-50 text-zinc-600";

  return (
    <tr className={tone}>
      <td className={`${TD} align-top`}>
        <input
          type="checkbox"
          className={BOX}
          checked={row.include && keepable}
          disabled={disabled || !keepable}
          aria-label={`Import line ${n}`}
          aria-describedby={`line-${n}-details`}
          onChange={(e) => onChange({ ...row, include: e.target.checked })}
        />
      </td>
      <td className={`${TD} align-top whitespace-nowrap`}>{formatDate(line.date)}</td>
      <td id={`line-${n}-details`} className={`${TD} max-w-80 min-w-56 align-top`}>
        {line.payee ? <p className="font-black [overflow-wrap:anywhere]">{line.payee}</p> : null}
        <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{line.narration || "—"}</p>
        {line.duplicate ? <span className={`${BADGE} mt-1 bg-zinc-100`}>Already saved</span> : null}
        {!keepable ? (
          <p className="mt-1 text-xs font-extrabold text-loss">
            <span className={`${BADGE} mr-1 bg-pink-strong text-white`}>Can&apos;t import</span>
            {line.errors.join(" ")}
          </p>
        ) : null}
        {saveErrors.length > 0 ? (
          <p role="alert" className="mt-1 text-xs font-extrabold text-loss">
            {saveErrors.join(" ")}
          </p>
        ) : null}
      </td>
      <td className={`${TD_NUM} align-top font-black whitespace-nowrap ${line.direction === "out" ? "text-loss" : "text-gain"}`}>
        {signedAmount(line)}
      </td>
      <td className={`${TD} align-top`}>
        <select
          className={PICK}
          value={row.type}
          disabled={off}
          aria-label={`Type for line ${n}`}
          onChange={(e) => onChange(changeType(row, e.target.value as LineType))}
        >
          {typeOptions(line.direction).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </td>
      <td className={`${TD} min-w-48 align-top`}>
        {transfer ? (
          <label className="flex items-center gap-2">
            <span className="text-xs font-black">{transferLabel(line.direction)}</span>
            <select
              className={PICK}
              value={row.other}
              disabled={off}
              aria-label={`${transferLabel(line.direction)} account for line ${n}`}
              aria-invalid={missing || undefined}
              onChange={(e) => onChange({ ...row, other: e.target.value })}
            >
              <option value="">Choose an account</option>
              {others.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <select
            className={PICK}
            value={row.category}
            disabled={off}
            aria-label={`Category for line ${n}`}
            onChange={(e) => onChange({ ...row, category: e.target.value })}
          >
            <option value="">No category</option>
            {categoryOptions(row, categories).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {offersRemember(row) && !off ? (
          <label className="mt-1.5 flex items-center gap-1.5 text-xs font-bold">
            <input
              type="checkbox"
              className="size-4 cursor-pointer accent-ink"
              checked={row.remember}
              disabled={disabled}
              onChange={(e) => onChange({ ...row, remember: e.target.checked })}
            />
            Remember for {line.payee}
          </label>
        ) : null}
      </td>
    </tr>
  );
}
