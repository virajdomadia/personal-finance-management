"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { FOCUS, buttonClass } from "@/components/ui/chunky";
import { ComboBox, Select } from "@/components/ui/select";
import {
  type CategoryList,
  TRANSACTION_TYPES,
  type Transaction,
  type FieldKey,
  type TransactionForm,
  type TransactionType,
  applyDepositRules,
  changedPayload,
  formFromTransaction,
  fromOptions,
  incomeCategories,
  isDeposit,
  newTransactionForm,
  renderedFields,
  subtractMoney,
  toOptions,
  toPayload,
  todayIndia,
} from "@/lib/transactions";

const INPUT = `w-full rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold outline-none disabled:opacity-60 aria-[invalid=true]:border-loss aria-[invalid=true]:bg-pink/10 ${FOCUS}`;
const LABEL = "mb-1 block text-xs font-black tracking-wide uppercase";
const HINT = "mt-1 text-xs font-bold text-zinc-600";
const ERROR = "mt-1 text-xs font-extrabold text-loss";

const TYPE_ICON: Record<TransactionType, string> = { expense: "💸", income: "💰", transfer: "🔁", emi: "🏧" };
const TYPE_ON: Record<TransactionType, string> = {
  expense: "bg-pink-strong text-white",
  income: "bg-green-strong text-white",
  transfer: "bg-blue-strong text-white",
  emi: "bg-purple-strong text-white",
};

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
      : (initialForm ?? newTransactionForm(todayIndia(), defaultAccountId, accounts)),
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

  const set = (key: FieldKey, value: string) =>
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
  const field = (key: FieldKey, label: string, input: React.ReactNode) => (
    <div>
      <label htmlFor={`t-${key}`} className={LABEL}>
        {label}
      </label>
      {input}
      {errors[key] ? (
        <p id={`te-${key}`} className={ERROR}>
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props = (key: FieldKey) => ({
    id: `t-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `te-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const pickerProps = (key: FieldKey) => ({
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
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="transaction-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          {editing ? "Edit transaction" : "Add transaction"}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {editing ? (
            <div>
              <span className={LABEL}>Type</span>
              <p className="text-sm font-extrabold">
                {TRANSACTION_TYPES.find((t) => t.value === type)?.label}
              </p>
            </div>
          ) : (
            <fieldset disabled={saving} className="min-w-0">
              <legend className={LABEL}>Type</legend>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {types.map((option) => (
                  <label key={option.value} className="relative block min-w-0">
                    <input
                      type="radio"
                      name="type"
                      value={option.value}
                      checked={type === option.value}
                      onChange={() => changeType(option.value)}
                      className="peer sr-only"
                    />
                    <span
                      className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-[14px] border-[2.5px] border-ink px-2 py-2.5 text-center text-sm font-black shadow-chunky-sm peer-focus-visible:ring-[3px] peer-focus-visible:ring-ink peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg peer-disabled:opacity-60 ${
                        type === option.value ? TYPE_ON[option.value] : "bg-card text-ink hover:bg-yellow"
                      }`}
                    >
                      <span aria-hidden="true" className="text-xl leading-none">
                        {TYPE_ICON[option.value]}
                      </span>
                      <span className="break-words">{option.label}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {field(
            "amount",
            "Amount (₹)",
            <input
              {...props("amount")}
              className={`${INPUT} !py-3 text-center !text-3xl !font-black`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              required
            />,
          )}
          {field("date", "Date", <input {...props("date")} type="date" max={todayIndia()} required />)}

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
                <label htmlFor="t-interest" className={LABEL}>
                  Interest and charges (₹)
                </label>
                <input
                  {...props("interest")}
                  aria-describedby={[`th-interest`, errors.interest ? "te-interest" : null].filter(Boolean).join(" ")}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                />
                <p id="th-interest" className={HINT} aria-live="polite">
                  {principal && !principal.startsWith("-")
                    ? `${formatRupees(principal)} repays the loan. The interest counts as spending. Use your statement's figures if they differ.`
                    : "Interest, fees and GST in this EMI. The rest repays the loan."}
                </p>
                {errors.interest ? (
                  <p id="te-interest" className={ERROR}>
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
            : type === "income" && isDeposit(accounts.find((a) => String(a.id) === form.account_id))
            ? (
                // Income into a PPF or RD can only be interest, so there is nothing to choose.
                <p className="text-sm font-black">
                  Category: <span className="font-extrabold">Interest</span>
                </p>
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
            <p role="alert" className="text-sm font-extrabold text-loss">
              {formError}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink px-5 py-3">
          <button type="button" disabled={saving} onClick={() => ref.current?.close()} className={buttonClass("alt")}>
            CANCEL
          </button>
          <button ref={submitRef} type="submit" disabled={saving} className={buttonClass("primary")}>
            {saving ? "SAVING..." : editing ? "SAVE CHANGES" : "ADD TRANSACTION"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
