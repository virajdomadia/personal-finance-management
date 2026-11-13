"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useId, useState } from "react";

import { logout } from "@/app/login/actions";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type BudgetLine,
  type BudgetMonth,
  type BudgetTotals,
  amountInput,
  budgetLink,
  budgetPayload,
  budgetsHref,
  fullName,
  groupBudgets,
  leftText,
  monthNav,
  saveErrorText,
  spentOfText,
  unbudgetedOptions,
  usedText,
} from "@/lib/budgets";
import { shortDate } from "@/lib/cash-flow";
import { FALLBACK_COLOUR, iconEmoji } from "@/lib/categories";
import { formatMonth, todayIndia } from "@/lib/transactions";
import { INPUT, PRIMARY, QUIET, ROW_ACTION } from "@/components/investments/shared";
import { FOCUS, PageHeader, ProgressBar, buttonClass } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: BudgetMonth };

const CARD = "min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky";
const MONTH_BUTTON = `${buttonClass("alt")} !rounded-full !px-3 !py-1.5 !text-xs !font-extrabold !shadow-chunky-sm`;
const LOAD_FALLBACK = "We couldn't load your budgets. Reload the page to try again.";

// A month's budgets: the total, a row per budget, and (this month only) set, change, remove and add.
export function BudgetsView({ month }: { month: string | null }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  useEffect(() => {
    let current = true;
    apiFetch<BudgetMonth>(month ? `/budgets?month=${month}` : "/budgets")
      .then((data) => {
        if (current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return void logout();
        // A month that hasn't started is a 422 with the server's message.
        const message = err instanceof ApiError && err.status === 422 ? saveErrorText(err.body) : LOAD_FALLBACK;
        if (current) setLoad({ status: "error", message });
      });
    return () => {
      current = false;
    };
  }, [month, version]);

  const title = load.status === "ready" ? formatMonth(load.data.month) : month ? formatMonth(month) : "This month";
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`Budgets · ${title}`}
        action={
          <>
            <Link href="/cash-flow" className={`${buttonClass("alt")} uppercase`}>
              Cash flow
            </Link>
            {load.status === "ready" ? <MonthNav data={load.data} /> : null}
          </>
        }
      />
      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading budgets...
        </p>
      )}
      {load.status === "error" && (
        <div role="alert" className={`${CARD} font-extrabold`}>
          <p>{load.message}</p>
          <Link href="/budgets" className={`mt-2 inline-block rounded text-sm underline ${FOCUS}`}>
            Go to this month
          </Link>
        </div>
      )}
      {load.status === "ready" && <Month data={load.data} onChanged={reload} />}
    </div>
  );
}

function MonthNav({ data }: { data: BudgetMonth }) {
  const { previous, next } = monthNav(data);
  const thisMonth = todayIndia().slice(0, 7);
  return (
    <div className="flex items-center gap-2">
      <Link href={budgetsHref(previous, thisMonth)} className={MONTH_BUTTON} aria-label="Previous month">
        ‹
      </Link>
      {next === null ? (
        <span className={`${MONTH_BUTTON} opacity-40`} aria-disabled="true" aria-label="Next month">
          ›
        </span>
      ) : (
        <Link href={budgetsHref(next, thisMonth)} className={MONTH_BUTTON} aria-label="Next month">
          ›
        </Link>
      )}
    </div>
  );
}

function Month({ data, onChanged }: { data: BudgetMonth; onChanged: () => void }) {
  const editable = data.is_current;
  const groups = groupBudgets(data.budgets);
  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-sm font-bold text-zinc-600">
        {editable
          ? `Spent from 1 to ${shortDate(data.through)}. A budget stays the same each month until you change it, and a change applies from this month on.`
          : "The whole month. Past months can't be changed."}{" "}
        Spending is counted as on the{" "}
        <Link href={`/cash-flow?month=${data.month}`} className={`rounded underline ${FOCUS}`}>
          month report
        </Link>
        ; a parent&apos;s budget includes its subcategories.
      </p>

      {data.budgets.length === 0 ? (
        <EmptyState emoji="📊" title={editable ? "No budgets yet" : `No budgets in ${formatMonth(data.month)}`}>
          {editable
            ? "Pick a spending category below and give it an amount a month. You'll see how much is left as you spend."
            : "Budgets set later don't change past months."}
        </EmptyState>
      ) : (
        <>
          <TotalCard total={data.total} />
          <section aria-labelledby="budget-list-title">
            <h2 id="budget-list-title" className="mb-2 px-1 text-xs font-black tracking-wider uppercase">
              Each budget
            </h2>
            <ul className="overflow-hidden rounded-[18px] border-[2.5px] border-ink bg-card shadow-chunky">
              {groups.map((g) => (
                <li key={g.line.category_id} className="border-b-[1.5px] border-zinc-200 last:border-b-0">
                  <BudgetRow line={g.line} month={data.month} editable={editable} onChanged={onChanged} />
                  {g.children.length > 0 && (
                    <ul aria-label={`Inside ${g.line.name}`}>
                      {g.children.map((c) => (
                        <li key={c.category_id} className="border-t-[1.5px] border-dashed border-zinc-200 pl-8">
                          <BudgetRow line={c} month={data.month} editable={editable} onChanged={onChanged} nested />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {editable && <AddBudget data={data} onChanged={onChanged} />}
    </div>
  );
}

function TotalCard({ total }: { total: BudgetTotals }) {
  return (
    <section aria-labelledby="budget-total-title" className={`${CARD} ${total.over ? "bg-pink/15" : "bg-due"}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <h2 id="budget-total-title" className="text-xs font-extrabold">
            <span aria-hidden="true">📊 </span>All budgets
          </h2>
          <p className="text-[clamp(1.5rem,3vw,2.25rem)] leading-tight font-black tracking-tight tabular-nums">
            {spentOfText(total)}
          </p>
        </div>
        <p className={`text-lg font-black tabular-nums ${total.over ? "text-loss" : ""}`}>{leftText(total)}</p>
      </div>
      <ProgressBar
        percent={total.bar}
        reached={false}
        warn={total.over}
        label={`All budgets: ${usedText(total)}`}
        className="mt-2.5 !h-5"
      />
      <p className="mt-1.5 text-xs font-extrabold text-zinc-600">
        {usedText(total)}. Subcategory budgets are counted once, inside their parent&apos;s.
      </p>
    </section>
  );
}

type RowMode = { kind: "view" } | { kind: "edit"; text: string } | { kind: "confirm-remove" };

function BudgetRow({
  line,
  month,
  editable,
  onChanged,
  nested = false,
}: {
  line: BudgetLine;
  month: string;
  editable: boolean;
  onChanged: () => void;
  nested?: boolean;
}) {
  const [mode, setMode] = useState<RowMode>({ kind: "view" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  async function send(path: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(path, init);
      setMode({ kind: "view" });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void logout();
      setError(err instanceof ApiError ? saveErrorText(err.body) : "We couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (mode.kind !== "edit") return;
    void send(`/budgets/${line.category_id}`, { method: "PUT", body: JSON.stringify(budgetPayload(mode.text)) });
  }

  const name = nested || !line.parent_name ? line.name : fullName(line);
  return (
    <div className={`px-3.5 py-3 ${line.active ? "" : "bg-zinc-50 text-zinc-600"}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Link
          href={budgetLink(month, line)}
          className={`min-w-0 rounded [overflow-wrap:anywhere] hover:underline ${FOCUS} ${nested ? "text-sm font-extrabold" : "font-black"}`}
        >
          <span
            aria-hidden="true"
            className="mr-2 inline-flex size-7 items-center justify-center rounded-[9px] border-[2.5px] border-ink align-middle text-sm"
            style={{ background: line.active ? (line.colour ?? FALLBACK_COLOUR) : "transparent" }}
          >
            {iconEmoji(line.icon)}
          </span>
          {name}
        </Link>
        <span className="text-sm font-black tabular-nums">{spentOfText(line)}</span>
      </div>
      <ProgressBar
        percent={line.bar}
        reached={false}
        warn={line.over}
        label={`${line.name}: ${usedText(line)}`}
        className={`mt-2 ${nested ? "!h-3" : ""} ${line.active ? "" : "opacity-50"}`}
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-extrabold">
          <span className={line.over ? "text-loss" : ""}>{leftText(line)}</span>
          <span className="text-zinc-600"> · {usedText(line)}</span>
          {line.active && !line.counted ? (
            <span className="text-zinc-600"> · counted in its parent&apos;s total</span>
          ) : null}
          {!line.active ? (
            <span className="ml-1 rounded-full border-[1.5px] border-ink bg-card px-2 text-[11px] font-black">
              Not active
            </span>
          ) : null}
        </p>
        {editable && mode.kind === "view" && (
          <div className="flex gap-1.5">
            {line.active && (
              <button
                type="button"
                className={ROW_ACTION}
                onClick={() => {
                  setError(null);
                  setMode({ kind: "edit", text: amountInput(line.amount) });
                }}
                aria-label={`Change the ${line.name} budget`}
              >
                Change
              </button>
            )}
            <button
              type="button"
              className={ROW_ACTION}
              onClick={() => {
                setError(null);
                setMode({ kind: "confirm-remove" });
              }}
              aria-label={`Remove the ${line.name} budget`}
            >
              Remove
            </button>
          </div>
        )}
      </div>
      {!line.active && line.note ? <p className="mt-1 text-xs font-bold">{line.note}</p> : null}

      {mode.kind === "edit" && (
        <form onSubmit={save} className="mt-2.5 flex flex-wrap items-end gap-2">
          <div className="w-44">
            <label htmlFor={inputId} className="mb-1 block text-xs font-extrabold">
              Amount a month
            </label>
            <input
              id={inputId}
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              className={INPUT}
              value={mode.text}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setMode({ kind: "edit", text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setMode({ kind: "view" });
              }}
            />
          </div>
          <button type="submit" className={PRIMARY} disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </button>
          <button type="button" className={QUIET} disabled={busy} onClick={() => setMode({ kind: "view" })}>
            Cancel
          </button>
        </form>
      )}

      {mode.kind === "confirm-remove" && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[14px] border-[2.5px] border-ink bg-due px-3 py-2">
          <p className="text-sm font-extrabold">
            Remove the {line.name} budget from this month on? Past months keep it.
          </p>
          <button
            type="button"
            className={`${buttonClass("pink")} !px-2.5 !py-1 uppercase`}
            disabled={busy}
            onClick={() => void send(`/budgets/${line.category_id}`, { method: "DELETE" })}
          >
            {busy ? "Removing..." : "Remove"}
          </button>
          <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => setMode({ kind: "view" })}>
            Keep it
          </button>
        </div>
      )}

      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs font-extrabold text-loss">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AddBudget({ data, onChanged }: { data: BudgetMonth; onChanged: () => void }) {
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerId = useId();
  const amountId = useId();
  const errorId = useId();

  if (data.unbudgeted.length === 0) {
    return (
      <p className="text-sm font-bold text-zinc-600">
        Every spending category has a budget. Add more categories on the{" "}
        <Link href="/categories" className={`rounded underline ${FOCUS}`}>
          Categories
        </Link>{" "}
        page.
      </p>
    );
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (categoryId === "") {
      setError("Pick a category.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${categoryId}`, { method: "PUT", body: JSON.stringify(budgetPayload(amount)) });
      setCategoryId("");
      setAmount("");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void logout();
      setError(err instanceof ApiError ? saveErrorText(err.body) : "We couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="add-budget-title" className={CARD}>
      <h2 id="add-budget-title" className="text-xs font-extrabold">
        <span aria-hidden="true">➕ </span>Add a budget
      </h2>
      <p className="mt-0.5 text-xs font-bold text-zinc-600">Each category shows what it has spent this month.</p>
      <form onSubmit={add} className="mt-2.5 grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_11rem_auto]">
        <div className="min-w-0">
          <label htmlFor={pickerId} className="mb-1 block text-xs font-extrabold">
            Category
          </label>
          <Select
            id={pickerId}
            value={categoryId}
            placeholder="Pick a spending category"
            options={unbudgetedOptions(data.unbudgeted)}
            disabled={busy}
            onChange={setCategoryId}
          />
        </div>
        <div>
          <label htmlFor={amountId} className="mb-1 block text-xs font-extrabold">
            Amount a month
          </label>
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="₹8,000"
            className={INPUT}
            value={amount}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <button type="submit" className={PRIMARY} disabled={busy}>
          {busy ? "Adding..." : "Add budget"}
        </button>
      </form>
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs font-extrabold text-loss">
          {error}
        </p>
      ) : null}
    </section>
  );
}
