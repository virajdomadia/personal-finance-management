"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage, formatFullDate, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { DIALOG, INPUT, PRIMARY, QUIET } from "@/components/investments/shared";
import { Select } from "@/components/ui/select";
import { type Policy, type RenewForm, cardBillText, renewFormFrom, renewPayload } from "@/lib/insurance";
import { todayIndia } from "@/lib/transactions";

const FIELDS = ["date", "amount", "account_id", "period_start", "period_end", "sum_insured"] as const;
type Key = (typeof FIELDS)[number];

type Props = {
  policy: Policy;
  onClose: () => void;
  onRenewed: () => void;
};

// One form for the premium payment and the new policy year. The server records both or neither.
export function RenewDialog({ policy, onClose, onRenewed }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [today] = useState(() => todayIndia());
  const [form, setForm] = useState<RenewForm>(() => renewFormFrom(policy, today));
  const [accounts, setAccounts] = useState<Account[]>([]);
  // A card bill due before the funding RD matures: worth knowing while paying the premium.
  const cardBill = cardBillText(policy);
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

  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      await apiFetch(`/insurance/${policy.id}/renew`, { method: "POST", body: JSON.stringify(renewPayload(form)) });
      onRenewed();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, FIELDS);
        setErrors(fields);
        if (general.length > 0) setFormError(general.join(" "));
      } else {
        needFocus.current = true;
        setFormError(errorMessage(err));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const field = (key: Key, label: string, input: React.ReactNode) => (
    <div>
      <label htmlFor={`r-${key}`} className="mb-1 block text-xs font-black tracking-wide uppercase">
        {label}
      </label>
      {input}
      {errors[key] ? (
        <p id={`re-${key}`} className="mt-1 text-xs font-extrabold text-loss">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props = (key: Key) => ({
    id: `r-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `re-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });

  return (
    <dialog
      ref={ref}
      aria-labelledby="renew-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(32rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="renew-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black [overflow-wrap:anywhere]">
          Renew {policy.insurer}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <p className="text-sm font-bold text-zinc-700">
            This records the premium as an expense and moves the policy to its new year, together. The current year ends{" "}
            {formatFullDate(policy.period_end)}.
          </p>
          {cardBill && (
            <p role="note" className="rounded-[14px] border-[2.5px] border-ink bg-due px-3 py-2 text-sm font-bold text-ink">
              <span className="font-black">Heads up. </span>
              {cardBill}
            </p>
          )}

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-xs font-black tracking-wide uppercase">Payment</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field("date", "Paid on", <input {...props("date")} type="date" max={today} required />)}
              {field(
                "amount",
                "Premium (₹)",
                <input {...props("amount")} type="text" inputMode="decimal" autoComplete="off" required />,
              )}
            </div>
            {field(
              "account_id",
              "Paid from",
              <Select
                id="r-account_id"
                value={form.account_id}
                disabled={saving}
                invalid={Boolean(errors.account_id)}
                describedBy={errors.account_id ? "re-account_id" : undefined}
                placeholder={accountsFailed ? "Couldn't load accounts" : "Choose an account"}
                options={[
                  ...accounts.map((a) => ({ value: String(a.id), label: a.name })),
                  // The paying account may be archived; keep it shown so the form isn't blank.
                  ...(accounts.some((a) => String(a.id) === form.account_id)
                    ? []
                    : [{ value: form.account_id, label: policy.paying_account_name }]),
                ]}
                onChange={(value) => set("account_id", value)}
              />,
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-xs font-black tracking-wide uppercase">New policy year</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field("period_start", "Starts", <input {...props("period_start")} type="date" required />)}
              {field("period_end", "Ends", <input {...props("period_end")} type="date" required />)}
            </div>
            {field(
              "sum_insured",
              "Sum insured (₹)",
              <input {...props("sum_insured")} type="text" inputMode="decimal" autoComplete="off" required />,
            )}
          </fieldset>

          {formError ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {formError}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
          <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button ref={submitRef} type="submit" className={PRIMARY} disabled={saving}>
            {saving ? "Renewing..." : "Renew policy"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
