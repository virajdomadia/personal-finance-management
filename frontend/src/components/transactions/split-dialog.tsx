"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type SplitPart, splitLeft } from "@/lib/transactions";
import { FOCUS, buttonClass } from "@/components/ui/chunky";
import { ComboBox } from "@/components/ui/select";

const INPUT = `w-full rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold outline-none disabled:opacity-60 ${FOCUS}`;
const LABEL = "mb-1 block text-xs font-black tracking-wide uppercase";

type Split = { id: number; total: string; parts: { id: number; category: string | null; amount: string }[] };

// One bill across several categories: each part becomes its own expense, adding up to the bill.
export function SplitDialog({
  transactionId,
  categories,
  onClose,
  onSaved,
}: {
  transactionId: number;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [total, setTotal] = useState<string | null>(null);
  const [parts, setParts] = useState<SplitPart[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let current = true;
    apiFetch<Split>(`/transactions/${transactionId}/split`)
      .then((split) => {
        if (!current) return;
        setTotal(split.total);
        const loaded = split.parts.map((p) => ({ category: p.category ?? "", amount: p.amount }));
        // An unsplit bill starts as its whole amount plus an empty second part.
        setParts(loaded.length > 1 ? loaded : [...loaded, { category: "", amount: "" }]);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (current) setError(errorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [transactionId]);

  const left = total === null ? "" : splitLeft(total, parts);
  const ready = left === "0.00" && parts.every((p) => p.category.trim() !== "" && p.amount.trim() !== "");
  const change = (i: number, key: keyof SplitPart, value: string) =>
    setParts((ps) => ps.map((p, n) => (n === i ? { ...p, [key]: value } : p)));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/transactions/${transactionId}/split`, { method: "PUT", body: JSON.stringify({ parts }) });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void logout();
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const options = categories.map((name) => ({ value: name, label: name }));
  return (
    <dialog
      ref={ref}
      aria-labelledby="split-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <form onSubmit={save} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="split-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Split {total === null ? "" : formatRupees(total)}
        </h2>
        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          {total === null && error === null ? (
            <p role="status" className="text-sm font-bold text-zinc-600">
              Loading...
            </p>
          ) : null}
          {parts.map((part, i) => (
            <fieldset key={i} disabled={saving} className="flex min-w-0 items-end gap-2">
              <legend className="sr-only">Part {i + 1}</legend>
              <div className="min-w-0 flex-1">
                <label htmlFor={`split-category-${i}`} className={LABEL}>
                  Category
                </label>
                <ComboBox
                  id={`split-category-${i}`}
                  value={part.category}
                  onChange={(value: string) => change(i, "category", value)}
                  options={options}
                  maxLength={40}
                />
              </div>
              <div className="w-32 shrink-0">
                <label htmlFor={`split-amount-${i}`} className={LABEL}>
                  Amount
                </label>
                <input
                  id={`split-amount-${i}`}
                  className={INPUT}
                  inputMode="decimal"
                  autoComplete="off"
                  value={part.amount}
                  onChange={(e) => change(i, "amount", e.target.value)}
                />
              </div>
              {parts.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove part ${i + 1}`}
                  className={`${buttonClass("alt")} !px-3`}
                  onClick={() => setParts((ps) => ps.filter((_, n) => n !== i))}
                >
                  ×
                </button>
              ) : null}
            </fieldset>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              disabled={saving || parts.length >= 20}
              className={buttonClass("alt")}
              onClick={() => setParts((ps) => [...ps, { category: "", amount: left.startsWith("-") ? "" : left === "0.00" ? "" : left }])}
            >
              + Add part
            </button>
            <p aria-live="polite" className={`text-sm font-extrabold ${left === "0.00" ? "text-gain" : "text-loss"}`}>
              {left === "" ? "Check the amounts" : left === "0.00" ? "All assigned" : left.startsWith("-") ? `${formatRupees(left.slice(1))} too much` : `Left to assign ${formatRupees(left)}`}
            </p>
          </div>
          {parts.length === 1 ? <p className="text-xs font-bold text-zinc-600">One part puts the whole bill back together.</p> : null}
          {error ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink px-5 py-3">
          <button type="button" disabled={saving} onClick={() => ref.current?.close()} className={`${buttonClass("alt")} uppercase`}>
            Cancel
          </button>
          <button type="submit" disabled={!ready || saving} className={`${buttonClass("primary")} uppercase`}>
            {saving ? "Saving..." : "Save split"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
