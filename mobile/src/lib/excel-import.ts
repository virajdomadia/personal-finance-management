// Importing transactions or holdings from an Excel workbook. The server reads and checks the file;
// this only words its report. Mirrors ImportReport in backend/app/api/routes/imports.py and
// HoldingsReport in backend/app/api/routes/holdings_import.py, and frontend/src/lib/excel-import.ts.

import { formatRupees } from "./accounts.ts";
import { formatDate } from "./dates.ts";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// The server refuses a body over this (MAX_BYTES in backend/app/export/importing.py), so the app
// says so before sending it.
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const TOO_BIG = "The file is over 4 MB. Split it into smaller files.";

export function fileTooBig(size: number | null | undefined): boolean {
  return typeof size === "number" && size > MAX_FILE_BYTES;
}

// Whether a picked file's name ends in one of `extensions` (".xlsx", ...), ignoring case.
export function hasExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

// What can be imported from a workbook. Each has its own template and endpoints, and the same report.
export type ImportKind = "transactions" | "holdings";

type ImportConfig = {
  paths: { template: string; preview: string; import: string }; // through the API, which adds /api
  fallback: string; // the template's file name when the response doesn't give one
  noun: [one: string, many: string];
  title: string; // the screen's title
  templateTitle: string; // the share sheet's title for the template
};

export const IMPORTS: Record<ImportKind, ImportConfig> = {
  transactions: {
    paths: {
      template: "/import/transactions/template",
      preview: "/import/transactions/preview",
      import: "/import/transactions",
    },
    fallback: "pfm-transactions-template.xlsx",
    noun: ["transaction", "transactions"],
    title: "Import transactions",
    templateTitle: "Transactions template",
  },
  holdings: {
    paths: {
      template: "/import/holdings/template",
      preview: "/import/holdings/preview",
      import: "/import/holdings",
    },
    fallback: "pfm-holdings-template.xlsx",
    noun: ["holding", "holdings"],
    title: "Import holdings",
    templateTitle: "Holdings template",
  },
};

// The screen's `kind` param; anything else is a transactions import.
export function importKind(param: string | string[] | undefined): ImportKind {
  return param === "holdings" ? "holdings" : "transactions";
}

export type ImportStatus = "ok" | "duplicate" | "error";

// What every row of either report has.
export type BaseRow = {
  row: number; // the spreadsheet row number
  status: ImportStatus;
  errors: string[];
};

export type ImportRow = BaseRow & {
  date: string | null;
  type: string | null;
  amount: string | null;
  account: string | null;
  to_account: string | null;
  category: string | null;
  note: string | null;
};

// A stock, fund or coin already owned. Cells are as read; `invested` is the amount that will be stored.
export type HoldingRow = BaseRow & {
  type: string | null;
  name: string | null;
  symbol: string | null;
  account: string | null;
  quantity: string | null;
  invested: string | null;
  date: string | null;
};

export type ImportReport<R extends BaseRow = ImportRow> = {
  rows: R[];
  ok: number;
  duplicates: number;
  problems: number;
  imported: number;
};

// Only the counts: what the wording below needs, whichever kind of row.
type Counts = Pick<ImportReport<BaseRow>, "ok" | "duplicates" | "problems" | "imported">;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function noun(kind: ImportKind, count: number): string {
  const [one, many] = IMPORTS[kind].noun;
  return plural(count, one, many);
}

// The three counts above the rows, in the order people care about.
export function summaryCounts(report: Counts): { key: ImportStatus; label: string; count: number }[] {
  return [
    { key: "ok", label: "Ready to add", count: report.ok },
    { key: "duplicate", label: "Already saved", count: report.duplicates },
    { key: "error", label: "Problems", count: report.problems },
  ];
}

// One line under the counts saying what happens next.
export function previewSummary(report: Counts, kind: ImportKind = "transactions"): string {
  if (report.problems > 0) {
    return `Fix the ${plural(report.problems, "row")} with problems in the file, then choose it again. Nothing is added until every row is right.`;
  }
  if (report.ok === 0) {
    return report.duplicates > 0
      ? "Every row is already saved, so there's nothing new to add."
      : "There's nothing to add in this file.";
  }
  const skipped = report.duplicates > 0 ? ` ${plural(report.duplicates, "row")} already saved will be skipped.` : "";
  return `${noun(kind, report.ok)} ready to add.${skipped}`;
}

export function canImport(report: Counts | null): boolean {
  return report !== null && report.problems === 0 && report.ok > 0;
}

export function importButton(report: Counts | null, kind: ImportKind = "transactions"): string {
  return `Import ${noun(kind, report && report.problems === 0 ? report.ok : 0)}`;
}

// After a successful import.
export function importedMessage(report: Counts, kind: ImportKind = "transactions"): string {
  const skipped = report.duplicates > 0 ? ` Skipped ${plural(report.duplicates, "duplicate")} already saved.` : "";
  return `Added ${noun(kind, report.imported)}.${skipped}`;
}

export function statusLabel(status: ImportStatus): string {
  if (status === "ok") return "Ready";
  if (status === "duplicate") return "Already saved";
  return "Problem";
}

// "What to fix": every problem, as "Row 4: Account: no account called Nowhere."
export function problemLines(rows: BaseRow[]): string[] {
  return rows.filter((r) => r.status === "error").flatMap((r) => r.errors.map((e) => `Row ${r.row}: ${e}`));
}

// "Bank → Wallet" for a transfer, just "Bank" otherwise; a dash when the cell was empty.
export function accountsLabel(row: Pick<ImportRow, "account" | "to_account">): string {
  const from = row.account ?? "—";
  return row.to_account ? `${from} → ${row.to_account}` : from;
}

// Cells are shown as read: tidied when they're a plain date or number, otherwise as typed.
export function dateLabel(value: string | null): string {
  if (!value) return "—";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value) : value;
}

export function amountLabel(value: string | null): string {
  if (!value) return "—";
  return /^-?\d+(\.\d+)?$/.test(value) ? formatRupees(value) : value;
}

// "Infosys (INFY)", or whichever of the two was given.
export function holdingLabel(row: Pick<HoldingRow, "name" | "symbol">): string {
  if (row.name && row.symbol && row.name.toUpperCase() !== row.symbol.toUpperCase()) return `${row.name} (${row.symbol})`;
  return row.name ?? row.symbol ?? "—";
}

// A row card's lines: the title, the amount, and what else was read.
export function rowCard(kind: ImportKind, row: ImportRow | HoldingRow): { title: string; amount: string; meta: string } {
  if (kind === "holdings") {
    const h = row as HoldingRow;
    const meta = [h.type, h.quantity ? `${h.quantity} units` : null, h.account, h.date ? dateLabel(h.date) : null];
    return { title: holdingLabel(h), amount: amountLabel(h.invested), meta: meta.filter(Boolean).join(" · ") };
  }
  const t = row as ImportRow;
  const meta = [dateLabel(t.date), t.type, accountsLabel(t), t.category, t.note];
  return {
    title: t.category ?? t.note ?? t.type ?? "—",
    amount: amountLabel(t.amount),
    meta: meta.filter((part) => part && part !== "—").join(" · "),
  };
}

// A file-level failure (a 4xx with `{detail}`), worded for people. 401 is handled by logging out.
// Status 0 is a request that never reached the server; its detail already says so.
export function importError(status: number, detail: unknown): string {
  if (status === 401) return "You've been signed out. Sign in again to import.";
  if (status === 0 && typeof detail === "string" && detail) return detail;
  if (status >= 400 && status < 500) {
    if (typeof detail === "string" && detail) return detail;
    if (status === 413) return TOO_BIG;
  }
  return "The file couldn't be checked. Try again in a minute.";
}
