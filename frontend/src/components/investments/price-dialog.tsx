"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { Price, Stock } from "@/lib/investments";
import { formatDate, todayIndia } from "@/lib/transactions";

import { DIALOG, INPUT, PRIMARY, QUIET } from "./shared";

type Key = "date" | "price";

export function PriceDialog({
  stock,
  onClose,
  onSaved,
  onConflict,
}: {
  stock: Stock;
  onClose: () => void;
  onSaved: (saved: Price) => void;
  onConflict: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<Record<Key, string>>(() => ({ date: todayIndia(), price: "" }));
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
      const price = cleanMoney(form.price);
      onSaved(
        await apiFetch<Price>(`/investments/stocks/${stock.id}/prices`, {
          method: "POST",
          body: JSON.stringify({ date: form.date || null, price: price === "" ? null : price }),
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, ["date", "price"]);
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
    id: `p-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `pe-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const error = (key: Key) =>
    errors[key] ? (
      <p id={`pe-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
        {errors[key]}
      </p>
    ) : null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="price-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(26rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate>
        <h2 id="price-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold dark:border-zinc-800">
          Update price of {stock.symbol}
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {stock.price !== null && stock.price_date !== null
              ? `Last recorded ${formatRupees(stock.price)} on ${formatDate(stock.price_date)}.`
              : "No price recorded yet, so holdings are valued at cost."}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="p-price" className="mb-1 block text-sm font-medium">
                Price per share (₹)
              </label>
              <input {...input("price")} type="text" inputMode="decimal" autoComplete="off" required />
              {error("price")}
            </div>
            <div>
              <label htmlFor="p-date" className="mb-1 block text-sm font-medium">
                As of
              </label>
              <input {...input("date")} type="date" max={todayIndia()} required />
              {error("date")}
            </div>
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
            {saving ? "Saving..." : "Save price"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
