"use client";

import { useEffect, useRef, useState } from "react";

import { Select } from "@/components/ui/select";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError } from "@/lib/api";
import { type CorporateAction, cleanPercent, describeAction, ratioProblem } from "@/lib/corporate-actions";
import type { Stock } from "@/lib/investments";

import { DIALOG, INPUT, PRIMARY, QUIET, isUnauthorized } from "./shared";
import { logout } from "@/app/login/actions";

// A merger or demerger can only be confirmed once it says which stock the shares move into, how
// many new shares come for how many held (the exchange's notice never says), and, for a demerger,
// what share of the cost goes there.
export function needsTarget(a: Pick<CorporateAction, "kind">): boolean {
  return a.kind === "merger" || a.kind === "demerger";
}

// What the dialog adds to the PATCH that confirms the action.
export type TargetFields = {
  target_stock_id: number;
  ratio_new: string;
  ratio_old: string;
  cost_share_pct?: string;
};

export function TargetDialog({
  action,
  stocks,
  onClose,
  onConfirm,
}: {
  action: CorporateAction;
  stocks: Stock[];
  onClose: () => void;
  // Resolves to an error message (shown here) or null when it worked.
  onConfirm: (fields: TargetFields) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const demerger = action.kind === "demerger";
  const [target, setTarget] = useState(action.target_stock_id !== null ? String(action.target_stock_id) : "");
  const [pct, setPct] = useState(action.cost_share_pct ?? "");
  const [ratioNew, setRatioNew] = useState(action.ratio_new ?? "");
  const [ratioOld, setRatioOld] = useState(action.ratio_old ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const options = stocks.filter((s) => s.id !== action.stock_id).map((s) => ({ value: String(s.id), label: `${s.symbol} · ${s.name}` }));

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    if (target === "") {
      setError("Pick the stock the shares move into.");
      return;
    }
    const badRatio = ratioProblem(ratioNew, ratioOld);
    if (badRatio !== null) {
      setError(badRatio);
      return;
    }
    if (demerger && (pct === "" || Number(pct) <= 0 || Number(pct) >= 100)) {
      setError("Enter the share of cost that moves, above 0 and below 100.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const message = await onConfirm({
      target_stock_id: Number(target),
      ratio_new: ratioNew,
      ratio_old: ratioOld,
      ...(demerger ? { cost_share_pct: pct } : {}),
    });
    savingRef.current = false;
    setSaving(false);
    if (message !== null) setError(message);
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="target-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(28rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate>
        <h2 id="target-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Confirm {action.symbol} {demerger ? "demerger" : "merger"}
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="text-sm text-zinc-600">{describeAction(action)}</p>
          <div>
            <span id="target-label" className="mb-1 block text-xs font-black tracking-wide uppercase">
              {demerger ? "New company's stock" : "Merged into"}
            </span>
            <Select ariaLabel={demerger ? "New company's stock" : "Merged into"} value={target} options={options} onChange={setTarget} disabled={saving} />
            {options.length === 0 && <p className="mt-1 text-xs font-bold text-zinc-600">Add the other stock first, then come back.</p>}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="target-new" className="mb-1 block text-xs font-black tracking-wide uppercase">
                New shares
              </label>
              <input
                id="target-new"
                className={INPUT}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                disabled={saving}
                value={ratioNew}
                onChange={(e) => setRatioNew(cleanPercent(e.target.value))}
              />
            </div>
            <div>
              <label htmlFor="target-old" className="mb-1 block text-xs font-black tracking-wide uppercase">
                For shares held
              </label>
              <input
                id="target-old"
                className={INPUT}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                disabled={saving}
                value={ratioOld}
                onChange={(e) => setRatioOld(cleanPercent(e.target.value))}
              />
            </div>
          </div>
          {demerger && (
            <div>
              <label htmlFor="target-pct" className="mb-1 block text-xs font-black tracking-wide uppercase">
                Share of cost that moves (%)
              </label>
              <input
                id="target-pct"
                className={INPUT}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                disabled={saving}
                value={pct}
                onChange={(e) => setPct(cleanPercent(e.target.value))}
              />
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
          <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={saving}>
            {saving ? "Confirming..." : "Confirm"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

// Turns a failed request into text for the screen: a 401 signs out, a 409 or 422 shows the server's words.
export function failureMessage(err: unknown): string {
  if (isUnauthorized(err)) {
    void logout();
    return "";
  }
  if (err instanceof ApiError && err.status === 422) {
    const { fields, general } = splitErrors(err.body, ["target_stock_id", "cost_share_pct", "ratio_new", "ratio_old", "amount_per_share", "ex_date"]);
    const all = [...Object.values(fields), ...general];
    if (all.length > 0) return all.join(" ");
  }
  return errorMessage(err);
}
