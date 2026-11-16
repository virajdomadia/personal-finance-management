"use client";

import { type ChangeEvent, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { Notice } from "@/components/investments/shared";
import { FOCUS, Segmented, TABLE, TD, TD_NUM, TH, buttonClass } from "@/components/ui/chunky";
import { downloadError } from "@/lib/data-export";
import {
  IMPORT_PATHS,
  type ImportReport,
  type ImportRow,
  type ImportStatus,
  type RowFilter,
  TEMPLATE_FALLBACK,
  XLSX_TYPE,
  accountsLabel,
  amountLabel,
  canImport,
  dateLabel,
  importButton,
  importError,
  importedMessage,
  previewSummary,
  statusLabel,
  summaryCounts,
  visibleRows,
} from "@/lib/excel-import";

import { saveDownload } from "./download";

type Busy = "template" | "checking" | "importing" | null;

class ImportFailed extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// The file goes as the raw request body (not a form upload), through the /api proxy like downloads.
async function send(path: string, file: File): Promise<ImportReport> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      body: file,
      headers: { "Content-Type": XLSX_TYPE },
      cache: "no-store",
    });
  } catch {
    throw new ImportFailed("Couldn't reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) throw new ImportFailed(importError(res.status, await res.text().catch(() => "")), res.status);
  return (await res.json()) as ImportReport;
}

const COUNT_TONE: Record<ImportStatus, string> = {
  ok: "bg-green/20",
  duplicate: "bg-zinc-100",
  error: "bg-pink/20",
};

const STATUS_BADGE: Record<ImportStatus, string> = {
  ok: "bg-green/20",
  duplicate: "bg-zinc-100",
  error: "bg-pink-strong text-white",
};

export function ExcelImport() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [filter, setFilter] = useState<RowFilter>("all");

  const fail = (err: unknown) => {
    if (err instanceof ImportFailed && err.status === 401) void logout();
    setError(err instanceof Error && err.message ? err.message : importError(0, ""));
  };

  const clearPicker = () => {
    setFile(null);
    if (input.current) input.current.value = "";
  };

  const template = () => {
    setBusy("template");
    setError(null);
    saveDownload(IMPORT_PATHS.template, TEMPLATE_FALLBACK)
      .catch((err: Error & { status?: number }) => {
        if (err.status === 401) void logout();
        setError(err.message || downloadError(0));
      })
      .finally(() => setBusy(null));
  };

  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0] ?? null;
    setError(null);
    setDone(null);
    setReport(null);
    setFilter("all");
    setFile(chosen);
    if (!chosen) return;
    setBusy("checking");
    send(IMPORT_PATHS.preview, chosen)
      .then(setReport, fail)
      .finally(() => setBusy(null));
  };

  const runImport = () => {
    if (!file || !canImport(report)) return;
    setBusy("importing");
    setError(null);
    send(IMPORT_PATHS.import, file)
      .then((result) => {
        if (result.problems > 0) {
          // Something changed since the preview (an account renamed, say): nothing was saved.
          setReport(result);
          setFilter("problems");
          setError("Some rows have problems now, so nothing was added. Fix them in the file and choose it again.");
          return;
        }
        setDone(importedMessage(result));
        setReport(null);
        clearPicker();
      }, fail)
      .finally(() => setBusy(null));
  };

  const problems = report?.problems ?? 0;
  const shown = report ? visibleRows(report.rows, problems > 0 ? filter : "all") : [];

  return (
    <section
      id="import"
      aria-labelledby="import-xlsx"
      className="mt-6 scroll-mt-4 flex min-w-0 flex-col gap-3 rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky"
    >
      <h2 id="import-xlsx" className="text-lg font-black">
        <span aria-hidden="true">📥 </span>
        Import transactions from Excel
      </h2>
      <p className="max-w-prose text-sm font-bold text-zinc-600">
        Fill in the template, one transaction per row, then choose the file here. You&apos;ll see every row checked before
        anything is added. Rows already saved are skipped, so the same file can&apos;t add things twice.
      </p>
      <div>
        <button
          type="button"
          className={buttonClass("alt")}
          disabled={busy !== null}
          aria-busy={busy === "template"}
          onClick={template}
        >
          {busy === "template" ? "Preparing…" : "Download the template"}
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="import-file" className="text-xs font-black tracking-wider uppercase">
          Your filled-in file (.xlsx)
        </label>
        <input
          ref={input}
          id="import-file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy === "checking" || busy === "importing"}
          onChange={choose}
          className={`block w-full min-w-0 rounded-[14px] text-sm font-bold text-zinc-700 file:mr-3 file:cursor-pointer file:rounded-[14px] file:border-[2.5px] file:border-ink file:bg-yellow file:px-3 file:py-1.5 file:text-sm file:font-black file:text-ink disabled:opacity-60 ${FOCUS}`}
        />
      </div>

      <Notice message={error} />
      {busy === "checking" ? (
        <p role="status" className="text-sm font-extrabold">
          Checking the file…
        </p>
      ) : null}
      {done ? (
        <p role="status" className="rounded-[14px] border-[2.5px] border-ink bg-green/20 px-3 py-2 text-sm font-extrabold shadow-chunky-sm">
          {done}
        </p>
      ) : null}

      {report ? (
        <div className="flex min-w-0 flex-col gap-3">
          <ul className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3" aria-label="What's in the file">
            {summaryCounts(report).map(({ key, label, count }) => (
              <li key={key} className={`rounded-[14px] border-[2.5px] border-ink px-3 py-2 ${COUNT_TONE[key]}`}>
                <span className="block text-2xl font-black tabular-nums">{count}</span>
                <span className="block text-xs font-extrabold">{label}</span>
              </li>
            ))}
          </ul>
          <p role="status" className="text-sm font-extrabold">
            {previewSummary(report)}
          </p>
          {problems > 0 ? <ProblemList rows={visibleRows(report.rows, "problems")} /> : null}
          {problems > 0 ? (
            <Segmented<RowFilter>
              label="Rows to show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All (${report.rows.length})` },
                { value: "problems", label: `Problems (${problems})` },
              ]}
            />
          ) : null}
          {shown.length > 0 ? <RowsTable rows={shown} /> : null}
          <div>
            <button
              type="button"
              className={buttonClass("green")}
              disabled={busy !== null || !canImport(report)}
              aria-busy={busy === "importing"}
              onClick={runImport}
            >
              {busy === "importing" ? "Importing…" : importButton(report)}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// Scrolls inside its own box on a narrow screen, so the page itself never scrolls sideways.
function RowsTable({ rows }: { rows: ImportRow[] }) {
  return (
    <div className="max-h-[28rem] overflow-auto pb-1" tabIndex={0} role="region" aria-label="Rows in the file">
      <table className={`${TABLE} min-w-[44rem]`}>
        <caption className="sr-only">Each row of the file, as it was read</caption>
        <thead>
          <tr>
            <th scope="col" className={`${TH} text-right`}>
              Row
            </th>
            <th scope="col" className={TH}>
              Date
            </th>
            <th scope="col" className={TH}>
              Type
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Amount
            </th>
            <th scope="col" className={TH}>
              Account
            </th>
            <th scope="col" className={TH}>
              Category
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <ImportTableRow key={r.row} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportTableRow({ row }: { row: ImportRow }) {
  return (
    <tr className={row.status === "error" ? "bg-pink/10" : undefined}>
      <td className={`${TD} text-right tabular-nums`}>{row.row}</td>
      <td className={`${TD} whitespace-nowrap`}>{dateLabel(row.date)}</td>
      <td className={TD}>{row.type ?? "—"}</td>
      <td className={TD_NUM}>{amountLabel(row.amount)}</td>
      <td className={`${TD} min-w-44 break-words`}>{accountsLabel(row)}</td>
      <td className={`${TD} min-w-28 break-words`}>{row.category ?? "—"}</td>
      <td className={TD}>
        <span
          className={`inline-block rounded-full border-[1.5px] border-ink px-2 text-[11px] font-black whitespace-nowrap ${STATUS_BADGE[row.status]}`}
        >
          {statusLabel(row.status)}
        </span>
      </td>
    </tr>
  );
}

// What's wrong with each problem row. Kept out of the table so it reads on a phone without scrolling sideways.
function ProblemList({ rows }: { rows: ImportRow[] }) {
  return (
    <div className="rounded-[14px] border-[2.5px] border-ink bg-pink/10 px-3 py-2">
      <h3 className="mb-1 text-xs font-black tracking-wider uppercase">What to fix</h3>
      <ul className="flex flex-col gap-1.5 text-sm font-bold">
        {rows.map((r) => (
          <li key={r.row} className="break-words">
            <span className="font-black">Row {r.row}:</span>{" "}
            {r.errors.length > 0 ? r.errors.join(" ") : "This row couldn't be read."}
          </li>
        ))}
      </ul>
    </div>
  );
}
