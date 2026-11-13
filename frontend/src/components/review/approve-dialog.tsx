"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type ApproveResult,
  type ConfidentSummary,
  type ReviewItem,
  approveBody,
  approveButtonText,
  categoryTotalText,
  confidentTotalsText,
} from "@/lib/review";
import { buttonClass } from "@/components/ui/chunky";

type Props = {
  items: ReviewItem[]; // the whole list; only the confident ones are sent
  summary: ConfidentSummary;
  onClose: () => void;
  onDone: (result: ApproveResult) => void;
};

// The confirmation before "Approve all confident": what will be categorised, as the server totals
// it, so nothing is recorded without the owner seeing it first.
export function ApproveDialog({ items, summary, onClose, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function approve() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<ApproveResult>("/sms/review/approve", {
        method: "POST",
        body: JSON.stringify(approveBody(items, summary)),
      });
      onDone(result);
      ref.current?.close();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logout();
      else setError(errorMessage(err));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const totals = confidentTotalsText(summary);

  return (
    <dialog
      ref={ref}
      aria-labelledby="approve-title"
      aria-describedby="approve-totals"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <div className="flex max-h-[90vh] flex-col">
        <h2 id="approve-title" className="border-b-[2.5px] border-ink bg-green px-5 py-3 text-lg font-black">
          {approveButtonText(summary)}?
        </h2>
        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          <p id="approve-totals" className="text-base font-black tabular-nums">
            {totals}
          </p>
          <ul className="flex flex-col divide-y-[1.5px] divide-dashed divide-zinc-300 rounded-[14px] border-[2.5px] border-ink">
            {summary.categories.map((c) => (
              <li
                key={`${c.type}-${c.category}`}
                className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm font-extrabold"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">{categoryTotalText(c)}</span>
                <span className="shrink-0 text-xs font-bold text-zinc-600">{c.type === "income" ? "in" : "out"}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm font-bold text-zinc-600">
            Each one gets the category shown. The money is already in your records; nothing else changes. Anything
            that changed since you opened this page is left for you to check.
          </p>
          {error ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink px-5 py-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => ref.current?.close()}
            className={`${buttonClass("alt")} uppercase`}
          >
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={approve} className={`${buttonClass("green")} uppercase`}>
            {saving ? "Approving..." : `Approve ${summary.count}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}
