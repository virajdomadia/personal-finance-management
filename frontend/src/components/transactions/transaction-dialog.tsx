"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { ComboBox, Select } from "@/components/ui/select";
import {
  type CategoryList,
  TRANSACTION_TYPES,
  type Transaction,
  type TransactionForm,
  type TransactionType,
  applyDepositRules,
  blankForm,
  changedPayload,
  formFromTransaction,
  fromOptions,
  incomeCategories,
  renderedFields,
  subtractMoney,
  toOptions,
  toPayload,
  todayIndia,
} from "@/lib/transactions";

const INPUT =
  "w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 disabled:opacity-60 aria-[invalid=true]:border-red-600 dark:border-zinc-700";

const FROM_LABELS: Record<TransactionType, string> = {
  expense: "Paid from",
  income: "Received in",
  transfer: "From account",
  emi: "Paid from",
};

type Props = {
  transaction: Transaction | null; // null means adding
  accounts: Account[]; // active accounts
  defaultAccountId: number | null;
  initialForm?: TransactionForm; // a pre-filled new transaction, such as a loan's next EMI
  onClose: () => void;
  onSaved: (saved: Transaction) => void;
  onConflict: (message: string) => void;
};

export function TransactionDialog({
  transaction,
  accounts,
  defaultAccountId,
  initialForm,
  onClose,
  onSaved,
  onConflict,
}: Props) {
  const editing = transaction !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<TransactionForm>(() =>
    transaction
      ? formFromTransaction(transaction)
      : (initialForm ?? blankForm("expense", todayIndia(), defaultAccountId)),
  );
  const [categories, setCategories] = useState<CategoryList>({ income: [], expense: [] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Only suggestions: if this fails the user can still type a category.
  useEffect(() => {
    let current = true;
    apiFetch<CategoryList>("/transactions/categories")
      .then((list) => {
        if (current) setCategories(list);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  // After a failed save the inputs are disabled until the response lands, which drops focus.
  // Once they are enabled again, move it to the first invalid field (or the submit button).
  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const set = (key: keyof TransactionForm, value: string) =>
    setForm((f) => applyDepositRules({ ...f, [key]: value }, accounts));

  // Keeps what the types share and resets what only some of them have.
  const changeType = (type: TransactionType) => {
    setErrors({});
    setForm((f) => applyDepositRules({ ...f, type, category: "", to_account_id: "", interest: "" }, accounts));
  };

  // Picking a loan for a new EMI fills in its suggested split and usual account.
  const chooseLoan = (value: string) => {
    const loan = accounts.find((a) => String(a.id) === value);
    setForm((f) => {
      if (editing || !loan) return { ...f, to_account_id: value };
      const usual = loan.pay_from_id !== null && accounts.some((a) => a.id === loan.pay_from_id);
      return {
        ...f,
        to_account_id: value,
        account_id: usual ? String(loan.pay_from_id) : f.account_id,
        amount: loan.next_emi?.amount ?? loan.emi_amount ?? f.amount,
        interest: loan.next_emi?.interest ?? f.interest,
      };
    });
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      if (editing) {
        const payload = changedPayload(form, transaction);
        if (Object.keys(payload).length === 0) {
          ref.current?.close();
          return;
        }
        onSaved(await apiFetch<Transaction>(`/transactions/${transaction.id}`, { method: "PATCH", body: JSON.stringify(payload) }));
      } else {
        onSaved(await apiFetch<Transaction>("/transactions", { method: "POST", body: JSON.stringify(toPayload(form, "create")) }));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, renderedFields(form.type));
        setErrors(fields);
        if (general.length > 0) setFormError(general.join(" "));
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
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
  const field = (key: keyof TransactionForm, label: string, input: React.ReactNode) => (
    <div>
      <label htmlFor={`t-${key}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {errors[key] ? (
        <p id={`te-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props = (key: keyof TransactionForm) => ({
    id: `t-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `te-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const pickerProps = (key: keyof TransactionForm) => ({
    id: `t-${key}`,
    value: form[key],
    disabled: saving,
    invalid: Boolean(errors[key]),
    describedBy: errors[key] ? `te-${key}` : undefined,
    onChange: (value: string) => set(key, value),
  });
  const loans = accounts.filter((a) => a.type === "loan");
  const types = TRANSACTION_TYPES.filter((t) => t.value !== "emi" || loans.length > 0);
  const option = (a: Account) => ({ value: String(a.id), label: a.name });
  const principal = subtractMoney(cleanMoney(form.amount), cleanMoney(form.interest));

  return (
    <dialog
      ref={ref}
      aria-labelledby="transaction-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="transaction-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold dark:border-zinc-800">
          {editing ? "Edit transaction" : "Add transaction"}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {editing ? (
            <div>
              <span className="mb-1 block text-sm font-medium">Type</span>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {TRANSACTION_TYPES.find((t) => t.value === type)?.label}
              </p>
            </div>
          ) : (
            <fieldset disabled={saving}>
              <legend className="mb-1 block text-sm font-medium">Type</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {types.map((option) => (
                  <label key={option.value} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name="type"
                      value={option.value}
                      checked={type === option.value}
                      onChange={() => changeType(option.value)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div className="grid grid-cols-2 gap-4">
            {field("amount", "Amount (₹)", <input {...props("amount")} type="text" inputMode="decimal" autoComplete="off" required />)}
            {field("date", "Date", <input {...props("date")} type="date" max={todayIndia()} required />)}
          </div>

          {field(
            "account_id",
            FROM_LABELS[type],
            <Select
              {...pickerProps("account_id")}
              placeholder="Choose an account"
              options={fromOptions(type, accounts, form).map(option)}
            />,
          )}

          {type === "emi" && (
            <>
              {field(
                "to_account_id",
                "Loan",
                <Select
                  {...pickerProps("to_account_id")}
                  onChange={chooseLoan}
                  placeholder="Choose a loan"
                  options={loans.map((a) => ({ value: String(a.id), label: a.name }))}
                />,
              )}
              <div>
                <label htmlFor="t-interest" className="mb-1 block text-sm font-medium">
                  Interest and charges (₹)
                </label>
                <input
                  {...props("interest")}
                  aria-describedby={[`th-interest`, errors.interest ? "te-interest" : null].filter(Boolean).join(" ")}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                />
                <p id="th-interest" className="mt-1 text-xs text-zinc-500 dark:text-zinc-400" aria-live="polite">
                  {principal && !principal.startsWith("-")
                    ? `${formatRupees(principal)} repays the loan. The interest counts as spending. Use your statement's figures if they differ.`
                    : "Interest, fees and GST in this EMI. The rest repays the loan."}
                </p>
                {errors.interest ? (
                  <p id="te-interest" className="mt-1 text-xs text-red-700 dark:text-red-400">
                    {errors.interest}
                  </p>
                ) : null}
              </div>
            </>
          )}

          {type === "emi"
            ? null
            : type === "transfer"
            ? field(
                "to_account_id",
                "To account",
                <Select {...pickerProps("to_account_id")} placeholder="Choose an account" options={toOptions(accounts, form).map(option)} />,
              )
            : field(
                "category",
                "Category",
                <ComboBox
                  {...pickerProps("category")}
                  maxLength={40}
                  options={(type === "income" ? incomeCategories(accounts, form, categories.income) : categories[type]).map((name) => ({ value: name, label: name }))}
                />,
              )}

          {field("note", "Note (optional)", <input {...props("note")} type="text" autoComplete="off" maxLength={200} />)}

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
            {saving ? "Saving..." : editing ? "Save changes" : "Add transaction"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
