"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { Select } from "@/components/ui/select";
import { formatRupees } from "@/lib/accounts";
import {
  type ActionBody,
  type ActionKind,
  type CorporateAction,
  type LinkSuggestions,
  type StockActions,
  cleanPercent,
  createAction,
  describeAction,
  describePreview,
  dismissSuspectDrop,
  dividendLabel,
  isUpcoming,
  link,
  linkSuggestions,
  stockActions,
  unlink,
  updateAction,
} from "@/lib/corporate-actions";
import type { Stock } from "@/lib/investments";
import { formatDate, todayIndia } from "@/lib/transactions";

import { DIALOG, INPUT, LIST, PRIMARY, QUIET, ROW_ACTION, isUnauthorized } from "./shared";
import { TargetDialog, failureMessage, needsTarget } from "./target-dialog";

const STATUS_BADGE: Record<CorporateAction["status"], string> = {
  pending: "Needs your OK",
  applied: "Applied",
  dismissed: "Dismissed",
};

// How many times to look again while the server is still fetching a new stock's history.
const BACKFILL_RETRIES = 5;
const BACKFILL_WAIT_MS = 4000;

type Dialog =
  | { kind: "none" }
  | { kind: "add"; start: ActionKind }
  | { kind: "target"; action: CorporateAction }
  | { kind: "link"; action: CorporateAction };

export function StockActionsSection({ stock, stocks, onChanged }: { stock: Stock; stocks: Stock[]; onChanged: () => void }) {
  const [data, setData] = useState<StockActions | null>(null);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const retries = useRef(0);
  const today = todayIndia();

  const load = useCallback(() => {
    const request = ++latest.current;
    stockActions(stock.id)
      .then((res) => {
        if (request === latest.current) {
          setData(res);
          setFailed(false);
        }
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setFailed(true);
      });
  }, [stock.id]);

  useEffect(() => {
    load();
  }, [load]);

  // A stock added a moment ago is still having its past actions fetched: look again shortly.
  const backfilled = data?.backfilled ?? true;
  useEffect(() => {
    if (backfilled || retries.current >= BACKFILL_RETRIES) return;
    const timer = window.setTimeout(() => {
      retries.current += 1;
      load();
    }, BACKFILL_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [backfilled, data, load]);

  // Runs one change and reloads; returns the error text, if any, for a dialog to show.
  async function run(work: () => Promise<unknown>, refreshPortfolio = true): Promise<string | null> {
    setBusy(true);
    setError(null);
    try {
      await work();
      load();
      if (refreshPortfolio) onChanged();
      return null;
    } catch (err) {
      const message = failureMessage(err);
      setError(message || null);
      return message;
    } finally {
      setBusy(false);
    }
  }

  const close = () => setDialog({ kind: "none" });
  const confirm = (a: CorporateAction) => {
    if (needsTarget(a)) setDialog({ kind: "target", action: a });
    else void run(() => updateAction(a.id, { status: "applied" }));
  };

  return (
    <section aria-labelledby="actions-title">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
        <h2 id="actions-title" className="text-xs font-black tracking-wider uppercase">
          Actions &amp; dividends
        </h2>
        <button type="button" className={ROW_ACTION} onClick={() => setDialog({ kind: "add", start: "split" })}>
          Add by hand
        </button>
      </div>

      {data && !data.backfilled && (
        <p role="status" className="mb-2 px-1 text-sm font-bold text-zinc-600">
          Checking past corporate actions…
        </p>
      )}

      {data?.suspect_drop_on && (
        <div role="status" className="mb-3 rounded-[14px] border-[2.5px] border-ink bg-yellow px-3 py-2 text-sm font-extrabold shadow-chunky-sm">
          <p>Price fell sharply on {formatDate(data.suspect_drop_on)} — was there a split or bonus?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => setDialog({ kind: "add", start: "split" })}>
              Add a split or bonus
            </button>
            <button
              type="button"
              className={ROW_ACTION}
              disabled={busy}
              onClick={() => void run(() => dismissSuspectDrop(stock.id).then(setData), false)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error ? (
        <p role="alert" className="mb-3 rounded-[14px] border-[2.5px] border-ink bg-pink/20 px-3 py-2 text-sm font-extrabold shadow-chunky-sm">
          {error}
        </p>
      ) : null}

      {failed && !data ? (
        <p role="alert" className="text-sm font-extrabold">
          We couldn&apos;t load the actions.{" "}
          <button type="button" className="underline" onClick={load}>
            Try again
          </button>
        </p>
      ) : data === null ? (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading...
        </p>
      ) : data.actions.length === 0 ? (
        <p className="rounded-[18px] border-[2.5px] border-dashed border-ink bg-card px-4 py-6 text-center text-sm font-extrabold text-zinc-700">
          No splits, bonuses or dividends for {stock.symbol} yet.
        </p>
      ) : (
        <ul className={LIST}>
          {data.actions.map((a) => (
            <ActionRow
              key={a.id}
              action={a}
              today={today}
              busy={busy}
              onConfirm={confirm}
              onRun={(work) => void run(work)}
              onLink={() => setDialog({ kind: "link", action: a })}
            />
          ))}
        </ul>
      )}

      {dialog.kind === "add" && (
        <AddDialog
          start={dialog.start}
          onClose={close}
          onSave={async (body) => {
            const message = await run(() => createAction(stock.id, body), false);
            if (message === null) close();
            return message;
          }}
        />
      )}
      {dialog.kind === "target" && (
        <TargetDialog
          action={dialog.action}
          stocks={stocks}
          onClose={close}
          onConfirm={async (stockId, pct) => {
            const message = await run(() =>
              updateAction(dialog.action.id, { status: "applied", target_stock_id: stockId, ...(pct !== null ? { cost_share_pct: pct } : {}) }),
            );
            if (message === null) close();
            return message;
          }}
        />
      )}
      {dialog.kind === "link" && <LinkCreditDialog action={dialog.action} onClose={close} onChanged={load} />}
    </section>
  );
}

function ActionRow({
  action: a,
  today,
  busy,
  onConfirm,
  onRun,
  onLink,
}: {
  action: CorporateAction;
  today: string;
  busy: boolean;
  onConfirm: (a: CorporateAction) => void;
  onRun: (work: () => Promise<unknown>) => void;
  onLink: () => void;
}) {
  const preview = describePreview(a.preview);
  const money = dividendLabel(a, today);
  const accounts = a.dividend?.by_account ?? [];
  const linked = accounts.reduce((n, acc) => n + acc.links.length, 0);
  const canLink = a.kind === "dividend" && a.status === "applied" && accounts.length > 0;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-40 flex-1">
        <p className="text-sm font-extrabold [overflow-wrap:anywhere]">
          {describeAction(a)}
          {isUpcoming(a, today) && (
            <span className="ml-2 rounded-full border-[1.5px] border-ink bg-yellow px-2 py-px text-[11px] font-black">upcoming</span>
          )}
        </p>
        <p className="text-xs font-bold text-zinc-600">
          {STATUS_BADGE[a.status]}
          {money && ` · ${money}`}
          {a.status === "applied" && accounts.length > 0 && ` · ${accounts.map((x) => `${x.account_name} ${formatRupees(x.gross)}`).join(", ")}`}
          {linked > 0 && ` · ${linked} credit${linked === 1 ? "" : "s"} linked`}
        </p>
        {preview && <p className="text-xs font-bold text-zinc-600">{preview}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        {canLink && (
          <button type="button" className={ROW_ACTION} disabled={busy} onClick={onLink}>
            Link credit
          </button>
        )}
        {a.status === "pending" && (
          <>
            <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => onRun(() => updateAction(a.id, { status: "dismissed" }))}>
              Dismiss
            </button>
            <button type="button" className={`${PRIMARY} !px-2.5 !py-1`} disabled={busy} onClick={() => onConfirm(a)}>
              Confirm
            </button>
          </>
        )}
        {a.status === "applied" && (
          <button
            type="button"
            className={ROW_ACTION}
            disabled={busy}
            aria-label={`Undo ${describeAction(a)}`}
            onClick={() => onRun(() => updateAction(a.id, { status: "pending" }))}
          >
            Undo
          </button>
        )}
        {a.status === "dismissed" && (
          <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => onRun(() => updateAction(a.id, { status: "pending" }))}>
            Restore
          </button>
        )}
      </div>
    </li>
  );
}

const ADD_KINDS: { value: ActionKind; label: string }[] = [
  { value: "split", label: "Split" },
  { value: "bonus", label: "Bonus" },
  { value: "consolidation", label: "Consolidation" },
  { value: "dividend", label: "Dividend" },
  { value: "merger", label: "Merger" },
  { value: "demerger", label: "Demerger" },
];

const FIELD_LABEL = "mb-1 block text-xs font-black tracking-wide uppercase";

// Enters an action by hand. It lands as pending, so it still has to be confirmed.
function AddDialog({
  start,
  onClose,
  onSave,
}: {
  start: ActionKind;
  onClose: () => void;
  onSave: (body: ActionBody) => Promise<string | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [kind, setKind] = useState<ActionKind>(start);
  const [date, setDate] = useState(todayIndia());
  const [oldQty, setOldQty] = useState("");
  const [newQty, setNewQty] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ratio = kind === "split" || kind === "bonus" || kind === "consolidation";

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const body: ActionBody = { kind, ex_date: date };
    if (ratio) {
      body.ratio_old = oldQty || null;
      body.ratio_new = newQty || null;
    }
    if (kind === "dividend") body.amount_per_share = amount || null;
    const message = await onSave(body);
    savingRef.current = false;
    setSaving(false);
    if (message !== null) setError(message);
  }

  const numeric = (value: string, set: (v: string) => void, id: string) => (
    <input
      id={id}
      className={INPUT}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      disabled={saving}
      value={value}
      onChange={(e) => set(cleanPercent(e.target.value))}
    />
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby="add-action-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(28rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate>
        <h2 id="add-action-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Add an action by hand
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <span className={FIELD_LABEL}>Kind</span>
            <Select ariaLabel="Kind" value={kind} options={ADD_KINDS} onChange={(v) => setKind(v as ActionKind)} disabled={saving} />
          </div>
          <div>
            <label htmlFor="add-date" className={FIELD_LABEL}>
              Ex-date
            </label>
            <input id="add-date" className={INPUT} type="date" disabled={saving} value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          {ratio && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="add-old" className={FIELD_LABEL}>
                  {kind === "bonus" ? "Shares held" : "Old shares"}
                </label>
                {numeric(oldQty, setOldQty, "add-old")}
              </div>
              <div>
                <label htmlFor="add-new" className={FIELD_LABEL}>
                  {kind === "bonus" ? "Free shares" : "New shares"}
                </label>
                {numeric(newQty, setNewQty, "add-new")}
              </div>
            </div>
          )}
          {kind === "dividend" && (
            <div>
              <label htmlFor="add-amount" className={FIELD_LABEL}>
                Dividend per share (₹)
              </label>
              {numeric(amount, setAmount, "add-amount")}
            </div>
          )}
          {(kind === "merger" || kind === "demerger") && (
            <p className="text-sm font-bold text-zinc-600">You will pick the other stock when you confirm it.</p>
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
            {saving ? "Saving..." : "Add"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

// Matches a dividend to the bank credit it paid, so that credit isn't counted as other income.
function LinkCreditDialog({ action, onClose, onChanged }: { action: CorporateAction; onClose: () => void; onChanged: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [suggestions, setSuggestions] = useState<LinkSuggestions | null>(null);
  const [linked, setLinked] = useState<CorporateAction>(action);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    linkSuggestions(action.id)
      .then(setSuggestions)
      .catch((err: unknown) => setError(failureMessage(err) || "We couldn't load the suggestions."));
  }, [action.id]);

  async function change(work: () => Promise<CorporateAction>) {
    setBusy(true);
    setError(null);
    try {
      setLinked(await work());
      setSuggestions(await linkSuggestions(action.id));
      onChanged();
    } catch (err) {
      setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const linkedIds = linked.dividend?.by_account.flatMap((a) => a.links) ?? [];
  const rows = suggestions?.accounts.flatMap((a) => a.suggestions) ?? [];
  return (
    <dialog ref={ref} aria-labelledby="link-credit-title" onClose={onClose} className={`${DIALOG} w-[min(30rem,calc(100vw-2rem))]`}>
      <h2 id="link-credit-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
        Link the dividend credit
      </h2>
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 py-4">
        <p className="text-sm text-zinc-600">{describeAction(linked)}. Linking a credit marks it as this dividend; no money moves.</p>
        {linkedIds.length > 0 && (
          <ul className="flex flex-col gap-1">
            {linkedIds.map((id) => (
              <li key={id} className="flex items-center justify-between gap-2 text-sm font-extrabold">
                <span>Transaction #{id} linked</span>
                <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => void change(() => unlink(action.id, id))}>
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        )}
        {suggestions === null && !error && (
          <p role="status" className="text-sm font-bold text-zinc-600">
            Looking for matching credits...
          </p>
        )}
        {suggestions && rows.length === 0 && <p className="text-sm font-bold text-zinc-600">No matching credits found yet.</p>}
        {rows.length > 0 && (
          <ul className="flex flex-col gap-2">
            {rows.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 rounded-[14px] border-[2.5px] border-ink px-3 py-2">
                <p className="text-sm font-extrabold">
                  {formatRupees(s.amount)} · {formatDate(s.date)}
                  <span className="block text-xs font-bold text-zinc-600">
                    {s.account_name}
                    {s.note ? ` · ${s.note}` : ""}
                  </span>
                </p>
                <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => void change(() => link(action.id, s.id))}>
                  Link
                </button>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p role="alert" className="text-sm font-extrabold text-loss">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end border-t-[2.5px] border-ink bg-bg px-5 py-3">
        <button type="button" className={QUIET} onClick={() => ref.current?.close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
