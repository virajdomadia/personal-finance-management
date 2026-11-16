"use client";

import Link from "next/link";
import { useState } from "react";

import { logout } from "@/app/login/actions";
import { Notice } from "@/components/investments/shared";
import { PageHeader, buttonClass } from "@/components/ui/chunky";
import { EXPORTS, type ExportKind, downloadError } from "@/lib/data-export";

import { saveDownload } from "./download";
import { ExcelImport } from "./excel-import";

type Card = {
  kind: ExportKind;
  emoji: string;
  title: string;
  button: string;
  body: string;
  variant: "primary" | "green";
  wide?: boolean;
};

const CARDS: Card[] = [
  {
    kind: "csv",
    emoji: "📑",
    title: "Spreadsheets",
    button: "Download spreadsheets (CSV zip)",
    body: "One file each for accounts, transactions, trades, loans, deposits, goals, policies, reminders, budgets and categories. Opens in Excel or Google Sheets.",
    variant: "green",
  },
  {
    kind: "xlsx",
    emoji: "📗",
    title: "Excel workbook",
    button: "Download workbook (.xlsx)",
    body: "The same tables in one workbook, a sheet for each, with real numbers and dates. Opens in Excel or Google Sheets.",
    variant: "green",
  },
  {
    kind: "backup",
    emoji: "🗄️",
    title: "Full backup",
    button: "Download backup (JSON)",
    body: "Everything you've entered, in one compressed JSON file (.json.gz), so it can be loaded back in. Keep it somewhere safe: it holds your whole financial history.",
    variant: "primary",
    wide: true,
  },
];

export function DataView() {
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = (kind: ExportKind) => {
    setBusy(kind);
    setError(null);
    saveDownload(EXPORTS[kind].path, EXPORTS[kind].fallback)
      .catch((err: Error & { status?: number }) => {
        if (err.status === 401) void logout();
        setError(err.message || downloadError(0));
      })
      .finally(() => setBusy(null));
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="Your data" />
      <p className="mb-5 max-w-prose text-sm font-bold text-zinc-600">
        Download everything you&apos;ve put in Gullak, whenever you like. Only your own data is included.
      </p>
      <Notice message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        {CARDS.map(({ kind, emoji, title, button, body, variant, wide }) => (
          <section
            key={kind}
            aria-labelledby={`export-${kind}`}
            className={`flex flex-col gap-3 rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky ${wide ? "sm:col-span-2" : ""}`}
          >
            <h2 id={`export-${kind}`} className="text-lg font-black">
              <span aria-hidden="true">{emoji} </span>
              {title}
            </h2>
            <p className="flex-1 text-sm font-bold text-zinc-600">{body}</p>
            <button
              type="button"
              className={buttonClass(variant)}
              disabled={busy !== null}
              aria-busy={busy === kind}
              onClick={() => start(kind)}
            >
              {busy === kind ? "Preparing…" : button}
            </button>
          </section>
        ))}
      </div>
      <ExcelImport />
      <ExcelImport kind="holdings" />
      <section
        aria-labelledby="import-statement"
        className="mt-6 flex flex-col gap-3 rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky"
      >
        <h2 id="import-statement" className="text-lg font-black">
          <span aria-hidden="true">🏦 </span>
          Import a bank or card statement
        </h2>
        <p className="max-w-prose text-sm font-bold text-zinc-600">
          Download a statement from any bank or card (CSV, Excel or PDF) and bring its transactions in. You&apos;ll check
          each line and its category before anything is added.
        </p>
        <div>
          <Link href="/import/statement" className={buttonClass("primary")}>
            Import a statement
          </Link>
        </div>
      </section>
      <p className="mt-5 max-w-prose rounded-[14px] border-[2.5px] border-dashed border-ink bg-due px-3.5 py-3 text-sm font-bold">
        Restoring a backup isn&apos;t a button yet: the app&apos;s owner loads it on the server with the{" "}
        <code className="font-black">restore-user</code> command.
      </p>
    </div>
  );
}
