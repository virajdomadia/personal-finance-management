"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type AccountList, errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { DIALOG, PRIMARY, QUIET } from "@/components/investments/shared";
import { Select, type SelectOption } from "@/components/ui/select";
import { formatCoinQty } from "@/lib/crypto";
import { formatUnits } from "@/lib/funds";
import type { Portfolio } from "@/lib/investments";
import { whole } from "@/lib/recurring";

type Props = {
  goal: { id: number; name: string };
  onClose: () => void;
  onSaved: () => void;
  onConflict: (message: string) => void;
};

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; options: SelectOption[] };

// The owner's stocks, funds and coins with units held, and their active PPFs and RDs, leaving out
// anything already in a goal (a holding belongs to one active goal at most). An option's value is
// "i:<instrument id>" or "a:<account id>".
async function loadOptions(): Promise<SelectOption[]> {
  const [portfolio, accounts] = await Promise.all([apiFetch<Portfolio>("/investments/portfolio"), apiFetch<AccountList>("/accounts")]);
  const taken = (rows: { in_goal: unknown }[]) => rows.some((r) => r.in_goal);
  const options: SelectOption[] = [];
  for (const s of portfolio.by_stock) {
    if (taken(portfolio.holdings.filter((h) => h.stock_id === s.stock_id))) continue;
    options.push({ value: `i:${s.stock_id}`, label: `Stock · ${s.symbol} · ${s.shares} ${s.shares === 1 ? "share" : "shares"}` });
  }
  for (const f of portfolio.funds.by_fund) {
    if (taken(portfolio.funds.holdings.filter((h) => h.fund_id === f.fund_id))) continue;
    options.push({ value: `i:${f.fund_id}`, label: `Fund · ${f.name} · ${formatUnits(f.units)} units` });
  }
  for (const c of portfolio.crypto.by_coin) {
    if (taken(portfolio.crypto.holdings.filter((h) => h.coin_id === c.coin_id))) continue;
    options.push({ value: `i:${c.coin_id}`, label: `Coin · ${c.symbol} · ${formatCoinQty(c.quantity)}` });
  }
  for (const a of accounts.accounts) {
    if ((a.type !== "ppf" && a.type !== "rd") || a.in_goal) continue;
    options.push({ value: `a:${a.id}`, label: `${a.type === "ppf" ? "PPF" : "RD"} · ${a.name} · ${whole(a.balance)}` });
  }
  return options;
}

// Put a whole holding in the goal. It counts at its current value, as the portfolio shows it.
export function HoldingDialog({ goal, onClose, onSaved, onConflict }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let current = true;
    loadOptions()
      .then((options) => {
        if (current) setLoad({ status: "ready", options });
      })
      .catch((err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) void logout();
        else setLoad({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [error, formError, saving]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setFormError(null);
    const [kind, id] = choice.split(":");
    const body = choice === "" ? {} : kind === "a" ? { account_id: Number(id) } : { instrument_id: Number(id) };
    try {
      await apiFetch(`/goals/${goal.id}/holdings`, { method: "POST", body: JSON.stringify(body) });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        // Both fields are this one picker.
        const { fields, general } = splitErrors(err.body, ["instrument_id", "account_id"]);
        const message = fields.instrument_id ?? fields.account_id;
        if (message) setError(message);
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

  const options = load.status === "ready" ? load.options : [];
  const placeholder =
    load.status === "loading"
      ? "Loading your holdings..."
      : load.status === "error"
        ? "Couldn't load your holdings"
        : options.length === 0
          ? "Nothing left to add"
          : "Choose a holding";

  return (
    <dialog
      ref={ref}
      aria-labelledby="holding-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(30rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
        <h2 id="holding-title" className="border-b border-zinc-200 px-5 py-4 text-base font-semibold [overflow-wrap:anywhere] dark:border-zinc-800">
          Add a holding to {goal.name}
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            The whole holding goes in, across every account it&apos;s held in, and counts at its current value. A holding can be in one goal at a time.
          </p>
          <div>
            <label htmlFor="h-holding" className="mb-1 block text-sm font-medium">
              Holding
            </label>
            <Select
              id="h-holding"
              value={choice}
              disabled={saving || load.status !== "ready"}
              invalid={Boolean(error)}
              describedBy={error ? "he-holding" : undefined}
              placeholder={placeholder}
              options={options}
              onChange={setChoice}
            />
            {error ? (
              <p id="he-holding" className="mt-1 text-xs text-red-700 dark:text-red-400">
                {error}
              </p>
            ) : null}
            {load.status === "ready" && options.length === 0 && (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Every stock, fund, coin, PPF and RD you hold is already in a goal, or you don&apos;t hold any yet.
              </p>
            )}
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
          <button ref={submitRef} type="submit" className={PRIMARY} disabled={saving || load.status !== "ready" || options.length === 0}>
            {saving ? "Adding..." : "Add holding"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
