"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type FdPayout, FD_PAYOUT_LABELS, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type RenewFdForm, renewFdForm, renewFdPayload } from "@/lib/deposits";
import { todayIndia } from "@/lib/transactions";
import { FOCUS, buttonClass } from "@/components/ui/chunky";
import { Select } from "@/components/ui/select";

const INPUT = `w-full rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold outline-none disabled:opacity-60 aria-[invalid=true]:border-loss aria-[invalid=true]:bg-pink/10 ${FOCUS}`;
const LABEL = "mb-1 block text-xs font-black tracking-wide uppercase";
const RENDERED = ["amount", "date", "account_id", "reinvest", "interest_rate", "matures_on", "fd_payout", "name"];
const PAYOUT_OPTIONS = (Object.keys(FD_PAYOUT_LABELS) as FdPayout[]).map((value) => ({ value, label: FD_PAYOUT_LABELS[value] }));

type Props = {
  account: Account; // the FD
  accounts: Account[]; // active accounts, for the bank the money goes through
  onClose: () => void;
  onDone: () => void;
  onConflict: (message: string) => void;
};

// Renews an FD: closes it at the amount received, pays that into a bank, and puts some or all of it
// into a new FD opened on the same date. What isn't renewed stays in the bank.
export function RenewFdDialog({ account, accounts, onClose, onDone, onConflict }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const needFocus = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const [form, setForm] = useState<RenewFdForm>(() => renewFdForm(account, todayIndia()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // The inputs are disabled while saving, which drops focus; afterwards move it to the first problem.
  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const banks = accounts.filter((a) => a.type === "bank");
  const options = banks.map((a) => ({ value: String(a.id), label: a.name }));
  if (form.account_id !== "" && !options.some((o) => o.value === form.account_id)) {
    options.unshift({ value: form.account_id, label: "Linked account" });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      await apiFetch(`/accounts/${account.id}/renew-fd`, { method: "POST", body: JSON.stringify(renewFdPayload(form)) });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, RENDERED);
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

  // The amount to renew follows the amount received until it is changed on its own.
  const set = (key: keyof RenewFdForm, value: string) =>
    setForm((f) => ({ ...f, [key]: value, ...(key === "amount" && f.reinvest === f.amount ? { reinvest: value } : {}) }));
  const describedBy = (key: keyof RenewFdForm, hint = false) =>
    [hint ? `rf-h-${key}` : null, errors[key] ? `rf-e-${key}` : null].filter(Boolean).join(" ") || undefined;
  const field = (key: keyof RenewFdForm, label: string, input: React.ReactNode, hint?: string) => (
    <div>
      <label htmlFor={`rf-${key}`} className={LABEL}>
        {label}
      </label>
      {input}
      {hint ? (
        <p id={`rf-h-${key}`} className="mt-1 text-xs font-bold text-zinc-600">
          {hint}
        </p>
      ) : null}
      {errors[key] ? (
        <p id={`rf-e-${key}`} className="mt-1 text-xs font-extrabold text-loss">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const input = (key: keyof RenewFdForm, hint = false) => ({
    id: `rf-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": describedBy(key, hint),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });

  return (
    <dialog
      ref={ref}
      aria-labelledby="renew-fd-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="renew-fd-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Renew {account.name}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-4">
            {field(
              "amount",
              "Amount received",
              <input {...input("amount")} type="text" inputMode="decimal" autoComplete="off" required />,
            )}
            {field("date", "Date", <input {...input("date")} type="date" max={todayIndia()} required />)}
          </div>
          {field(
            "account_id",
            "Received in",
            <Select
              id="rf-account_id"
              value={form.account_id}
              options={options}
              disabled={saving}
              invalid={Boolean(errors.account_id)}
              describedBy={describedBy("account_id")}
              onChange={(value) => set("account_id", value)}
            />,
          )}
          {field(
            "reinvest",
            "Amount to renew",
            <input {...input("reinvest", true)} type="text" inputMode="decimal" autoComplete="off" />,
            "Anything less than the amount received stays in the bank.",
          )}
          <div className="grid grid-cols-2 gap-4">
            {field(
              "interest_rate",
              "New interest rate (% a year)",
              <input {...input("interest_rate")} type="text" inputMode="decimal" autoComplete="off" required />,
            )}
            {field(
              "fd_payout",
              "Interest paid",
              <Select
                id="rf-fd_payout"
                value={form.fd_payout}
                options={PAYOUT_OPTIONS}
                disabled={saving}
                invalid={Boolean(errors.fd_payout)}
                describedBy={describedBy("fd_payout")}
                onChange={(value) => set("fd_payout", value)}
              />,
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            {field(
              "matures_on",
              "New maturity date",
              <input {...input("matures_on")} type="date" min={form.date || undefined} required />,
            )}
            {field(
              "name",
              "New name",
              <input {...input("name", true)} type="text" autoComplete="off" maxLength={60} placeholder={account.name} />,
              "Optional. Leave blank to keep the name.",
            )}
          </div>
          <p className="text-sm font-bold text-zinc-600">
            Balance {formatRupees(account.balance)}. The difference is recorded as interest, or as a fee if you received less.
            This FD is then closed and the new one opens on the date above.
          </p>
          {formError ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {formError}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink px-5 py-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => ref.current?.close()}
            className={`${buttonClass("alt")} uppercase`}
          >
            Cancel
          </button>
          <button ref={submitRef} type="submit" disabled={saving} className={`${buttonClass("primary")} uppercase`}>
            {saving ? "Renewing..." : "Renew FD"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
