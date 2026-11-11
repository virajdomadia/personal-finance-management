"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { Stock } from "@/lib/investments";

import { DIALOG, INPUT, PRIMARY, QUIET } from "./shared";

type Key = "symbol" | "name";

// Fixes a stock's symbol or name. Trades and prices stay with it.
export function StockDialog({
  stock,
  onClose,
  onSaved,
  onConflict,
}: {
  stock: Stock;
  onClose: () => void;
  onSaved: (saved: Stock) => void;
  onConflict: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<Record<Key, string>>(() => ({ symbol: stock.symbol, name: stock.name }));
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
    if (form.symbol === stock.symbol && form.name === stock.name) {
      ref.current?.close();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      onSaved(
        await apiFetch<Stock>(`/investments/stocks/${stock.id}`, {
          method: "PATCH",
          body: JSON.stringify({ symbol: form.symbol, name: form.name }),
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, ["symbol", "name"]);
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
    id: `s-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `se-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const error = (key: Key) =>
    errors[key] ? (
      <p id={`se-${key}`} className="mt-1 text-xs font-extrabold text-loss">
        {errors[key]}
      </p>
    ) : null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="stock-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(26rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate>
        <h2 id="stock-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Rename {stock.symbol}
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <label htmlFor="s-symbol" className="mb-1 block text-xs font-black tracking-wide uppercase">
              Symbol
            </label>
            <input {...input("symbol")} type="text" autoComplete="off" maxLength={20} required className={`${INPUT} uppercase`} />
            {error("symbol")}
          </div>
          <div>
            <label htmlFor="s-name" className="mb-1 block text-xs font-black tracking-wide uppercase">
              Company name
            </label>
            <input {...input("name")} type="text" autoComplete="off" maxLength={60} required className={INPUT} />
            {error("name")}
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
