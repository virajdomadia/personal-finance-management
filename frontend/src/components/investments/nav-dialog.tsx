"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Fund, type Nav, formatNav } from "@/lib/funds";
import { formatDate, todayIndia } from "@/lib/transactions";

import { DIALOG, INPUT, PRIMARY, QUIET } from "./shared";

type Key = "date" | "nav";

// Records a fund's NAV for a day, like "Update price" for a stock.
export function NavDialog({
  fund,
  onClose,
  onSaved,
  onConflict,
}: {
  fund: Fund;
  onClose: () => void;
  onSaved: (saved: Nav) => void;
  onConflict: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<Record<Key, string>>(() => ({ date: todayIndia(), nav: "" }));
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const nav = form.nav.trim();
      onSaved(
        await apiFetch<Nav>(`/investments/funds/${fund.id}/navs`, {
          method: "POST",
          body: JSON.stringify({ date: form.date || null, nav: nav === "" ? null : nav }),
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, ["date", "nav"]);
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

  const input = (key: Key) => ({
    id: `n-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `ne-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const error = (key: Key) =>
    errors[key] ? (
      <p id={`ne-${key}`} className="mt-1 text-xs font-extrabold text-loss">
        {errors[key]}
      </p>
    ) : null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="nav-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(26rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate>
        <h2 id="nav-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Update NAV of {fund.name}
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="text-sm text-zinc-600">
            {fund.nav !== null && fund.nav_date !== null
              ? `Last recorded ${formatNav(fund.nav)} on ${formatDate(fund.nav_date)}.`
              : "No NAV recorded yet, so holdings are valued at cost."}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="n-nav" className="mb-1 block text-xs font-black tracking-wide uppercase">
                NAV (₹)
              </label>
              <input {...input("nav")} type="text" inputMode="decimal" autoComplete="off" placeholder="84.3793" required />
              {error("nav")}
            </div>
            <div>
              <label htmlFor="n-date" className="mb-1 block text-xs font-black tracking-wide uppercase">
                As of
              </label>
              <input {...input("date")} type="date" max={todayIndia()} required />
              {error("date")}
            </div>
          </div>
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
            {saving ? "Saving..." : "Save NAV"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
