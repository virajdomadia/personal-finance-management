"use client";

import { useState } from "react";

import { logout } from "@/app/login/actions";
import { Notice } from "@/components/investments/shared";
import { PageHeader, buttonClass } from "@/components/ui/chunky";
import { EXPORTS, type ExportKind, downloadError, fileNameFrom } from "@/lib/data-export";

const CARDS: { kind: ExportKind; emoji: string; title: string; button: string; body: string }[] = [
  {
    kind: "csv",
    emoji: "📑",
    title: "Spreadsheets",
    button: "Download spreadsheets (CSV zip)",
    body: "One file each for accounts, transactions, trades, loans, deposits, goals, policies, reminders, budgets and categories. Opens in Excel or Google Sheets.",
  },
  {
    kind: "backup",
    emoji: "🗄️",
    title: "Full backup",
    button: "Download backup (JSON)",
    body: "Everything you've entered, in one compressed JSON file (.json.gz), so it can be loaded back in. Keep it somewhere safe: it holds your whole financial history.",
  },
];

// Downloads go through the /api proxy, which turns the session cookie into the API's token.
async function download(kind: ExportKind): Promise<void> {
  const { path, fallback } = EXPORTS[kind];
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error(downloadError(res.status)), { status: res.status });
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileNameFrom(res.headers.get("content-disposition"), fallback);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataView() {
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = (kind: ExportKind) => {
    setBusy(kind);
    setError(null);
    download(kind)
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
        {CARDS.map(({ kind, emoji, title, button, body }) => (
          <section
            key={kind}
            aria-labelledby={`export-${kind}`}
            className="flex flex-col gap-3 rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky"
          >
            <h2 id={`export-${kind}`} className="text-lg font-black">
              <span aria-hidden="true">{emoji} </span>
              {title}
            </h2>
            <p className="flex-1 text-sm font-bold text-zinc-600">{body}</p>
            <button
              type="button"
              className={buttonClass(kind === "csv" ? "green" : "primary")}
              disabled={busy !== null}
              aria-busy={busy === kind}
              onClick={() => start(kind)}
            >
              {busy === kind ? "Preparing…" : button}
            </button>
          </section>
        ))}
      </div>
      <p className="mt-5 max-w-prose rounded-[14px] border-[2.5px] border-dashed border-ink bg-due px-3.5 py-3 text-sm font-bold">
        Restoring a backup isn&apos;t a button yet: the app&apos;s owner loads it on the server with the{" "}
        <code className="font-black">restore-user</code> command.
      </p>
    </div>
  );
}
