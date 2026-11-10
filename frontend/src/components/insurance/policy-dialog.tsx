"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { DIALOG, INPUT, PRIMARY, QUIET } from "@/components/investments/shared";
import { Select } from "@/components/ui/select";
import { type Policy, addDays, addYear } from "@/lib/insurance";
import { type TransactionList, formatDate, isDeposit, todayIndia } from "@/lib/transactions";

type PolicyForm = {
  insurer: string;
  plan: string;
  policy_number: string;
  insured: string;
  sum_insured: string;
  period_start: string;
  period_end: string;
  premium: string;
  account_id: string;
  funded_by_id: string;
  details: string;
  paid_on: string;
  transaction_id: string;
};
type Key = keyof PolicyForm;

const BLANK: PolicyForm = {
  insurer: "",
  plan: "",
  policy_number: "",
  insured: "",
  sum_insured: "",
  period_start: "",
  period_end: "",
  premium: "",
  account_id: "",
  funded_by_id: "",
  details: "",
  paid_on: "",
  transaction_id: "",
};

// The period the policy is in now: the one that starts when the policy's current year does.
function currentPeriod(policy: Policy) {
  return policy.periods.find((p) => p.period_start === policy.period_start) ?? policy.periods[policy.periods.length - 1];
}

// Only a year paid before the app has a date to edit here; a recorded payment's date is its transaction's.
export function paidOnEditable(policy: Policy): boolean {
  const period = currentPeriod(policy);
  return period !== undefined && period.transaction_id === null;
}

function formFromPolicy(policy: Policy): PolicyForm {
  return {
    insurer: policy.insurer,
    plan: policy.plan,
    policy_number: policy.policy_number,
    insured: policy.insured,
    sum_insured: policy.sum_insured,
    period_start: policy.period_start,
    period_end: policy.period_end,
    premium: policy.premium,
    account_id: String(policy.paying_account_id),
    funded_by_id: policy.funded_by ? String(policy.funded_by.account_id) : "",
    details: policy.details ?? "",
    paid_on: paidOnEditable(policy) ? (currentPeriod(policy)?.paid_on ?? "") : "",
    transaction_id: "",
  };
}

const textOrNull = (raw: string) => raw.trim() || null;
const idOrNull = (raw: string) => (raw === "" ? null : Number(raw));

function valueFor(key: Key, form: PolicyForm): unknown {
  switch (key) {
    case "sum_insured":
    case "premium":
      return textOrNull(cleanMoney(form[key]));
    case "account_id":
    case "funded_by_id":
    case "transaction_id":
      return idOrNull(form[key]);
    default:
      return textOrNull(form[key]);
  }
}

const POLICY_KEYS: Key[] = ["insurer", "plan", "policy_number", "insured", "sum_insured", "period_start", "period_end", "premium", "account_id", "funded_by_id", "details"];

// A new policy sends everything; an edit sends only what changed, so a lapsed policy's old card or a
// funding account that has since closed never blocks a change to its notes.
function payloadFor(form: PolicyForm, original: PolicyForm | null, showPaidOn: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (original === null) payload.kind = "health";
  for (const key of POLICY_KEYS) {
    if (original === null || form[key] !== original[key]) payload[key] = valueFor(key, form);
  }
  if (showPaidOn && (original === null || form.paid_on !== original.paid_on)) payload.paid_on = valueFor("paid_on", form);
  if (original === null && form.transaction_id !== "") payload.transaction_id = valueFor("transaction_id", form);
  return payload;
}

type Props = {
  policy: Policy | null; // null means adding
  onClose: () => void;
  onSaved: () => void;
  onConflict: (message: string) => void;
};

export function PolicyDialog({ policy, onClose, onSaved, onConflict }: Props) {
  const editing = policy !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [today] = useState(() => todayIndia());
  const [original] = useState<PolicyForm | null>(() => (policy ? formFromPolicy(policy) : null));
  const [form, setForm] = useState<PolicyForm>(() => original ?? BLANK);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [payments, setPayments] = useState<TransactionList["transactions"]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const showPaidOn = !editing || paidOnEditable(policy);

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
    return () => {
      current = false;
    };
  }, []);

  // A premium already recorded in the app can be linked instead of entered again: offer the expenses
  // from the month it was paid. A failure just leaves the list empty.
  const paidMonth = form.paid_on.slice(0, 7);
  useEffect(() => {
    if (editing || !/^\d{4}-\d{2}$/.test(paidMonth)) return;
    let current = true;
    apiFetch<TransactionList>(`/transactions?type=expense&month=${paidMonth}&limit=200`)
      .then((list) => {
        if (current) setPayments(list.transactions.filter((t) => t.recurring_template_id === null));
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) void logout();
        else setPayments([]);
      });
    return () => {
      current = false;
    };
  }, [editing, paidMonth]);

  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const set = (key: Key, value: string) =>
    setForm((f) => {
      const next = { ...f, [key]: value };
      // A policy year runs to the day before its anniversary: fill the end in when it's still empty.
      if (key === "period_start" && /^\d{4}-\d{2}-\d{2}$/.test(value) && f.period_end === "" && !editing) {
        next.period_end = addDays(addYear(value), -1);
      }
      // A different payment date means any payment picked for the old date no longer applies.
      if (key === "paid_on") next.transaction_id = "";
      return next;
    });

  const pickPayment = (value: string) =>
    setForm((f) => {
      const payment = payments.find((t) => String(t.id) === value);
      if (!payment) return { ...f, transaction_id: "" };
      return {
        ...f,
        transaction_id: value,
        paid_on: payment.date,
        premium: f.premium === "" ? payment.amount : f.premium,
        account_id: f.account_id === "" ? String(payment.account_id) : f.account_id,
      };
    });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const payload = payloadFor(form, original, showPaidOn);
      if (policy) {
        if (Object.keys(payload).length === 0) {
          ref.current?.close();
          return;
        }
        await apiFetch(`/insurance/${policy.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/insurance", { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const rendered: Key[] = [...POLICY_KEYS, ...(showPaidOn ? (["paid_on"] as const) : []), ...(editing ? [] : (["transaction_id"] as const))];
        const { fields, general } = splitErrors(err.body, rendered);
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

  const field = (key: Key, label: string, input: React.ReactNode, hint?: string) => (
    <div>
      <label htmlFor={`p-${key}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {hint ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
      {errors[key] ? (
        <p id={`pe-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props = (key: Key) => ({
    id: `p-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `pe-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const picker = (key: Key) => ({
    id: `p-${key}`,
    value: form[key],
    disabled: saving,
    invalid: Boolean(errors[key]),
    describedBy: errors[key] ? `pe-${key}` : undefined,
    onChange: (value: string) => set(key, value),
  });

  // Keep an account the policy already uses listed even if it has since been archived or closed.
  const withCurrent = (list: Account[], id: string, name: string | undefined) => {
    const options = list.map((a) => ({ value: String(a.id), label: a.name }));
    if (id !== "" && name && !options.some((o) => o.value === id)) options.push({ value: id, label: name });
    return options;
  };
  const payFrom = withCurrent(
    accounts.filter((a) => !isDeposit(a) && a.type !== "loan"),
    form.account_id,
    policy?.paying_account_name,
  );
  const funding = [
    { value: "", label: "None" },
    ...withCurrent(
      accounts.filter((a) => a.type === "rd"),
      form.funded_by_id,
      policy?.funded_by?.name,
    ),
  ];
  const placeholder = accountsFailed ? "Couldn't load accounts" : "Choose an account";

  return (
    <dialog
      ref={ref}
      aria-labelledby="policy-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(36rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="policy-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold dark:border-zinc-800">
          {editing ? "Edit policy" : "Add health insurance policy"}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {!editing && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Add the policy as it stands now. A yearly reminder for the premium is created with it, starting at the end of this year.
            </p>
          )}
          {field("insurer", "Insurer", <input {...props("insurer")} type="text" autoComplete="off" maxLength={52} required />)}
          {field("plan", "Plan", <input {...props("plan")} type="text" autoComplete="off" required />)}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {field("policy_number", "Policy number", <input {...props("policy_number")} type="text" autoComplete="off" maxLength={40} required />)}
            {field("insured", "Insured", <input {...props("insured")} type="text" autoComplete="off" maxLength={100} required />)}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {field("sum_insured", "Sum insured (₹)", <input {...props("sum_insured")} type="text" inputMode="decimal" autoComplete="off" required />)}
            {field("premium", "Yearly premium (₹)", <input {...props("premium")} type="text" inputMode="decimal" autoComplete="off" required />)}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {field("period_start", "Current year starts", <input {...props("period_start")} type="date" required />)}
            {field("period_end", "Current year ends", <input {...props("period_end")} type="date" required />)}
          </div>
          {field(
            "account_id",
            "Premium is paid from",
            <Select {...picker("account_id")} placeholder={placeholder} options={payFrom} />,
          )}
          {field(
            "funded_by_id",
            "Set aside in (optional)",
            <Select {...picker("funded_by_id")} placeholder="None" options={funding} />,
            "An RD you're saving in to pay the premium. The policy then shows whether it will cover it.",
          )}
          <div>
            <label htmlFor="p-details" className="mb-1 block text-sm font-medium">
              Details (optional)
            </label>
            <textarea
              id="p-details"
              name="details"
              rows={3}
              maxLength={2000}
              value={form.details}
              disabled={saving}
              className={INPUT}
              aria-invalid={errors.details ? true : undefined}
              aria-describedby={errors.details ? "pe-details" : undefined}
              onChange={(e) => set("details", e.target.value)}
            />
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Bonus, add-ons, waiting periods, nominee.</p>
            {errors.details ? (
              <p id="pe-details" className="mt-1 text-xs text-red-700 dark:text-red-400">
                {errors.details}
              </p>
            ) : null}
          </div>

          {showPaidOn && (
            <fieldset className="flex flex-col gap-4">
              <legend className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                This year&apos;s premium
              </legend>
              {field(
                "paid_on",
                "Paid on",
                <input {...props("paid_on")} type="date" max={today} required />,
                editing ? "Paid before you used the app, so its date can be corrected here." : undefined,
              )}
              {!editing &&
                field(
                  "transaction_id",
                  "Payment already in the app (optional)",
                  <Select
                    {...picker("transaction_id")}
                    onChange={pickPayment}
                    placeholder="None, it was paid before using the app"
                    options={[
                      { value: "", label: "None, it was paid before using the app" },
                      ...payments.map((t) => ({
                        value: String(t.id),
                        label: `${formatDate(t.date)} · ${formatRupees(t.amount)} · ${t.account_name}${t.category ? ` · ${t.category}` : ""}`,
                      })),
                    ]}
                  />,
                  form.paid_on === "" ? "Enter the date it was paid to pick a payment you already recorded." : undefined,
                )}
            </fieldset>
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
            {saving ? "Saving..." : editing ? "Save changes" : "Add policy"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
