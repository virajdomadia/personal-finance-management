// Importing transactions from an Excel workbook on the Your data page. The server reads and checks
// the file; this only words its report. Mirrors ImportReport in backend/app/api/routes/imports.py.

import { formatRupees } from "./accounts.ts";
import { formatDate } from "./transactions.ts";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const IMPORT_PATHS = {
  template: "/api/import/transactions/template",
  preview: "/api/import/transactions/preview",
  import: "/api/import/transactions",
} as const;
export const TEMPLATE_FALLBACK = "pfm-transactions-template.xlsx";

export type ImportStatus = "ok" | "duplicate" | "error";

export type ImportRow = {
  row: number; // the spreadsheet row number
  date: string | null;
  type: string | null;
  amount: string | null;
  account: string | null;
  to_account: string | null;
  category: string | null;
  note: string | null;
  status: ImportStatus;
  errors: string[];
};

export type ImportReport = {
  rows: ImportRow[];
  ok: number;
  duplicates: number;
  problems: number;
  imported: number;
};

export type RowFilter = "all" | "problems";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// The three counts above the table, in the order people care about.
export function summaryCounts(report: ImportReport): { key: ImportStatus; label: string; count: number }[] {
  return [
    { key: "ok", label: "Ready to add", count: report.ok },
    { key: "duplicate", label: "Already saved, skipped", count: report.duplicates },
    { key: "error", label: "With problems", count: report.problems },
  ];
}

// One line under the counts saying what happens next.
export function previewSummary(report: ImportReport): string {
  if (report.problems > 0) {
    return `Fix the ${plural(report.problems, "row")} with problems in the file, then choose it again. Nothing is added until every row is right.`;
  }
  if (report.ok === 0) {
    return report.duplicates > 0
      ? "Every row is already saved, so there's nothing new to add."
      : "There's nothing to add in this file.";
  }
  const skipped = report.duplicates > 0 ? ` ${plural(report.duplicates, "row")} already saved will be skipped.` : "";
  return `${plural(report.ok, "transaction")} ready to add.${skipped}`;
}

export function canImport(report: ImportReport | null): boolean {
  return report !== null && report.problems === 0 && report.ok > 0;
}

export function importButton(report: ImportReport | null): string {
  return `Import ${plural(report && report.problems === 0 ? report.ok : 0, "transaction")}`;
}

// After a successful import.
export function importedMessage(report: ImportReport): string {
  const skipped = report.duplicates > 0 ? ` Skipped ${plural(report.duplicates, "duplicate")} already saved.` : "";
  return `Added ${plural(report.imported, "transaction")}.${skipped}`;
}

export function statusLabel(status: ImportStatus): string {
  if (status === "ok") return "Ready";
  if (status === "duplicate") return "Already saved";
  return "Problem";
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

export function visibleRows(rows: ImportRow[], filter: RowFilter): ImportRow[] {
  return filter === "problems" ? rows.filter((r) => r.status === "error") : rows;
}

// A file-level failure (a 4xx with `{detail}`), worded for people. 401 is handled by logging out.
export function importError(status: number, body: string): string {
  if (status === 401) return "You've been signed out. Sign in again to import.";
  if (status >= 400 && status < 500) {
    try {
      const detail = (JSON.parse(body) as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail) return detail;
    } catch {
      // not JSON: fall through
    }
    if (status === 413) return "The file is over 4 MB. Split it into smaller files.";
  }
  return "The file couldn't be checked. Try again in a minute.";
}
