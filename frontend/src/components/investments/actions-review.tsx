"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { type CorporateAction, describeAction, describePreview, listActions, updateAction } from "@/lib/corporate-actions";
import { type Stock } from "@/lib/investments";
import { apiFetch } from "@/lib/api";

import { PRIMARY, ROW_ACTION } from "./shared";
import { TargetDialog, failureMessage, needsTarget } from "./target-dialog";

// Shown while there are corporate actions waiting on the user: splits, bonuses and the like that
// the exchange announced and that change what they hold. Nothing is applied until they confirm.
// It loads its own list, and tells the page (onChanged) when a confirm changed the portfolio.
export function ActionsReview({ onChanged }: { onChanged: () => void }) {
  const [actions, setActions] = useState<CorporateAction[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ action: CorporateAction; stocks: Stock[] } | null>(null);
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    listActions("pending")
      .then((res) => {
        if (request === latest.current) setActions(res.actions);
      })
      .catch(() => {
        // A nicety: if it can't load, the page carries on without the card.
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function change(action: CorporateAction, body: Parameters<typeof updateAction>[1]): Promise<string | null> {
    setBusy(action.id);
    setError(null);
    try {
      await updateAction(action.id, body);
      load();
      onChanged();
      return null;
    } catch (err) {
      return failureMessage(err);
    } finally {
      setBusy(null);
    }
  }

  async function confirm(action: CorporateAction) {
    if (needsTarget(action)) {
      setBusy(action.id);
      try {
        const { stocks } = await apiFetch<{ stocks: Stock[] }>("/investments/stocks");
        setTarget({ action, stocks });
      } catch (err) {
        setError(failureMessage(err));
      } finally {
        setBusy(null);
      }
      return;
    }
    const message = await change(action, { status: "applied" });
    if (message) setError(message);
  }

  async function dismiss(action: CorporateAction) {
    const message = await change(action, { status: "dismissed" });
    if (message) setError(message);
  }

  if (actions.length === 0) return null;
  return (
    <section aria-labelledby="actions-review-title" className="rounded-[18px] border-[2.5px] border-ink bg-yellow p-4 text-ink shadow-chunky">
      <h2 id="actions-review-title" className="text-lg font-black">
        {actions.length === 1 ? "A corporate action needs your OK" : `${actions.length} corporate actions need your OK`}
      </h2>
      <p className="mt-0.5 text-sm font-bold">Confirm each one that applies to you and your shares and average cost update.</p>
      {error ? (
        <p role="alert" className="mt-3 rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold text-loss">
          {error}
        </p>
      ) : null}
      <ul className="mt-3 flex flex-col gap-2">
        {actions.map((a) => {
          const preview = describePreview(a.preview);
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2">
              <div className="min-w-40 flex-1">
                <p className="text-sm font-extrabold [overflow-wrap:anywhere]">
                  <Link href={`/investments/${a.stock_id}`} className="underline hover:text-zinc-700">
                    {a.symbol}
                  </Link>{" "}
                  {describeAction(a)}
                </p>
                {preview && <p className="text-xs font-bold text-zinc-600">{preview}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className={ROW_ACTION} disabled={busy !== null} aria-label={`Dismiss ${a.symbol}: ${describeAction(a)}`} onClick={() => void dismiss(a)}>
                  Dismiss
                </button>
                <button
                  type="button"
                  className={`${PRIMARY} !px-2.5 !py-1`}
                  disabled={busy !== null}
                  aria-label={`Confirm ${a.symbol}: ${describeAction(a)}`}
                  onClick={() => void confirm(a)}
                >
                  Confirm
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {target && (
        <TargetDialog
          action={target.action}
          stocks={target.stocks}
          onClose={() => setTarget(null)}
          onConfirm={async (stockId, pct) => {
            const message = await change(target.action, {
              status: "applied",
              target_stock_id: stockId,
              ...(pct !== null ? { cost_share_pct: pct } : {}),
            });
            if (message === null) setTarget(null);
            return message;
          }}
        />
      )}
    </section>
  );
}

