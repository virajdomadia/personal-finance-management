"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { DIALOG, INPUT, PRIMARY, QUIET } from "@/components/investments/shared";
import { ComboBox, Select } from "@/components/ui/select";
import {
  type Frequency,
  type Template,
  type TemplateForm,
  type TemplateType,
  templateFormBlank,
  templateFormFrom,
  templatePayload,
} from "@/lib/recurring";
import { type CategoryList, isDeposit } from "@/lib/transactions";

type Key = Exclude<keyof TemplateForm, "type" | "active">;

const TYPES: { value: TemplateType; label: string }[] = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
  { value: "transfer", label: "Transfer" },
];
const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "monthly", label: "Every month" },
  { value: "yearly", label: "Every year" },
];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS = MONTH_NAMES.map((label, i) => ({ value: String(i + 1), label }));

// What a policy's reminder keeps in its own hands; the rest is set from the policy.
const POLICY_FIELDS: Key[] = ["name", "note", "remind_days"];

function renderedFields(form: TemplateForm): Key[] {
  return [
    "name",
    "amount",
    "account_id",
    form.type === "transfer" ? "to_account_id" : "category",
    "note",
    "frequency",
    "day",
    ...(form.frequency === "yearly" ? (["month"] as const) : []),
    "start_date",
    "end_date",
    "remind_days",
  ];
}

type Props = {
  template: Template | null; // null means adding
  frequency: Frequency; // for a new one
  onClose: () => void;
  onSaved: () => void;
  onConflict: (message: string) => void;
};

export function TemplateDialog({ template, frequency, onClose, onSaved, onConflict }: Props) {
  const editing = template !== null;
  const fromPolicy = template !== null && template.policy_id !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<TemplateForm>(() => (template ? templateFormFrom(template) : templateFormBlank(frequency)));
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<CategoryList>({ income: [], expense: [] });
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let current = true;
    apiFetch<AccountList>("/accounts")
      .then((list) => {
        if (current) setAccounts(list.accounts);
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) void logout();
        else setAccountsFailed(true);
      });
    // Only suggestions: the category can still be typed.
    apiFetch<CategoryList>("/transactions/categories")
      .then((list) => {
        if (current) setCategories(list);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const set = (key: keyof TemplateForm, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const changeType = (type: TemplateType) => {
    setErrors({});
    setForm((f) => ({ ...f, type, category: "", to_account_id: "" }));
  };
  const changeFrequency = (next: Frequency) => {
    setErrors({});
    // The reminder window has a default for each frequency; follow it unless the user set their own.
    setForm((f) => {
      const untouched = f.remind_days === templateFormBlank(f.frequency).remind_days;
      return { ...f, frequency: next, remind_days: untouched ? templateFormBlank(next).remind_days : f.remind_days };
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
      if (template) {
        const full = templatePayload(form, "edit");
        const payload = fromPolicy
          ? { name: full.name, note: full.note, remind_days: full.remind_days }
          : full;
        await apiFetch(`/recurring/${template.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/recurring", { method: "POST", body: JSON.stringify(templatePayload(form, "create")) });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, renderedFields(form));
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

  const locked = (key: Key) => saving || (fromPolicy && !POLICY_FIELDS.includes(key));
  const field = (key: Key, label: string, input: React.ReactNode) => (
    <div>
      <label htmlFor={`rt-${key}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {errors[key] ? (
        <p id={`rte-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props = (key: Key) => ({
    id: `rt-${key}`,
    name: key,
    value: form[key] as string,
    disabled: locked(key),
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `rte-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const picker = (key: Key) => ({
    id: `rt-${key}`,
    value: form[key] as string,
    disabled: locked(key),
    invalid: Boolean(errors[key]),
    describedBy: errors[key] ? `rte-${key}` : undefined,
    onChange: (value: string) => set(key, value),
  });

  const option = (a: Account) => ({ value: String(a.id), label: a.name });
  const options = (keep: string, usable: (a: Account) => boolean) =>
    accounts.filter((a) => String(a.id) === keep || usable(a)).map(option);
  // A reminder is recorded as a transaction, which can't be paid from a PPF or RD; the server has the final say.
  const fromAccounts = options(form.account_id, (a) =>
    form.type === "expense" ? !isDeposit(a) : form.type === "transfer" ? String(a.id) !== form.to_account_id : true,
  );
  const toAccounts = options(form.to_account_id, (a) => String(a.id) !== form.account_id);
  const placeholder = accountsFailed ? "Couldn't load accounts" : "Choose an account";
  const fromLabel = form.type === "income" ? "Received in" : form.type === "transfer" ? "From account" : "Paid from";
  const categoryNames = form.type === "income" ? categories.income : categories.expense;

  return (
    <dialog
      ref={ref}
      aria-labelledby="template-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(32rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="template-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold dark:border-zinc-800">
          {editing ? "Edit reminder" : "Add reminder"}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {fromPolicy && (
            <p className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
              This reminder belongs to an insurance policy. Change its amount, account and dates from{" "}
              <Link href="/insurance" className="underline">
                the policy
              </Link>
              ; here you can edit only its name, note and reminder window.
            </p>
          )}

          {editing ? (
            <div>
              <span className="mb-1 block text-sm font-medium">Type</span>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{TYPES.find((t) => t.value === form.type)?.label}</p>
            </div>
          ) : (
            <fieldset disabled={saving}>
              <legend className="mb-1 block text-sm font-medium">Type</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {TYPES.map((t) => (
                  <label key={t.value} className="flex items-center gap-1.5 text-sm">
                    <input type="radio" name="type" value={t.value} checked={form.type === t.value} onChange={() => changeType(t.value)} />
                    {t.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {field("name", "Name", <input {...props("name")} type="text" autoComplete="off" maxLength={60} required />)}
          {field("amount", "Amount (₹)", <input {...props("amount")} type="text" inputMode="decimal" autoComplete="off" required />)}
          {field("account_id", fromLabel, <Select {...picker("account_id")} placeholder={placeholder} options={fromAccounts} />)}
          {form.type === "transfer"
            ? field("to_account_id", "To account", <Select {...picker("to_account_id")} placeholder={placeholder} options={toAccounts} />)
            : field(
                "category",
                "Category",
                <ComboBox {...picker("category")} maxLength={40} options={categoryNames.map((name) => ({ value: name, label: name }))} />,
              )}
          {field("note", "Note (optional)", <input {...props("note")} type="text" autoComplete="off" maxLength={200} />)}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {field(
              "frequency",
              "Repeats",
              <Select
                {...picker("frequency")}
                                options={FREQUENCIES}
                onChange={(value) => changeFrequency(value as Frequency)}
              />,
            )}
            {field("day", "Day of the month", <input {...props("day")} type="text" inputMode="numeric" autoComplete="off" required />)}
          </div>
          {form.frequency === "yearly" && field("month", "Month", <Select {...picker("month")} placeholder="Choose a month" options={MONTHS} />)}
          {form.day !== "" && Number(form.day) > 28 && (
            <p className="-mt-2 text-xs text-zinc-500 dark:text-zinc-400">In shorter months it falls on the last day.</p>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {field("start_date", "Starting", <input {...props("start_date")} type="date" required />)}
            {field("end_date", "Ending (optional)", <input {...props("end_date")} type="date" />)}
          </div>
          {field(
            "remind_days",
            "Show it this many days ahead",
            <input {...props("remind_days")} type="text" inputMode="numeric" autoComplete="off" required />,
          )}

          {formError ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {formError}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button ref={submitRef} type="submit" className={PRIMARY} disabled={saving}>
            {saving ? "Saving..." : editing ? "Save changes" : "Add reminder"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
