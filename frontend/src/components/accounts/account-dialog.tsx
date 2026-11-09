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
import { Select } from "@/components/ui/select";

const TYPE_OPTIONS = TYPE_ORDER.map((type) => ({ value: type, label: TYPE_LABELS[type] }));

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
  ppf: "Bank or post office",
  rd: "Bank or post office",
  loan: "Lender",
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
    interest_rate: "",
    emi_amount: "",
    emis_left: "",
    pay_from_id: "",
    opened_on: "",
    deposit_amount: "",
    tenure_months: "",
    deposits_paid: "",
    moved_from_card: "",
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

// Same reason as dayError: a non-number would silently clear the field.
function countError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const count = Number(trimmed);
  return /^\d+$/.test(trimmed) && count >= 1 && count <= 600 ? null : "Enter a number of EMIs from 1 to 600.";
}

type Props = {
  account: Account | null; // null means adding
  accounts: Account[]; // active accounts, for the account a loan is paid from
  onClose: () => void;
  onSaved: () => void;
  onConflict: (message: string) => void;
};

export function AccountDialog({ account, accounts, onClose, onSaved, onConflict }: Props) {
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
    if (form.type === "credit_card" || form.type === "loan") {
      for (const key of form.type === "loan" ? (["due_day"] as const) : (["statement_day", "due_day"] as const)) {
        const message = dayError(form[key]);
        if (message) local[key] = message;
      }
    }
    if (form.type === "loan") {
      const message = countError(form.emis_left);
      if (message) local.emis_left = message;
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
  const payFromOptions = [
    { value: "", label: "Not linked" },
    ...accounts.filter((a) => a.type !== "loan" && a.id !== account?.id).map((a) => ({ value: String(a.id), label: a.name })),
  ];
  // Kept when the linked account was archived after the loan was set up, so the form shows it.
  const linked = account?.pay_from_id;
  if (linked != null && !payFromOptions.some((o) => o.value === String(linked))) {
    payFromOptions.push({ value: String(linked), label: "Archived account" });
  }
  const payFromCard = accounts.find((a) => String(a.id) === form.pay_from_id && a.type === "credit_card");
  const HINTS = new Set<keyof AccountForm>([
    ...(type === "credit_card" || type === "loan" || editing ? (["balance"] as const) : []),
    ...(type === "credit_card" ? (["statement_day", "due_day"] as const) : []),
    ...(type === "loan" ? (["due_day", "interest_rate", "emis_left", "pay_from_id"] as const) : []),
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
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const selectProps = (key: keyof AccountForm) => ({
    id: `f-${key}`,
    value: form[key],
    disabled: saving,
    invalid: Boolean(errors[key]),
    describedBy: describedBy(key),
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
              <Select {...selectProps("type")} options={TYPE_OPTIONS} onChange={(value) => changeType(value as AccountType)} />,
            )
          )}

          {field("name", "Name", <input {...props("name")} type="text" autoComplete="off" maxLength={60} required />)}
          {field(
            "balance",
            type === "credit_card" ? "Amount owed (₹)" : type === "loan" ? "Outstanding (₹)" : "Balance (₹)",
            <input {...props("balance")} type="text" inputMode="decimal" autoComplete="off" required />,
            editing
              ? "Changing this corrects the balance. Your transactions stay as they are."
              : type === "credit_card"
                ? "Enter what you owe as a positive amount."
                : type === "loan"
                  ? "The principal still to repay, as your lender shows it."
                  : undefined,
          )}

          {type !== "cash" &&
            field("institution", INSTITUTION_LABELS[type], <input {...props("institution")} type="text" autoComplete="off" maxLength={60} />)}

          {type === "bank" &&
            field(
              "bank_kind",
              "Kind",
              <Select {...selectProps("bank_kind")} options={BANK_KINDS} onChange={(value) => set("bank_kind", value)} />,
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

          {type === "loan" && (
            <>
              <div className="grid grid-cols-2 gap-4">
                {field("emi_amount", "EMI (₹)", <input {...props("emi_amount")} type="text" inputMode="decimal" autoComplete="off" />)}
                {field(
                  "emis_left",
                  "EMIs left",
                  <input {...props("emis_left")} type="text" inputMode="numeric" autoComplete="off" />,
                  "Goes down as you record EMIs.",
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                {field("due_day", "EMI day", <input {...props("due_day")} type="text" inputMode="numeric" autoComplete="off" />, "1 to 31")}
                {field(
                  "interest_rate",
                  "Interest rate (% a year)",
                  <input {...props("interest_rate")} type="text" inputMode="decimal" autoComplete="off" />,
                  "Optional. Used to suggest each EMI's interest.",
                )}
              </div>
              {field(
                "pay_from_id",
                "EMIs paid from",
                <Select
                  {...selectProps("pay_from_id")}
                  options={payFromOptions}
                  onChange={(value) => setForm((f) => ({ ...f, pay_from_id: value, moved_from_card: "" }))}
                />,
                "For a loan on a credit card, choose the card. Its available credit leaves out what the loan still owes.",
              )}
              {!editing && payFromCard && (
                <div>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={form.moved_from_card === "yes"}
                      disabled={saving}
                      aria-invalid={errors.moved_from_card ? true : undefined}
                      aria-describedby={errors.moved_from_card ? "e-moved_from_card" : undefined}
                      onChange={(e) => set("moved_from_card", e.target.checked ? "yes" : "")}
                    />
                    <span>
                      This amount is already in {payFromCard.name}&apos;s balance. Move it from the card to this loan, so
                      it isn&apos;t counted twice.
                    </span>
                  </label>
                  {errors.moved_from_card ? (
                    <p id="e-moved_from_card" className="mt-1 text-xs text-red-700 dark:text-red-400">
                      {errors.moved_from_card}
                    </p>
                  ) : null}
                </div>
              )}
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
