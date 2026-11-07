"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import {
  type Account,
  type AccountForm,
  type AccountType,
  TYPE_LABELS,
  TYPE_ORDER,
  changedPayload,
  errorMessage,
  formFromAccount,
  renderedFields,
  splitErrors,
  toPayload,
} from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";

const BANK_KINDS = [
  { value: "savings", label: "Savings" },
  { value: "salary", label: "Salary" },
  { value: "current", label: "Current" },
];

const INSTITUTION_LABELS: Record<AccountType, string> = {
  bank: "Bank name",
  credit_card: "Card issuer",
  cash: "",
  broker: "Broker name",
  wallet: "Provider",
};

const CASH_NAME = "Cash in hand";
const DAY_MESSAGE = "Enter a day from 1 to 31.";

const INPUT =
  "w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:opacity-60 aria-[invalid=true]:border-red-600 dark:border-zinc-700";

function blankForm(type: AccountType): AccountForm {
  return {
    type,
    name: type === "cash" ? CASH_NAME : "",
    balance: "",
    institution: "",
    bank_kind: type === "bank" ? "savings" : "",
    last4: "",
    credit_limit: "",
    statement_day: "",
    due_day: "",
  };
}

// toPayload turns a non-numeric day into NaN, which JSON sends as null and so silently clears it.
function dayError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return DAY_MESSAGE;
  const day = Number(trimmed);
  return day >= 1 && day <= 31 ? null : DAY_MESSAGE;
}

type Props = {
  account: Account | null; // null means adding
  onClose: () => void;
  onSaved: () => void;
  onConflict: (message: string) => void;
};

export function AccountDialog({ account, onClose, onSaved, onConflict }: Props) {
  const editing = account !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<AccountForm>(() => (account ? formFromAccount(account) : blankForm("bank")));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // After a failed save the inputs are disabled until the response lands, which drops focus.
  // Once they are enabled again, move it to the first invalid field (or the submit button).
  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const set = (key: keyof AccountForm, value: string) => setForm((f) => ({ ...f, [key]: value }));

  // Keeps what the types share (name and balance) and resets the type-specific fields.
  const changeType = (type: AccountType) => {
    setErrors({});
    setForm((f) => {
      const next = blankForm(type);
      const name = f.name === CASH_NAME || f.name === "" ? next.name : f.name;
      return { ...next, name, balance: f.balance };
    });
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;

    const local: Record<string, string> = {};
    if (form.type === "credit_card") {
      for (const key of ["statement_day", "due_day"] as const) {
        const message = dayError(form[key]);
        if (message) local[key] = message;
      }
    }
    if (Object.keys(local).length > 0) {
      needFocus.current = true;
      setErrors(local);
      setFormError(null);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      if (editing) {
        const payload = changedPayload(form, account);
        if (Object.keys(payload).length === 0) {
          ref.current?.close();
          return;
        }
        await apiFetch(`/accounts/${account.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/accounts", { method: "POST", body: JSON.stringify(toPayload(form, "create")) });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, renderedFields(form.type, editing ? "edit" : "create"));
        setErrors(fields);
        if (general.length > 0) setFormError(general.join(" "));
      } else if (err instanceof ApiError && err.status === 409) {
        onConflict(errorMessage(err));
      } else {
        needFocus.current = true;
        setFormError(errorMessage(err));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const type = form.type;
  const HINTS = new Set<keyof AccountForm>([
    ...(type === "credit_card" || editing ? (["balance"] as const) : []),
    ...(type === "credit_card" ? (["statement_day", "due_day"] as const) : []),
    ...(type === "bank" || type === "credit_card" ? (["last4"] as const) : []),
  ]);
  const field = (key: keyof AccountForm, label: string, input: React.ReactNode, hint?: string) => (
    <div>
      <label htmlFor={`f-${key}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {hint ? (
        <p id={`h-${key}`} className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
      {errors[key] ? (
        <p id={`e-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const describedBy = (key: keyof AccountForm) =>
    [HINTS.has(key) ? `h-${key}` : null, errors[key] ? `e-${key}` : null].filter(Boolean).join(" ") || undefined;
  const props = (key: keyof AccountForm) => ({
    id: `f-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": describedBy(key),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => set(key, e.target.value),
  });

  return (
    <dialog
      ref={ref}
      aria-labelledby="account-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="account-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold dark:border-zinc-800">
          {editing ? "Edit account" : "Add account"}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {editing ? (
            <div>
              <span className="mb-1 block text-sm font-medium">Type</span>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{TYPE_LABELS[type]}</p>
            </div>
          ) : (
            field(
              "type",
              "Type",
              <select
                {...props("type")}
                value={type}
                onChange={(e) => changeType(e.target.value as AccountType)}
              >
                {TYPE_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>,
            )
          )}

          {field("name", "Name", <input {...props("name")} type="text" autoComplete="off" maxLength={60} required />)}
          {field(
            "balance",
            type === "credit_card" ? "Amount owed (₹)" : "Balance (₹)",
            <input {...props("balance")} type="text" inputMode="decimal" autoComplete="off" required />,
            editing
              ? "Changing this corrects the balance. Your transactions stay as they are."
              : type === "credit_card"
                ? "Enter what you owe as a positive amount."
                : undefined,
          )}

          {type !== "cash" &&
            field("institution", INSTITUTION_LABELS[type], <input {...props("institution")} type="text" autoComplete="off" maxLength={60} />)}

          {type === "bank" &&
            field(
              "bank_kind",
              "Kind",
              <select {...props("bank_kind")}>
                {BANK_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>,
            )}

          {(type === "bank" || type === "credit_card") &&
            field(
              "last4",
              "Last 4 digits",
              <input {...props("last4")} type="text" inputMode="numeric" autoComplete="off" maxLength={4} />,
              "Only the last 4 digits. Never enter the full number.",
            )}

          {type === "credit_card" && (
            <>
              {field("credit_limit", "Credit limit (₹)", <input {...props("credit_limit")} type="text" inputMode="decimal" autoComplete="off" />)}
              <div className="grid grid-cols-2 gap-4">
                {field("statement_day", "Statement day", <input {...props("statement_day")} type="text" inputMode="numeric" autoComplete="off" />, "1 to 31")}
                {field("due_day", "Due day", <input {...props("due_day")} type="text" inputMode="numeric" autoComplete="off" />, "1 to 31")}
              </div>
            </>
          )}

          {formError ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {formError}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <button
            type="button"
            disabled={saving}
            onClick={() => ref.current?.close()}
            className="rounded-md px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none disabled:opacity-60 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            ref={submitRef}
            type="submit"
            disabled={saving}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:focus-visible:ring-offset-zinc-900"
          >
            {saving ? "Saving..." : editing ? "Save changes" : "Add account"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
