"use client";

import { type ChangeEvent, type FormEvent, type RefObject, useState } from "react";

import { FOCUS, buttonClass } from "@/components/ui/chunky";
import { Select } from "@/components/ui/select";
import { type Account, TYPE_LABELS } from "@/lib/accounts";
import { ACCEPT } from "@/lib/statement-import";

const LABEL = "text-xs font-black tracking-wider uppercase";
const INPUT = `w-full max-w-xs rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold outline-none disabled:opacity-60 aria-[invalid=true]:border-loss aria-[invalid=true]:bg-pink/10 ${FOCUS}`;

// Step 1: which account the statement is for, and the file.
export function StatementPicker({
  accounts,
  accountId,
  fileInput,
  disabled,
  onAccount,
  onFile,
}: {
  accounts: Account[];
  accountId: string;
  fileInput: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  onAccount: (id: string) => void;
  onFile: (file: File | null) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="statement-account" className={LABEL}>
          Account
        </label>
        <Select
          id="statement-account"
          value={accountId}
          onChange={onAccount}
          disabled={disabled}
          placeholder="Choose the account"
          options={accounts.map((a) => ({ value: String(a.id), label: `${a.name} · ${TYPE_LABELS[a.type]}` }))}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="statement-file" className={LABEL}>
          Statement file (CSV, Excel or PDF)
        </label>
        <input
          ref={fileInput}
          id="statement-file"
          type="file"
          accept={ACCEPT}
          disabled={disabled || accountId === ""}
          aria-describedby="statement-file-hint"
          onChange={(e: ChangeEvent<HTMLInputElement>) => onFile(e.target.files?.[0] ?? null)}
          className={`block w-full min-w-0 rounded-[14px] text-sm font-bold text-zinc-700 file:mr-3 file:cursor-pointer file:rounded-[14px] file:border-[2.5px] file:border-ink file:bg-yellow file:px-3 file:py-1.5 file:text-sm file:font-black file:text-ink disabled:opacity-60 ${FOCUS}`}
        />
        <p id="statement-file-hint" className="text-xs font-bold text-zinc-600">
          {accountId === "" ? "Choose the account first." : "Download it from your bank's website or app, as it is."}
        </p>
      </div>
    </div>
  );
}

// A locked PDF: ask for its password and check the file again with it.
export function PasswordForm({
  wrong,
  message,
  disabled,
  onSubmit,
}: {
  wrong: boolean;
  message: string;
  disabled: boolean;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(password);
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-[14px] border-[2.5px] border-ink bg-due px-3.5 py-3 shadow-chunky-sm"
    >
      <p role="status" className="text-sm font-extrabold">
        <span aria-hidden="true">🔒 </span>
        {message}
      </p>
      <label htmlFor="statement-password" className={LABEL}>
        File password
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="statement-password"
          type="password"
          autoComplete="off"
          autoFocus
          value={password}
          maxLength={200}
          disabled={disabled}
          aria-invalid={wrong || undefined}
          aria-describedby="statement-password-hint"
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT}
        />
        <button type="submit" className={buttonClass("primary")} disabled={disabled || password === ""}>
          {disabled ? "Opening…" : "Open the file"}
        </button>
      </div>
      <p id="statement-password-hint" className="text-xs font-bold text-zinc-700">
        Often your date of birth or customer ID. It&apos;s only used to open this file and isn&apos;t saved.
      </p>
    </form>
  );
}
