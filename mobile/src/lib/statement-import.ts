// Importing a bank or card statement into one account. The server reads the file and suggests a
// type, category and transfer for each line; this keeps the owner's edits and builds what is saved.
// Mirrors backend/app/api/routes/statement_import.py and frontend/src/lib/statement-import.ts.

import { type Account, type AccountType, formatRupees } from "./accounts.ts";
import type { CategoryTree } from "./categories.ts";

export type Direction = "out" | "in";
export type LineType = "expense" | "income" | "transfer";

export type StatementLine = {
  line: number; // the row in the file
  date: string;
  narration: string;
  amount: string;
  direction: Direction;
  balance: string | null;
  payee: string | null;
  type: LineType; // the suggestion
  category: string | null; // the suggestion
  other_account_id: number | null; // the suggestion
  duplicate: boolean; // already saved in this account
  errors: string[]; // a line that couldn't be read; it can't be kept
};

export type StatementPreview = {
  account_id: number;
  lines: StatementLine[];
  new: number;
  duplicates: number;
  problems: number;
};

export type SaveResult = {
  imported: number;
  rules_saved: number;
  errors: { line: number; errors: string[] }[];
};

// A line as the owner has it now. `category` "" is no category; `other` "" is no account chosen.
export type Row = {
  line: StatementLine;
  include: boolean;
  type: LineType;
  category: string;
  other: string;
  remember: boolean;
};

export type RowFilter = "all" | "uncategorised" | "transfers" | "duplicates";

export const SAVE_PATH = "/import/statement"; // through the API, which adds /api
export const PASSWORD_HEADER = "X-File-Password";
export const EXTENSIONS = [".csv", ".xls", ".xlsx", ".pdf"];
export const WRONG_FILE = "Choose a CSV, Excel (.xls or .xlsx) or PDF statement.";
// What the system picker offers. CSVs come as text/* on some phones, and some banks' .xls is HTML.
export const PICKER_TYPES = [
  "text/*",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
  "application/octet-stream",
];

// Mirrors STATEMENT_TYPES in the route.
const STATEMENT_TYPES = new Set<AccountType>(["bank", "credit_card", "cash", "wallet", "broker"]);

export function statementAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => STATEMENT_TYPES.has(a.type) && !a.archived);
}

// The other side of a transfer: any other active account.
export function otherAccounts(accounts: Account[], accountId: number): Account[] {
  return accounts.filter((a) => a.id !== accountId && !a.archived);
}

export function previewPath(accountId: number): string {
  return `/import/statement/preview?account_id=${accountId}`;
}

// The file goes as itself; a picker that can't name its type sends it as plain bytes.
export function fileType(mimeType: string | null | undefined): string {
  return mimeType || "application/octet-stream";
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const canKeep = (line: StatementLine) => line.errors.length === 0;

// New lines start ticked; lines already saved, and lines that couldn't be read, start unticked.
export function initialRows(preview: StatementPreview): Row[] {
  return preview.lines.map((line) => ({
    line,
    include: canKeep(line) && !line.duplicate,
    type: line.type,
    category: line.category ?? "",
    other: line.other_account_id === null ? "" : String(line.other_account_id),
    remember: false,
  }));
}

export function typeOptions(direction: Direction): { value: LineType; label: string }[] {
  return [
    direction === "out" ? { value: "expense", label: "Expense" } : { value: "income", label: "Income" },
    { value: "transfer", label: "Transfer" },
  ];
}

export function transferLabel(direction: Direction): string {
  return direction === "out" ? "To" : "From";
}

// Switching back to the suggested type brings back its suggestion; another type starts empty.
export function changeType(row: Row, type: LineType): Row {
  const suggested = type === row.line.type;
  return {
    ...row,
    type,
    category: suggested ? (row.line.category ?? "") : "",
    other: suggested && row.line.other_account_id !== null ? String(row.line.other_account_id) : "",
  };
}

// The category or transfer differs from what the server suggested.
export function changedFromSuggestion(row: Row): boolean {
  if (row.type !== row.line.type) return true;
  if (row.type === "transfer") return row.other !== (row.line.other_account_id === null ? "" : String(row.line.other_account_id));
  return row.category !== (row.line.category ?? "");
}

// "Remember for this payee" is offered once the owner has corrected a line with a payee.
export function offersRemember(row: Row): boolean {
  return row.line.payee !== null && row.line.payee !== "" && changedFromSuggestion(row);
}

// Each kind's live category names, from GET /categories (the transaction form's list).
export function categoryNames(tree: CategoryTree): { income: string[]; expense: string[] } {
  const live = (list: CategoryTree["income"]) => list.filter((c) => !c.archived).map((c) => c.name);
  return { income: live(tree.income), expense: live(tree.expense) };
}

// The kind's categories, plus the suggested or chosen one if the list doesn't have it.
export function categoryOptions(row: Row, categories: { income: string[]; expense: string[] }): string[] {
  if (row.type === "transfer") return [];
  const list = categories[row.type];
  return row.category && !list.includes(row.category) ? [row.category, ...list] : list;
}

export function selectAllNew(rows: Row[]): Row[] {
  return rows.map((r) => {
    const include = canKeep(r.line) && !r.line.duplicate;
    return r.include === include ? r : { ...r, include };
  });
}

export function selectNone(rows: Row[]): Row[] {
  return rows.map((r) => (r.include ? { ...r, include: false } : r));
}

export function visibleRows(rows: Row[], filter: RowFilter): Row[] {
  if (filter === "uncategorised") return rows.filter((r) => canKeep(r.line) && r.type !== "transfer" && r.category === "");
  if (filter === "transfers") return rows.filter((r) => r.type === "transfer");
  if (filter === "duplicates") return rows.filter((r) => r.line.duplicate);
  return rows;
}

export function filterOptions(rows: Row[]): { value: RowFilter; label: string }[] {
  const n = (f: RowFilter) => visibleRows(rows, f).length;
  return [
    { value: "all", label: `All (${rows.length})` },
    { value: "uncategorised", label: `Needs a category (${n("uncategorised")})` },
    { value: "transfers", label: `Transfers (${n("transfers")})` },
    { value: "duplicates", label: `Already saved (${n("duplicates")})` },
  ];
}

export type Counts = { toImport: number; alreadySaved: number; skipped: number };

// Every line lands in one count: ticked, a duplicate left out, or anything else left out.
export function counts(rows: Row[]): Counts {
  let toImport = 0;
  let alreadySaved = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.include && canKeep(r.line)) toImport += 1;
    else if (r.line.duplicate && canKeep(r.line)) alreadySaved += 1;
    else skipped += 1;
  }
  return { toImport, alreadySaved, skipped };
}

export function summaryText(c: Counts): string {
  return `${c.toImport} to import · ${c.alreadySaved} already saved · ${c.skipped} skipped`;
}

export function importButton(c: Counts): string {
  return `Import ${plural(c.toImport, "transaction")}`;
}

// A ticked transfer needs its other account before it can be saved.
export function missingTransfers(rows: Row[]): number {
  return rows.filter((r) => r.include && canKeep(r.line) && r.type === "transfer" && r.other === "").length;
}

export function canSave(rows: Row[]): boolean {
  return counts(rows).toImport > 0 && missingTransfers(rows) === 0;
}

// Under the import button when it can't be pressed for a missing transfer account.
export function missingTransfersText(count: number): string | null {
  if (count === 0) return null;
  return `Choose the other account for ${plural(count, "transfer")} before importing.`;
}

// The line under a card's narration: what will be saved.
export function rowSummary(row: Row, accountName: (id: string) => string | null): string {
  if (row.type === "transfer") {
    const other = row.other === "" ? "choose an account" : (accountName(row.other) ?? "another account");
    return `Transfer · ${transferLabel(row.line.direction)} ${other}`;
  }
  const type = row.type === "expense" ? "Expense" : "Income";
  return `${type} · ${row.category === "" ? "No category" : row.category}`;
}

export type SaveLine = {
  line: number;
  date: string;
  narration: string;
  amount: string;
  direction: Direction;
  type: LineType;
  category: string | null;
  other_account_id: number | null;
  payee: string | null;
  remember: boolean;
};

// The body for POST /import/statement: the ticked lines as edited.
export function savePayload(accountId: number, rows: Row[]): { account_id: number; lines: SaveLine[] } {
  const lines = rows
    .filter((r) => r.include && canKeep(r.line))
    .map((r) => {
      const transfer = r.type === "transfer";
      return {
        line: r.line.line,
        date: r.line.date,
        narration: r.line.narration,
        amount: r.line.amount,
        direction: r.line.direction,
        type: r.type,
        category: transfer || r.category === "" ? null : r.category,
        other_account_id: transfer && r.other !== "" ? Number(r.other) : null,
        payee: r.line.payee,
        remember: r.remember && offersRemember(r),
      };
    });
  return { account_id: accountId, lines };
}

export function savedMessage(result: SaveResult): string {
  const rules = result.rules_saved > 0 ? ` Saved ${plural(result.rules_saved, "payee rule")}.` : "";
  return `Added ${plural(result.imported, "transaction")}.${rules}`;
}

// The save's per-line problems, by line number. Nothing was saved when there are any.
export function errorsByLine(result: SaveResult): Map<number, string[]> {
  return new Map(result.errors.map((e) => [e.line, e.errors]));
}

export function saveErrorsBanner(result: SaveResult): string {
  return `Nothing was saved. Fix the ${plural(result.errors.length, "line")} marked below, or untick them, and import again.`;
}

// Money out reads -₹500.00, money in +₹500.00, as elsewhere in the app.
export function signedAmount(line: Pick<StatementLine, "amount" | "direction">): string {
  return `${line.direction === "out" ? "-" : "+"}${formatRupees(line.amount)}`;
}

export type PreviewFailure =
  | { kind: "password"; wrong: boolean; message: string }
  | { kind: "error"; message: string };

function asObject(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
}

// A failed preview, worded for people; a locked PDF asks for its password instead. `body` is the
// error body as JSON (undefined when it wasn't). Status 0 never reached the server. 401 logs out.
export function previewFailure(status: number, body: unknown): PreviewFailure {
  if (status === 401) return { kind: "error", message: "You've been signed out. Sign in again to import." };
  const parsed = asObject(body);
  const detail = typeof parsed?.detail === "string" && parsed.detail ? parsed.detail : null;
  if (status === 0) return { kind: "error", message: detail ?? "Couldn't reach the server. Check your connection and try again." };
  if (status === 422 && parsed?.needs_password === true) {
    const wrong = parsed.wrong_password === true;
    return {
      kind: "password",
      wrong,
      message: wrong ? "That password didn't open it. Try again." : (detail ?? "This file is locked with a password."),
    };
  }
  if (status === 404) return { kind: "error", message: "That account wasn't found. Choose it again." };
  if (status === 413) return { kind: "error", message: detail ?? "The file is over 4 MB. Split it into smaller files." };
  if (status >= 400 && status < 500 && detail) return { kind: "error", message: detail };
  return { kind: "error", message: "The file couldn't be checked. Try again in a minute." };
}

// A header carries only plain printable characters, so a password with others can't be sent.
export function passwordProblem(password: string): string | null {
  if (password === "") return "Type the file's password.";
  return /^[\x20-\x7e]+$/.test(password) ? null : "The password can only use plain letters, numbers and symbols.";
}
