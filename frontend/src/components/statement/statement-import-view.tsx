"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { Notice } from "@/components/investments/shared";
import { FOCUS, PageHeader, buttonClass } from "@/components/ui/chunky";
import { type Account, type AccountList, errorMessage } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import {
  type Row,
  type StatementPreview,
  errorsByLine,
  initialRows,
  otherAccounts,
  passwordProblem,
  savePayload,
  savedMessage,
  statementAccounts,
} from "@/lib/statement-import";
import type { CategoryList } from "@/lib/transactions";

import { PreviewFailed, isUnauthorized, previewStatement, saveStatement } from "./api";
import { PasswordForm, StatementPicker } from "./statement-picker";
import { StatementReview } from "./statement-review";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; accounts: Account[] };
type Locked = { wrong: boolean; message: string };
type Loaded = { accountId: number; preview: StatementPreview };

function foundText(p: StatementPreview): string {
  const total = p.lines.length;
  const parts = [`${p.new} new`, `${p.duplicates} already saved`];
  if (p.problems > 0) parts.push(`${p.problems} that couldn't be read`);
  return `Found ${total} ${total === 1 ? "line" : "lines"}: ${parts.join(", ")}. Check each one, then import.`;
}

export function StatementImportView() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [categories, setCategories] = useState<CategoryList>({ income: [], expense: [] });
  const [accountId, setAccountId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [locked, setLocked] = useState<Locked | null>(null);
  const [busy, setBusy] = useState<"checking" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [lineErrors, setLineErrors] = useState<Map<number, string[]>>(new Map());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    apiFetch<AccountList>("/accounts")
      .then((list) => {
        if (current) setLoad({ status: "ready", accounts: list.accounts });
      })
      .catch((err) => {
        if (isUnauthorized(err)) void logout();
        if (current) setLoad({ status: "error" });
      });
    // Only choices for the selects: without them a line can still be saved with no category.
    apiFetch<CategoryList>("/transactions/categories")
      .then((list) => {
        if (current) setCategories(list);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [attempt]);

  const clearReview = () => {
    setLoaded(null);
    setRows([]);
    setLineErrors(new Map());
  };

  const check = (id: string, chosen: File, password: string) => {
    setBusy("checking");
    setError(null);
    setDone(null);
    clearReview();
    previewStatement(Number(id), chosen, password)
      .then((preview) => {
        setLocked(null);
        setLoaded({ accountId: Number(id), preview });
        setRows(initialRows(preview));
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) return void logout();
        if (err instanceof PreviewFailed && err.failure.kind === "password") {
          setLocked({ wrong: err.failure.wrong, message: err.failure.message });
          return;
        }
        setLocked(null);
        setError(err instanceof Error && err.message ? err.message : "The file couldn't be checked. Try again in a minute.");
      })
      .finally(() => setBusy(null));
  };

  const chooseAccount = (id: string) => {
    setAccountId(id);
    if (file) check(id, file, "");
  };

  const chooseFile = (chosen: File | null) => {
    setFile(chosen);
    setLocked(null);
    setError(null);
    setDone(null);
    clearReview();
    if (chosen && accountId) check(accountId, chosen, "");
  };

  const unlock = (password: string) => {
    const problem = passwordProblem(password);
    if (problem) return setLocked({ wrong: true, message: problem });
    if (file && accountId) check(accountId, file, password);
  };

  const runImport = () => {
    if (!loaded) return;
    setBusy("saving");
    setError(null);
    setLineErrors(new Map());
    saveStatement(savePayload(loaded.accountId, rows))
      .then((result) => {
        if (result.errors.length > 0) {
          setLineErrors(errorsByLine(result));
          setError(
            "Nothing was added: some lines have problems, shown in red below. Change or untick them, then import again.",
          );
          return;
        }
        setDone(savedMessage(result));
        clearReview();
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) return void logout();
        setError(errorMessage(err));
      })
      .finally(() => setBusy(null));
  };

  const accounts = load.status === "ready" ? load.accounts : [];
  const choices = statementAccounts(accounts);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Import a statement"
        action={
          <Link href="/transactions" className={buttonClass("alt")}>
            Back to transactions
          </Link>
        }
      />
      <p className="mb-5 max-w-prose text-sm font-bold text-zinc-600">
        Bring in a statement from any bank or card: CSV, Excel or PDF, as your bank gives it. You&apos;ll see every line
        with a suggested category before anything is added, and lines already saved are left out.
      </p>

      {load.status === "loading" ? (
        <p role="status" className="text-sm font-extrabold">
          Loading your accounts…
        </p>
      ) : null}
      {load.status === "error" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Notice message="Your accounts couldn't be loaded." />
          <button type="button" className={buttonClass("alt")} onClick={() => {
              setLoad({ status: "loading" });
              setAttempt((n) => n + 1);
            }}>
            Try again
          </button>
        </div>
      ) : null}
      {load.status === "ready" && choices.length === 0 ? (
        <p className="max-w-prose rounded-[14px] border-[2.5px] border-dashed border-ink bg-due px-3.5 py-3 text-sm font-bold">
          A statement goes into a bank, card, cash, wallet or broker account, and you don&apos;t have one yet.{" "}
          <Link href="/accounts" className={`rounded font-black underline ${FOCUS}`}>
            Add an account
          </Link>{" "}
          first.
        </p>
      ) : null}

      {choices.length > 0 ? (
        <section
          aria-label="Statement"
          className="flex min-w-0 flex-col gap-4 rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky"
        >
          <StatementPicker
            accounts={choices}
            accountId={accountId}
            fileInput={fileInput}
            disabled={busy !== null}
            onAccount={chooseAccount}
            onFile={chooseFile}
          />
          {locked ? (
            <PasswordForm wrong={locked.wrong} message={locked.message} disabled={busy === "checking"} onSubmit={unlock} />
          ) : null}
          {busy === "checking" ? (
            <p role="status" className="text-sm font-extrabold">
              Reading the statement…
            </p>
          ) : null}
          <Notice message={error} />
          {done ? (
            <p
              role="status"
              className="rounded-[14px] border-[2.5px] border-ink bg-green/20 px-3 py-2 text-sm font-extrabold shadow-chunky-sm"
            >
              {done}{" "}
              <Link href="/transactions" className={`rounded font-black underline ${FOCUS}`}>
                See them in Transactions
              </Link>
            </p>
          ) : null}

          {loaded ? (
            <>
              <p role="status" className="text-sm font-extrabold">
                {foundText(loaded.preview)}
              </p>
              {rows.length > 0 ? (
                <StatementReview
                  rows={rows}
                  categories={categories}
                  others={otherAccounts(accounts, loaded.accountId)}
                  lineErrors={lineErrors}
                  saving={busy === "saving"}
                  onRows={setRows}
                  onImport={runImport}
                />
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
