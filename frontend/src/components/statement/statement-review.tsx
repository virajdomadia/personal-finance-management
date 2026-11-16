"use client";

import { useState } from "react";

import { Chip, buttonClass } from "@/components/ui/chunky";
import type { Account } from "@/lib/accounts";
import {
  type Row,
  type RowFilter,
  canSave,
  counts,
  filterOptions,
  importButton,
  missingTransfers,
  selectAllNew,
  selectNone,
  summaryText,
  visibleRows,
} from "@/lib/statement-import";

import { StatementTable } from "./statement-table";

// Step 2 and 3: check each line, then import the ticked ones.
export function StatementReview({
  rows,
  categories,
  others,
  lineErrors,
  saving,
  onRows,
  onImport,
}: {
  rows: Row[];
  categories: { income: string[]; expense: string[] };
  others: Account[];
  lineErrors: Map<number, string[]>;
  saving: boolean;
  onRows: (rows: Row[]) => void;
  onImport: () => void;
}) {
  const [filter, setFilter] = useState<RowFilter>("all");
  const shown = visibleRows(rows, filter);
  const c = counts(rows);
  const missing = missingTransfers(rows);

  const change = (line: number, next: Row) => onRows(rows.map((r) => (r.line.line === line ? next : r)));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass("alt")} disabled={saving} onClick={() => onRows(selectAllNew(rows))}>
          Select all new
        </button>
        <button type="button" className={buttonClass("alt")} disabled={saving} onClick={() => onRows(selectNone(rows))}>
          Select none
        </button>
      </div>
      <div role="group" aria-label="Lines to show" className="flex flex-wrap gap-2">
        {filterOptions(rows).map((o) => (
          <Chip key={o.value} selected={filter === o.value} onClick={() => setFilter(o.value)}>
            {o.label}
          </Chip>
        ))}
      </div>

      {shown.length > 0 ? (
        <StatementTable
          rows={shown}
          categories={categories}
          others={others}
          lineErrors={lineErrors}
          disabled={saving}
          onChange={change}
        />
      ) : (
        <p className="rounded-[14px] border-[2.5px] border-dashed border-ink px-3 py-3 text-sm font-bold text-zinc-600">
          No lines here.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border-[2.5px] border-ink bg-yellow px-4 py-3 shadow-chunky">
        <div className="min-w-0">
          <p role="status" className="text-sm font-black tabular-nums">
            {summaryText(c)}
          </p>
          {missing > 0 ? (
            <p className="text-xs font-extrabold text-loss">
              Choose the other account for {missing === 1 ? "1 transfer" : `${missing} transfers`}, or untick{" "}
              {missing === 1 ? "it" : "them"}.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className={buttonClass("green")}
          disabled={saving || !canSave(rows)}
          aria-busy={saving}
          onClick={onImport}
        >
          {saving ? "Importing…" : importButton(c)}
        </button>
      </div>
    </div>
  );
}
