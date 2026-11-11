"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, cleanMoney, errorMessage, formatRupees, headlineBalance, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { DIALOG, INPUT, PRIMARY, QUIET, SECONDARY } from "@/components/investments/shared";
import { Select } from "@/components/ui/select";
import { type EarmarkAction, type EarmarkForm, type EarmarkLine, type HistoryLine, earmarkFormBlank, earmarkPayload } from "@/lib/goals";
import { whole } from "@/lib/recurring";
import { todayIndia } from "@/lib/transactions";

const FIELDS = ["account_id", "amount", "date", "note"] as const;
type Key = (typeof FIELDS)[number];

// Money is only set aside from spending accounts; investments and deposits go in as whole holdings.
const SOURCE_TYPES = new Set(["bank", "cash", "wallet"]);

type Props = {
  goal: { id: number; name: string };
  action: EarmarkAction;
  // What the goal has set aside now, by account: a release can only come from these.
  earmarks?: EarmarkLine[];
  initialAmount?: string;
  onClose: () => void;
  // `release` is the saved release when the owner asked to record an expense for it next.
  onSaved: (release: HistoryLine | null) => void;
  onConflict: (message: string) => void;
};

// Set money aside for a goal, or release some. Nothing moves: the account's balance stays the same.
export function EarmarkDialog({ goal, action, earmarks = [], initialAmount = "", onClose, onSaved, onConflict }: Props) {
  const releasing = action === "release";
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [today] = useState(() => todayIndia());
  const [form, setForm] = useState<EarmarkForm>(() => {
    const blank = { ...earmarkFormBlank(goal.id, action, today), amount: initialAmount };
    if (releasing && earmarks.length === 1) blank.account_id = String(earmarks[0].account_id);
    return blank;
  });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (releasing) return;
    let current = true;
    apiFetch<AccountList>("/accounts")
      .then((list) => {
        if (!current) return;
        const sources = list.accounts.filter((a) => SOURCE_TYPES.has(a.type));
        setAccounts(sources);
        if (sources.length === 1) setForm((f) => (f.account_id === "" ? { ...f, account_id: String(sources[0].id) } : f));
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) void logout();
        else setAccountsFailed(true);
      });
    return () => {
      current = false;
    };
  }, [releasing]);

  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const recordExpense = releasing && submitter instanceof HTMLButtonElement && submitter.value === "record";
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      await apiFetch(`/goals/${goal.id}/earmarks`, { method: "POST", body: JSON.stringify(earmarkPayload(form)) });
      if (recordExpense) {
        const line = earmarks.find((e) => String(e.account_id) === form.account_id);
        onSaved({
          id: 0,
          account_id: Number(form.account_id),
          account_name: line?.account_name ?? "",
          amount: `-${cleanMoney(form.amount)}`,
          date: form.date || today,
          note: form.note.trim() || null,
        });
      } else {
        onSaved(null);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, FIELDS);
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
      <label htmlFor={`e-${key}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {hint ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
      {errors[key] ? (
        <p id={`ee-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props = (key: Exclude<Key, "account_id">) => ({
    id: `e-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `ee-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });

  const options = releasing
    ? earmarks.map((e) => ({ value: String(e.account_id), label: `${e.account_name} · ${whole(e.amount)} set aside` }))
    : accounts.map((a) => ({ value: String(a.id), label: `${a.name} · ${formatRupees(headlineBalance(a))} free` }));
  const placeholder = releasing
    ? "Choose an account"
    : accountsFailed
      ? "Couldn't load accounts"
      : "Choose a bank, cash or wallet account";
  const title = releasing ? `Release from ${goal.name}` : `Set aside for ${goal.name}`;

  return (
    <dialog
      ref={ref}
      aria-labelledby="earmark-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(28rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="earmark-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold [overflow-wrap:anywhere] dark:border-zinc-800">
          {title}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {releasing
              ? "The money stays in the account and is free to spend again. To record what you spent it on, release and record an expense."
              : "No money moves. The account keeps its balance and shows this much less as free."}
          </p>
          {field(
            "account_id",
            releasing ? "Release from" : "Set aside in",
            <Select
              id="e-account_id"
              value={form.account_id}
              disabled={saving}
              invalid={Boolean(errors.account_id)}
              describedBy={errors.account_id ? "ee-account_id" : undefined}
              placeholder={placeholder}
              options={options}
              onChange={(value) => set("account_id", value)}
            />,
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {field("amount", "Amount (₹)", <input {...props("amount")} type="text" inputMode="decimal" autoComplete="off" required />)}
            {field("date", "Date", <input {...props("date")} type="date" max={today} required />)}
          </div>
          {field("note", "Note (optional)", <input {...props("note")} type="text" autoComplete="off" maxLength={200} />)}

          {formError ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {formError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          {/* First in the DOM so Enter releases only; shown last. */}
          <button ref={submitRef} type="submit" name="then" value="done" className={`${PRIMARY} order-last`} disabled={saving}>
            {saving ? "Saving..." : releasing ? "Release" : "Set aside"}
          </button>
          {releasing && (
            <button type="submit" name="then" value="record" className={SECONDARY} disabled={saving}>
              Release and record an expense
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
