"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { Fund } from "@/lib/funds";

import { DIALOG, INPUT, PRIMARY, QUIET } from "./shared";

type Key = "name" | "symbol";

// Fixes a fund's name or short name. Transactions, NAVs and SIPs stay with it.
export function FundDialog({
  fund,
  onClose,
  onSaved,
  onConflict,
}: {
  fund: Fund;
  onClose: () => void;
  onSaved: (saved: Fund) => void;
  onConflict: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<Record<Key, string>>(() => ({ name: fund.name, symbol: fund.symbol }));
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
    if (form.name === fund.name && form.symbol === fund.symbol) {
      ref.current?.close();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      // A blank short name keeps the current one.
      const payload: Record<string, string> = {};
      if (form.name !== fund.name) payload.name = form.name;
      if (form.symbol !== fund.symbol) payload.symbol = form.symbol;
      onSaved(await apiFetch<Fund>(`/investments/funds/${fund.id}`, { method: "PATCH", body: JSON.stringify(payload) }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, ["name", "symbol"]);
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
    id: `f-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `fe-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const error = (key: Key) =>
    errors[key] ? (
      <p id={`fe-${key}`} className="mt-1 text-xs font-extrabold text-loss">
        {errors[key]}
      </p>
    ) : null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="fund-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(26rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate>
        <h2 id="fund-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Rename fund
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <label htmlFor="f-name" className="mb-1 block text-xs font-black tracking-wide uppercase">
              Fund name
            </label>
            <input {...input("name")} type="text" autoComplete="off" maxLength={60} required className={INPUT} />
            {error("name")}
          </div>
          <div>
            <label htmlFor="f-symbol" className="mb-1 block text-xs font-black tracking-wide uppercase">
              Short name
            </label>
            <input {...input("symbol")} type="text" autoComplete="off" maxLength={20} className={`${INPUT} uppercase`} />
            {error("symbol")}
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
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
