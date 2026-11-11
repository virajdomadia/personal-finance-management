"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type CloseRdForm, closeRdForm, closeRdPayload } from "@/lib/deposits";
import { todayIndia } from "@/lib/transactions";
import { FOCUS, buttonClass } from "@/components/ui/chunky";
import { Select } from "@/components/ui/select";

const INPUT = `w-full rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold outline-none disabled:opacity-60 aria-[invalid=true]:border-loss aria-[invalid=true]:bg-pink/10 ${FOCUS}`;
const RENDERED = ["amount", "date", "account_id"];

type Props = {
  account: Account; // the RD
  accounts: Account[]; // active accounts, for the bank the money lands in
  onClose: () => void;
  onDone: () => void;
  onConflict: (message: string) => void;
};

export function CloseRdDialog({ account, accounts, onClose, onDone, onConflict }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [form, setForm] = useState<CloseRdForm>(() => closeRdForm(account, todayIndia()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

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
      await apiFetch(`/accounts/${account.id}/close-rd`, { method: "POST", body: JSON.stringify(closeRdPayload(form)) });
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        const { fields, general } = splitErrors(err.body, RENDERED);
        setErrors(fields);
        if (general.length > 0) setFormError(general.join(" "));
      } else if (err instanceof ApiError && err.status === 409) {
        onConflict(errorMessage(err));
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const set = (key: keyof CloseRdForm, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const err = (key: string) =>
    errors[key] ? (
      <p id={`cr-e-${key}`} className="mt-1 text-xs font-extrabold text-loss">
        {errors[key]}
      </p>
    ) : null;
  const common = (key: keyof CloseRdForm) => ({
    id: `cr-${key}`,
    disabled: saving,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `cr-e-${key}` : undefined,
  });

  return (
    <dialog
      ref={ref}
      aria-labelledby="close-rd-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="close-rd-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Close {account.name}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="cr-amount" className="mb-1 block text-xs font-black tracking-wide uppercase">
                Amount received
              </label>
              <input
                {...common("amount")}
                className={INPUT}
                name="amount"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                required
                value={form.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
              {err("amount")}
            </div>
            <div>
              <label htmlFor="cr-date" className="mb-1 block text-xs font-black tracking-wide uppercase">
                Date
              </label>
              <input
                {...common("date")}
                name="date"
                type="date"
                max={todayIndia()}
                required
                className={INPUT}
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
              />
              {err("date")}
            </div>
          </div>
          <div>
            <label htmlFor="cr-account_id" className="mb-1 block text-xs font-black tracking-wide uppercase">
              Received in
            </label>
            <Select
              id="cr-account_id"
              value={form.account_id}
              options={options}
              disabled={saving}
              invalid={Boolean(errors.account_id)}
              describedBy={errors.account_id ? "cr-e-account_id" : undefined}
              onChange={(value) => set("account_id", value)}
            />
            {err("account_id")}
          </div>
          <p className="text-sm font-bold text-zinc-600">
            Balance {formatRupees(account.balance)}. The difference is recorded as interest, or as a fee if you received less.
            The RD is then archived.
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
            className={buttonClass("alt")}
          >
            CANCEL
          </button>
          <button
            type="submit"
            disabled={saving}
            className={buttonClass("primary")}
          >
            {saving ? "CLOSING..." : "CLOSE RD"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
