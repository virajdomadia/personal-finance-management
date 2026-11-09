"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, cleanMoney, errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Fund, type Sip, type SipForm, blankSipForm, sipFormFrom, sipPayload } from "@/lib/funds";
import { todayIndia } from "@/lib/transactions";
import { Select } from "@/components/ui/select";

import { NEW_FUND } from "./fund-trade-dialog";
import { DIALOG, INPUT, PRIMARY, QUIET } from "./shared";

const MONEY = /^\d+(?:\.\d{1,2})?$/;
const RENDERED = ["fund_id", "account_id", "amount", "day", "start_date"] as const;

type Form = SipForm & { name: string; symbol: string };
type Key = keyof Omit<Form, "active">;

type Props = {
  sip: Sip | null; // null means adding
  funds: Fund[];
  banks: Account[]; // active bank accounts
  defaultFundId?: number | null;
  onClose: () => void;
  onSaved: (saved: Sip) => void;
  onConflict: (message: string) => void;
  onFundCreated: (fund: Fund) => void;
};

function startForm(props: Props): Form {
  if (props.sip) return { ...sipFormFrom(props.sip), name: "", symbol: "" };
  const form: Form = { ...blankSipForm(todayIndia()), name: "", symbol: "" };
  if (props.defaultFundId != null) form.fund_id = String(props.defaultFundId);
  else if (props.funds.length === 0) form.fund_id = NEW_FUND;
  if (props.banks.length === 1) form.account_id = String(props.banks[0].id);
  return form;
}

function localErrors(form: Form, editing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!editing) {
    if (form.fund_id === NEW_FUND) {
      if (form.name.trim() === "") errors.name = "Enter a name.";
    } else if (form.fund_id === "") errors.fund_id = "Choose a fund.";
    if (form.start_date === "") errors.start_date = "Choose the first instalment's date.";
  }
  if (form.account_id === "") errors.account_id = "Choose a bank account.";
  const amount = cleanMoney(form.amount);
  if (amount === "") errors.amount = "Enter the SIP amount.";
  else if (!MONEY.test(amount)) errors.amount = "Enter an amount, like 3000.";
  else if (Number(amount) <= 0) errors.amount = "Amount must be greater than 0.";
  const day = form.day.trim();
  if (!/^\d{1,2}$/.test(day) || Number(day) < 1 || Number(day) > 31) errors.day = "Choose a day from 1 to 31.";
  return errors;
}

// What an edit sends: only what changed.
function changed(form: SipForm, original: Sip): Record<string, unknown> {
  const before = sipPayload(sipFormFrom(original), "edit");
  const after = sipPayload(form, "edit");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) result[key] = after[key];
  }
  return result;
}

// Adds a monthly SIP, or changes its amount, debit day or bank account. A SIP never posts on its
// own: it shows as due each month until the instalment is recorded.
export function SipDialog(props: Props) {
  const { sip, banks, onClose, onSaved, onConflict, onFundCreated } = props;
  const editing = sip !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<Form>(() => startForm(props));
  const [funds, setFunds] = useState<Fund[]>(props.funds);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
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
    const local = localErrors(form, editing);
    if (Object.keys(local).length > 0) {
      needFocus.current = true;
      setFormError(null);
      setErrors(local);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      let current: SipForm = form;
      if (!editing && form.fund_id === NEW_FUND) {
        let created: Fund;
        try {
          const symbol = form.symbol.trim();
          created = await apiFetch<Fund>("/investments/funds", {
            method: "POST",
            body: JSON.stringify({ name: form.name, symbol: symbol === "" ? null : symbol }),
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 422) {
            needFocus.current = true;
            const { fields, general } = splitErrors(err.body, ["name", "symbol"]);
            setErrors(fields);
            if (general.length > 0) setFormError(general.join(" "));
            return;
          }
          throw err;
        }
        setFunds((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
        setForm((f) => ({ ...f, fund_id: String(created.id), name: "", symbol: "" }));
        onFundCreated(created);
        current = { ...form, fund_id: String(created.id) };
      }

      if (editing) {
        const payload = changed(current, sip);
        if (Object.keys(payload).length === 0) {
          ref.current?.close();
          return;
        }
        onSaved(await apiFetch<Sip>(`/investments/sips/${sip.id}`, { method: "PATCH", body: JSON.stringify(payload) }));
      } else {
        onSaved(await apiFetch<Sip>("/investments/sips", { method: "POST", body: JSON.stringify(sipPayload(current, "create")) }));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, RENDERED);
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

  const field = (key: Key, label: string, input: React.ReactNode, hint?: React.ReactNode) => (
    <div>
      <label htmlFor={`sip-${key}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {hint}
      {errors[key] ? (
        <p id={`sipe-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const inputProps = (key: Key) => ({
    id: `sip-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `sipe-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const pickerProps = (key: Key) => ({
    id: `sip-${key}`,
    value: form[key],
    disabled: saving,
    invalid: Boolean(errors[key]),
    describedBy: errors[key] ? `sipe-${key}` : undefined,
    onChange: (value: string) => set(key, value),
  });

  const fundOptions = [
    ...funds.map((f) => ({ value: String(f.id), label: f.name })),
    { value: NEW_FUND, label: "New fund..." },
  ];
  const bankOptions = banks.map((b) => ({ value: String(b.id), label: b.name }));
  const title = editing ? `Edit SIP in ${sip.fund_name}` : "Add SIP";
  const closeButton = (
    <button type="button" disabled={saving} onClick={() => ref.current?.close()} className={QUIET}>
      Cancel
    </button>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby="sip-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(28rem,calc(100vw-2rem))]`}
    >
      {banks.length === 0 ? (
        <div>
          <h2 id="sip-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold dark:border-zinc-800">
            {title}
          </h2>
          <div className="px-5 py-4">
            <p className="text-sm font-medium">Add a bank account first</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">A SIP is debited from a bank account each month.</p>
          </div>
          <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
            {closeButton}
            <Link href="/accounts" className={PRIMARY}>
              Go to accounts
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
          <h2 id="sip-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold [overflow-wrap:anywhere] dark:border-zinc-800">
            {title}
          </h2>
          <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
            {!editing && field("fund_id", "Fund", <Select {...pickerProps("fund_id")} placeholder="Choose a fund" options={fundOptions} />)}

            {!editing && form.fund_id === NEW_FUND && (
              <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
                {field(
                  "name",
                  "Fund name",
                  <input {...inputProps("name")} type="text" autoComplete="off" maxLength={60} placeholder="Parag Parikh Flexi Cap" />,
                )}
                {field(
                  "symbol",
                  "Short name (optional)",
                  <input {...inputProps("symbol")} type="text" autoComplete="off" maxLength={20} placeholder="PPFAS" className={`${INPUT} uppercase`} />,
                )}
              </div>
            )}

            {field("account_id", "Bank account", <Select {...pickerProps("account_id")} placeholder="Choose a bank account" options={bankOptions} />)}

            <div className="grid grid-cols-2 gap-4">
              {field("amount", "Monthly amount (₹)", <input {...inputProps("amount")} type="text" inputMode="decimal" autoComplete="off" required />)}
              {field(
                "day",
                "Debit day",
                <input {...inputProps("day")} type="text" inputMode="numeric" autoComplete="off" placeholder="5" required />,
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">1 to 31. Short months use their last day.</p>,
              )}
            </div>

            {!editing &&
              field(
                "start_date",
                "First instalment",
                <input {...inputProps("start_date")} type="date" required />,
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Months from here on show as due until you record them.</p>,
              )}

            <p className="rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
              Nothing is recorded on its own. Each month the SIP shows as due, and you record it with that day&apos;s NAV.
            </p>

            {formError ? (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">
                {formError}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
            {closeButton}
            <button ref={submitRef} type="submit" disabled={saving} className={PRIMARY}>
              {saving ? "Saving..." : editing ? "Save changes" : "Add SIP"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
