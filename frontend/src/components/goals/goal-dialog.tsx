"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { DIALOG, INPUT, PRIMARY, QUIET } from "@/components/investments/shared";
import { type Goal, type GoalForm, type GoalKind, efText, goalFormBlank, goalFormFrom, goalPayload } from "@/lib/goals";
import { whole } from "@/lib/recurring";

const FIELDS = [
  "name",
  "kind",
  "target_amount",
  "target_date",
  "ef_months",
  "ef_monthly_override",
  "monthly_amount",
  "reminder_day",
  "note",
] as const;
type Key = (typeof FIELDS)[number];

type Props = {
  goal: Goal | null; // null means adding
  // An active emergency fund already exists, so a new goal can only be custom.
  hasEmergency: boolean;
  onClose: () => void;
  onSaved: (saved: Goal) => void;
  onConflict: (message: string) => void;
};

export function GoalDialog({ goal, hasEmergency, onClose, onSaved, onConflict }: Props) {
  const editing = goal !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<GoalForm>(() => (goal ? goalFormFrom(goal) : goalFormBlank("custom")));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const emergency = form.kind === "emergency";

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

  const set = (key: Exclude<Key, "kind">, value: string) => setForm((f) => ({ ...f, [key]: value }));
  // Switching kind starts that kind's blank form, keeping what applies to both.
  const setKind = (kind: GoalKind) =>
    setForm((f) => ({
      ...goalFormBlank(kind),
      name: f.name,
      target_date: f.target_date,
      monthly_amount: f.monthly_amount,
      reminder_day: f.reminder_day,
      note: f.note,
    }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const saved = goal
        ? await apiFetch<Goal>(`/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify(goalPayload(form, "edit")) })
        : await apiFetch<Goal>("/goals", { method: "POST", body: JSON.stringify(goalPayload(form, "create")) });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, FIELDS);
        setErrors(fields);
        if (general.length > 0) setFormError(general.join(" "));
      } else if (err instanceof ApiError && err.status === 409 && !editing) {
        // "You already have an emergency fund.": the owner can make it a custom goal instead.
        needFocus.current = true;
        setFormError(errorMessage(err));
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

  const field = (key: Key, label: string, input: React.ReactNode, hint?: string | null) => (
    <div>
      <label htmlFor={`g-${key}`} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {input}
      {hint ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
      {errors[key] ? (
        <p id={`ge-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props = (key: Exclude<Key, "kind">) => ({
    id: `g-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `ge-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });

  // How the emergency fund's monthly figure is worked out today, when editing one.
  const computed = goal?.ef?.computed ?? null;
  const overrideHint =
    computed === null
      ? editing
        ? "There isn't a full month of spending recorded yet, so enter your own figure."
        : "Leave it blank to use the average of your recorded spending over the last 6 full months."
      : `Leave it blank to use your recorded average, ${whole(computed)} a month.`;

  return (
    <dialog
      ref={ref}
      aria-labelledby="goal-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(32rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="goal-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold dark:border-zinc-800">
          {editing ? `Edit ${goal.name}` : "Add goal"}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          {!editing && (
            <fieldset>
              <legend className="mb-1 block text-sm font-medium">Kind</legend>
              <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="kind"
                    value="custom"
                    checked={form.kind === "custom"}
                    disabled={saving}
                    onChange={() => setKind("custom")}
                  />
                  Saving for something
                </label>
                <label className={`flex items-center gap-2 text-sm ${hasEmergency ? "text-zinc-500 dark:text-zinc-400" : ""}`}>
                  <input
                    type="radio"
                    name="kind"
                    value="emergency"
                    checked={emergency}
                    disabled={saving || hasEmergency}
                    onChange={() => setKind("emergency")}
                  />
                  Emergency fund
                </label>
              </div>
              {hasEmergency && (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">You already have an emergency fund.</p>
              )}
              {errors.kind ? <p className="mt-1 text-xs text-red-700 dark:text-red-400">{errors.kind}</p> : null}
            </fieldset>
          )}

          {field(
            "name",
            "Name",
            <input {...props("name")} type="text" autoComplete="off" maxLength={60} placeholder={emergency ? "Emergency fund" : "Bike"} required />,
          )}

          {emergency ? (
            <>
              {editing && goal.ef && <p className="text-sm text-zinc-600 dark:text-zinc-400">Target now: {efText(goal)}</p>}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {field(
                  "ef_months",
                  "Months of expenses",
                  <input {...props("ef_months")} type="number" inputMode="numeric" min={1} max={24} step={1} required />,
                  "1 to 24.",
                )}
                {field(
                  "ef_monthly_override",
                  "Monthly expenses (₹, optional)",
                  <input {...props("ef_monthly_override")} type="text" inputMode="decimal" autoComplete="off" />,
                )}
              </div>
              <p className="-mt-2 text-xs text-zinc-500 dark:text-zinc-400">{overrideHint}</p>
            </>
          ) : (
            field("target_amount", "Target (₹)", <input {...props("target_amount")} type="text" inputMode="decimal" autoComplete="off" required />)
          )}

          {field("target_date", "Reach it by (optional)", <input {...props("target_date")} type="date" />)}

          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Monthly reminder</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field(
                "monthly_amount",
                "Set aside each month (₹)",
                <input {...props("monthly_amount")} type="text" inputMode="decimal" autoComplete="off" />,
                "Leave it blank for no reminder.",
              )}
              {field(
                "reminder_day",
                "Remind me on day",
                <input
                  {...props("reminder_day")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  step={1}
                  disabled={saving || form.monthly_amount.trim() === ""}
                />,
                "1 to 31. A short month uses its last day.",
              )}
            </div>
          </fieldset>

          <div>
            <label htmlFor="g-note" className="mb-1 block text-sm font-medium">
              Note (optional)
            </label>
            <textarea
              id="g-note"
              name="note"
              rows={2}
              maxLength={200}
              value={form.note}
              disabled={saving}
              className={INPUT}
              aria-invalid={errors.note ? true : undefined}
              aria-describedby={errors.note ? "ge-note" : undefined}
              onChange={(e) => set("note", e.target.value)}
            />
            {errors.note ? (
              <p id="ge-note" className="mt-1 text-xs text-red-700 dark:text-red-400">
                {errors.note}
              </p>
            ) : null}
          </div>

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
            {saving ? "Saving..." : editing ? "Save changes" : "Add goal"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
