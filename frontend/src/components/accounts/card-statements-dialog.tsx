"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CardStatement,
  type StatementForm,
  type StatementList,
  billLines,
  blankStatementForm,
  statementForm,
  statementPayload,
} from "@/lib/card-statements";
import { formatDate, todayIndia } from "@/lib/transactions";
import { FOCUS, buttonClass } from "@/components/ui/chunky";

const INPUT = `w-full rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold outline-none disabled:opacity-60 aria-[invalid=true]:border-loss aria-[invalid=true]:bg-pink/10 ${FOCUS}`;
const LABEL = "mb-1 block text-xs font-black tracking-wide uppercase";
const ROW_ACTION = `${buttonClass("alt")} !px-2.5 !py-1`;
const RENDERED = ["statement_date", "total_due", "minimum_due", "due_date"];

type Props = {
  card: Account;
  onClose: () => void;
  onChanged: () => void; // a statement was added, changed or removed
};

// A credit card's statements: where the current bill stands, what was spent since, and the
// statements themselves, which can be entered by hand, corrected or removed.
export function CardStatementsDialog({ card, onClose, onChanged }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [list, setList] = useState<StatementList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // null: no form open; "new": adding; a statement: editing it.
  const [editing, setEditing] = useState<CardStatement | "new" | null>(null);
  const [form, setForm] = useState<StatementForm>(() => blankStatementForm(todayIndia()));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await apiFetch<StatementList>(`/accounts/${card.id}/statements`));
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logout();
      else setLoadError(errorMessage(err));
    }
  }, [card.id]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // The first load; `load` reloads after a change.
  useEffect(() => {
    let current = true;
    apiFetch<StatementList>(`/accounts/${card.id}/statements`)
      .then((found) => {
        if (current) setList(found);
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) void logout();
        else setLoadError(errorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [card.id]);

  const open = (target: CardStatement | "new") => {
    setEditing(target);
    setForm(target === "new" ? blankStatementForm(todayIndia()) : statementForm(target));
    setErrors({});
    setFormError(null);
  };

  async function run(action: () => Promise<unknown>) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      await action();
      setEditing(null);
      onChanged();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        const { fields, general } = splitErrors(err.body, RENDERED);
        setErrors(fields);
        if (general.length > 0) setFormError(general.join(" "));
      } else {
        setFormError(errorMessage(err));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = JSON.stringify(statementPayload(form));
    void run(() =>
      editing === "new" || editing === null
        ? apiFetch(`/accounts/${card.id}/statements`, { method: "POST", body })
        : apiFetch(`/card-statements/${editing.id}`, { method: "PATCH", body }),
    );
  };

  const field = (key: keyof StatementForm, label: string, input: React.ReactNode) => (
    <div>
      <label htmlFor={`cs-${key}`} className={LABEL}>
        {label}
      </label>
      {input}
      {errors[key] ? (
        <p id={`cs-e-${key}`} className="mt-1 text-xs font-extrabold text-loss">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props = (key: keyof StatementForm) => ({
    id: `cs-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `cs-e-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const current = list?.current ?? null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="card-statements-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <div className="flex max-h-[90vh] flex-col">
        <h2 id="card-statements-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          {card.name} statements
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {loadError ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {loadError}
            </p>
          ) : list === null ? (
            <p role="status" className="text-sm font-bold text-zinc-600">
              Loading statements...
            </p>
          ) : (
            <>
              <section aria-label="Current bill" className="rounded-[14px] border-[2.5px] border-ink p-3">
                {current ? (
                  <>
                    <p className="text-xs font-black tracking-wide uppercase">
                      Statement of {formatDate(current.statement.statement_date)}
                    </p>
                    {billLines(current).map((line, i) => (
                      <p key={line} className={i === 0 ? `text-sm font-black ${current.overdue ? "text-loss" : ""}` : "text-sm font-bold text-zinc-600"}>
                        {line}
                      </p>
                    ))}
                  </>
                ) : (
                  <p className="text-sm font-bold text-zinc-600">No statement yet. Add one when it arrives.</p>
                )}
                <p className="mt-1 text-sm font-bold text-zinc-600">
                  Spent since {current ? "the statement" : "the start"}: <span className="tabular-nums">{formatRupees(list.unbilled)}</span>
                </p>
              </section>

              {editing === null ? (
                <div>
                  <button type="button" className={`${buttonClass("primary")} uppercase`} onClick={() => open("new")}>
                    Add statement
                  </button>
                </div>
              ) : (
                <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-[14px] border-[2.5px] border-ink p-3">
                  <p className="text-sm font-black">{editing === "new" ? "New statement" : "Correct statement"}</p>
                  <div className="grid grid-cols-2 gap-3">
                    {field("statement_date", "Statement date", <input {...props("statement_date")} type="date" max={todayIndia()} required />)}
                    {field("due_date", "Due date", <input {...props("due_date")} type="date" min={form.statement_date || undefined} required />)}
                    {field("total_due", "Total due (₹)", <input {...props("total_due")} type="text" inputMode="decimal" autoComplete="off" required />)}
                    {field("minimum_due", "Minimum due (₹)", <input {...props("minimum_due")} type="text" inputMode="decimal" autoComplete="off" placeholder="Optional" />)}
                  </div>
                  {formError ? (
                    <p role="alert" className="text-sm font-extrabold text-loss">
                      {formError}
                    </p>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <button type="button" disabled={saving} className={`${buttonClass("alt")} uppercase`} onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button type="submit" disabled={saving} className={`${buttonClass("primary")} uppercase`}>
                      {saving ? "Saving..." : "Save"}
                    </button>
                  </div>
                </form>
              )}

              {list.statements.length > 0 ? (
                <ul className="flex flex-col gap-2" aria-label="Statements">
                  {list.statements.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b-[1.5px] border-ink/20 pb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-extrabold">
                          {formatDate(s.statement_date)} · <span className="tabular-nums">{formatRupees(s.total_due)}</span>
                          {s.source === "sms" ? <span className="ml-1.5 text-xs font-bold text-zinc-600">from SMS</span> : null}
                        </p>
                        <p className="text-xs font-bold text-zinc-600">
                          Due {formatDate(s.due_date)}
                          {s.minimum_due !== null ? ` · minimum ${formatRupees(s.minimum_due)}` : ""}
                        </p>
                      </div>
                      <div className="flex gap-1.5">
                        <button type="button" className={ROW_ACTION} disabled={saving} aria-label={`Correct the statement of ${s.statement_date}`} onClick={() => open(s)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className={ROW_ACTION}
                          disabled={saving}
                          aria-label={`Delete the statement of ${s.statement_date}`}
                          onClick={() => {
                            if (!window.confirm(`Delete the statement of ${formatDate(s.statement_date)}? This can't be undone.`)) return;
                            void run(() => apiFetch(`/card-statements/${s.id}`, { method: "DELETE" }));
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <div className="flex justify-end border-t-[2.5px] border-ink px-5 py-3">
          <button type="button" disabled={saving} onClick={() => ref.current?.close()} className={`${buttonClass("alt")} uppercase`}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
