"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import type { Coin } from "@/lib/crypto";

import { DIALOG, INPUT, PRIMARY, QUIET } from "./shared";

type Key = "name" | "symbol";

// Fixes a coin's ticker or name. Trades and prices stay with it.
export function CoinDialog({
  coin,
  onClose,
  onSaved,
  onConflict,
}: {
  coin: Coin;
  onClose: () => void;
  onSaved: (saved: Coin) => void;
  onConflict: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<Record<Key, string>>(() => ({ name: coin.name, symbol: coin.symbol }));
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
    if (form.name === coin.name && form.symbol === coin.symbol) {
      ref.current?.close();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const payload: Record<string, string> = {};
      if (form.name !== coin.name) payload.name = form.name;
      if (form.symbol !== coin.symbol) payload.symbol = form.symbol;
      onSaved(await apiFetch<Coin>(`/investments/coins/${coin.id}`, { method: "PATCH", body: JSON.stringify(payload) }));
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
    id: `c-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `ce-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const error = (key: Key) =>
    errors[key] ? (
      <p id={`ce-${key}`} className="mt-1 text-xs text-red-700 dark:text-red-400">
        {errors[key]}
      </p>
    ) : null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="coin-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(26rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate>
        <h2 id="coin-dialog-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold dark:border-zinc-800">
          Rename coin
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <label htmlFor="c-name" className="mb-1 block text-sm font-medium">
              Coin name
            </label>
            <input {...input("name")} type="text" autoComplete="off" maxLength={60} required className={INPUT} />
            {error("name")}
          </div>
          <div>
            <label htmlFor="c-symbol" className="mb-1 block text-sm font-medium">
              Ticker
            </label>
            <input {...input("symbol")} type="text" autoComplete="off" maxLength={20} required className={`${INPUT} uppercase`} />
            {error("symbol")}
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
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
