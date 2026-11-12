"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, cleanMoney, errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Chip,
  EmojiSquare,
  FOCUS,
  PageHeader,
  StackedBar,
  TABLE,
  TD,
  TD_NUM,
  TH,
  Tile,
  buttonClass,
  type Tone,
} from "@/components/ui/chunky";
import { categoryEmoji } from "@/lib/fun";
import { DueSection } from "@/components/recurring/due-list";
import {
  type SearchFilters,
  activeFilterCount,
  blankFilters,
  filtersFromParams,
  paramsFromFilters,
  searchQuery,
  usesRange,
} from "@/lib/cash-flow";
import type { CategoryTree } from "@/lib/categories";
import {
  type Activity,
  TRANSACTION_TYPES,
  type Transaction,
  type TransactionList,
  type TransactionType,
  activityLabel,
  formatDate,
  formatMonth,
  shiftMonth,
  showsActivity,
  signedAmount,
  todayIndia,
} from "@/lib/transactions";

import { TransactionDialog } from "./transaction-dialog";

type Filters = SearchFilters;
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: TransactionList };
type Dialog = { kind: "none" } | { kind: "form"; transaction: Transaction | null } | { kind: "delete"; transaction: Transaction };
type Accounts = { active: Account[]; archived: Account[] };

const PRIMARY = `${buttonClass("primary")} uppercase`;
const QUIET = `${buttonClass("alt")} uppercase`;
const MONTH_BUTTON = `${buttonClass("alt")} !rounded-full !px-3 !py-1.5 !text-xs !font-extrabold !shadow-chunky-sm`;
const ROW_ACTION = `${buttonClass("alt")} !px-2.5 !py-1`;
const CARD = "rounded-[18px] border-[2.5px] border-ink bg-card p-5 shadow-chunky";
const SECTION_TITLE = "mb-2 text-xs font-black tracking-wide uppercase";
const TYPE_TONE: Record<TransactionType, Tone> = { expense: "pink", income: "green", transfer: "blue", emi: "purple" };

const PAGE_SIZE = 50;

const INPUT = `w-full rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-sm font-extrabold outline-none ${FOCUS}`;
const SMALL_LABEL = "mb-1 block text-[11px] font-black tracking-wide uppercase";
const SEARCH_DELAY_MS = 300;

function query(filters: Filters, offset: number): string {
  return searchQuery(filters, PAGE_SIZE, offset);
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export function TransactionsView({ initialQuery }: { initialQuery: string }) {
  const [thisMonth] = useState(() => todayIndia().slice(0, 7));
  const [filters, setFilters] = useState<Filters>(() =>
    filtersFromParams(new URLSearchParams(initialQuery), todayIndia().slice(0, 7)),
  );
  const [searchText, setSearchText] = useState(filters.q);
  const [amountKey, setAmountKey] = useState(0); // bumped to reset the amount boxes
  const [categoryTree, setCategoryTree] = useState<CategoryTree | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dueKey, setDueKey] = useState(0); // bumped when transactions change, so the due list is re-read
  const latest = useRef(0);
  const latestActivity = useRef(0);
  // The filters on screen right now; a late reload must not read stale ones from its closure.
  const filtersRef = useRef(filters);

  // An account's buys and sells of stocks, funds and coins for the month. They are not transactions,
  // so they sit in their own list and never touch the totals. A failure just leaves the list out.
  const fetchActivity = useCallback((current: Filters) => {
    const request = ++latestActivity.current;
    // Drop the old list first, so last month's rows don't show under the new filters.
    setActivity([]);
    if (current.accountId === null) return;
    apiFetch<{ items: Activity[] }>(`/accounts/${current.accountId}/investment-activity?month=${current.month}`)
      .then((data) => {
        if (request === latestActivity.current) setActivity(data.items);
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latestActivity.current) setActivity([]);
      });
  }, []);

  const fetchFirstPage = useCallback(
    (current: Filters) => {
      fetchActivity(current);
      const request = ++latest.current;
      setLoadingMore(false);
      apiFetch<TransactionList>(query(current, 0))
        .then((data) => {
          if (request === latest.current) setLoad({ status: "ready", data });
        })
        .catch((err: unknown) => {
          if (isUnauthorized(err)) void logout();
          else if (request === latest.current) setLoad({ status: "error" });
        });
    },
    [fetchActivity],
  );

  const fetchAccounts = useCallback(() => {
    Promise.all([apiFetch<AccountList>("/accounts"), apiFetch<AccountList>("/accounts?archived=true")])
      .then(([active, archived]) => setAccounts({ active: active.accounts, archived: archived.accounts }))
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else setNotice("We couldn't load your accounts. Reload the page to add a transaction.");
      });
  }, []);

  useEffect(() => {
    fetchFirstPage(filtersRef.current);
    fetchAccounts();
    // Only for the category filter's choices: without them the filter just isn't offered.
    apiFetch<CategoryTree>("/categories")
      .then(setCategoryTree)
      .catch(() => {});
  }, [fetchFirstPage, fetchAccounts]);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const applyFilters = (change: Partial<Filters>) => {
    const next = { ...filtersRef.current, ...change };
    filtersRef.current = next;
    setFilters(next);
    // Kept in the address, so a search can be bookmarked or linked to from the month report.
    window.history.replaceState(null, "", `/transactions${paramsFromFilters(next, thisMonth)}`);
    setNotice(null);
    setLoad({ status: "loading" });
    fetchFirstPage(next);
  };

  const reload = () => {
    fetchFirstPage(filtersRef.current);
    setDueKey((k) => k + 1);
  };
  const closeDialog = () => setDialog({ kind: "none" });

  async function loadMore() {
    if (load.status !== "ready" || loadingMore) return;
    const loaded = load.data.transactions;
    const request = ++latest.current;
    setLoadingMore(true);
    try {
      const data = await apiFetch<TransactionList>(query(filtersRef.current, loaded.length));
      if (request === latest.current) {
        setLoad({ status: "ready", data: { ...data, transactions: [...loaded, ...data.transactions] } });
      }
    } catch (err) {
      if (isUnauthorized(err)) return void logout();
      if (request === latest.current) setNotice(errorMessage(err));
    } finally {
      if (request === latest.current) setLoadingMore(false);
    }
  }

  const typeSearch = (text: string) => {
    setSearchText(text);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => applyFilters({ q: text }), SEARCH_DELAY_MS);
  };
  const ranged = usesRange(filters);
  const filtered = activeFilterCount(filters) > 0 || filters.q.trim() !== "";
  const categoryOptions = [
    { value: "", label: "All categories" },
    { value: "Uncategorised", label: "Uncategorised" },
    ...(["expense", "income"] as const).flatMap((kind) =>
      (categoryTree?.[kind] ?? [])
        .filter((c) => !c.archived || c.name === filters.category)
        .map((c) => ({
          value: c.name,
          label: `${c.parent_id === null ? "" : "\u00a0\u00a0– "}${c.name}${kind === "income" ? " (income)" : ""}`,
        })),
    ),
    ...(filters.category ? [{ value: filters.category, label: filters.category }] : []),
  ].filter((o, i, all) => all.findIndex((x) => x.value === o.value) === i);

  const monthWord = (() => {
    const short = formatMonth(filters.month).slice(0, 3);
    return filters.month.slice(0, 4) === thisMonth.slice(0, 4) ? short : `${short} ${filters.month.slice(0, 4)}`;
  })();
  const byCategory =
    load.status === "ready"
      ? load.data.expense_by_category.map((c) => ({ label: c.category, value: Number(c.amount) }))
      : [];

  const canAdd = accounts !== null && accounts.active.length > 0;
  const noAccounts = accounts !== null && accounts.active.length === 0 && accounts.archived.length === 0;
  const openAdd = () => setDialog({ kind: "form", transaction: null });
  const defaultAccountId =
    accounts?.active.find((a) => a.id === filters.accountId)?.id ?? accounts?.active[0]?.id ?? null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Transactions"
        action={
          canAdd ? (
            <button type="button" className={PRIMARY} onClick={openAdd}>
              + Add transaction
            </button>
          ) : null
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className={`flex items-center gap-2 ${ranged ? "hidden" : ""}`}>
          <button
            type="button"
            className={MONTH_BUTTON}
            aria-label="Previous month"
            onClick={() => applyFilters({ month: shiftMonth(filters.month, -1) })}
          >
            ‹
          </button>
          <span className="min-w-32 text-center text-sm font-black" aria-live="polite">
            {formatMonth(filters.month)}
          </span>
          <button
            type="button"
            className={MONTH_BUTTON}
            aria-label="Next month"
            disabled={filters.month >= thisMonth}
            onClick={() => applyFilters({ month: shiftMonth(filters.month, 1) })}
          >
            ›
          </button>
        </div>
        <Select
          ariaLabel="Filter by account"
          className="w-48"
          value={filters.accountId === null ? "" : String(filters.accountId)}
          placeholder="All accounts"
          options={[
            { value: "", label: "All accounts" },
            ...(accounts?.active.map((a) => ({ value: String(a.id), label: a.name })) ?? []),
            ...(accounts?.archived.map((a) => ({ value: String(a.id), label: `${a.name} (archived)` })) ?? []),
          ]}
          onChange={(value) => applyFilters({ accountId: value === "" ? null : Number(value) })}
        />
        <div role="group" aria-label="Filter by type" className="flex flex-wrap gap-2">
          <Chip selected={filters.type === null} onClick={() => applyFilters({ type: null })}>
            All types
          </Chip>
          {TRANSACTION_TYPES.map((t) => (
            <Chip key={t.value} selected={filters.type === t.value} onClick={() => applyFilters({ type: t.value })}>
              {t.label}
            </Chip>
          ))}
        </div>
      </div>

      <div
        role="search"
        aria-label="Search transactions"
        className="mb-5 grid grid-cols-1 gap-3 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky-sm sm:grid-cols-2 lg:grid-cols-[2fr_1.4fr_1fr_1fr_0.8fr_0.8fr]"
      >
        <div>
          <label htmlFor="tx-search" className={SMALL_LABEL}>
            Search
          </label>
          <input
            id="tx-search"
            type="search"
            className={INPUT}
            placeholder="Note, payee or category"
            maxLength={100}
            value={searchText}
            onChange={(e) => typeSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                clearTimeout(searchTimer.current);
                applyFilters({ q: searchText });
              }
            }}
          />
        </div>
        <div>
          <label htmlFor="tx-category" className={SMALL_LABEL}>
            Category
          </label>
          <Select
            id="tx-category"
            value={filters.category}
            placeholder="All categories"
            options={categoryOptions}
            onChange={(value) => applyFilters({ category: value })}
          />
        </div>
        <div>
          <label htmlFor="tx-from" className={SMALL_LABEL}>
            From
          </label>
          <input
            id="tx-from"
            type="date"
            className={INPUT}
            value={filters.from}
            max={filters.to || todayIndia()}
            onChange={(e) => applyFilters({ from: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="tx-to" className={SMALL_LABEL}>
            To
          </label>
          <input
            id="tx-to"
            type="date"
            className={INPUT}
            value={filters.to}
            min={filters.from || undefined}
            max={todayIndia()}
            onChange={(e) => applyFilters({ to: e.target.value })}
          />
        </div>
        <div key={`min-${amountKey}`}>
          <label htmlFor="tx-min" className={SMALL_LABEL}>
            Min ₹
          </label>
          <input
            id="tx-min"
            inputMode="decimal"
            className={INPUT}
            defaultValue={filters.min}
            onBlur={(e) => {
              const value = cleanMoney(e.target.value);
              if (value !== filters.min) applyFilters({ min: value });
            }}
          />
        </div>
        <div key={`max-${amountKey}`}>
          <label htmlFor="tx-max" className={SMALL_LABEL}>
            Max ₹
          </label>
          <input
            id="tx-max"
            inputMode="decimal"
            className={INPUT}
            defaultValue={filters.max}
            onBlur={(e) => {
              const value = cleanMoney(e.target.value);
              if (value !== filters.max) applyFilters({ max: value });
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-6">
          {filtered ? (
            <>
              <p className="text-xs font-extrabold text-zinc-600" aria-live="polite">
                {ranged
                  ? `Showing ${filters.from ? formatDate(filters.from) : "the first"} to ${filters.to ? formatDate(filters.to) : "today"}, newest first.`
                  : `Showing matches in ${formatMonth(filters.month)}. Set dates to search further back.`}
              </p>
              <button
                type="button"
                className={`${ROW_ACTION} uppercase`}
                onClick={() => {
                  clearTimeout(searchTimer.current);
                  setSearchText("");
                  setAmountKey((k) => k + 1);
                  applyFilters(blankFilters(filtersRef.current.month));
                }}
              >
                Clear filters
              </button>
            </>
          ) : null}
          <Link href="/categories" className={`ml-auto rounded text-xs font-black underline ${FOCUS}`}>
            Manage categories
          </Link>
        </div>
      </div>

      {notice ? (
        <p
          role="alert"
          className="mb-4 rounded-[14px] border-[2.5px] border-ink bg-pink/15 px-3 py-2 text-sm font-extrabold text-ink"
        >
          {notice}
        </p>
      ) : null}

      <DueSection
        refreshKey={dueKey}
        onChanged={(date) => {
          // A late payment lands in an earlier month: show that month so the owner sees it.
          if (date && !usesRange(filtersRef.current) && date.slice(0, 7) !== filtersRef.current.month)
            applyFilters({ month: date.slice(0, 7) });
          else reload();
        }}
      />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading transactions...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className={CARD}>
          <p className="text-4xl" aria-hidden="true">
            🙈
          </p>
          <p className="mt-1 font-extrabold">We couldn&apos;t load your transactions.</p>
          <button type="button" className={`${QUIET} mt-3`} onClick={() => applyFilters({})}>
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" && (
        <>
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_2fr]">
            <Tile tone="pink" emoji="💸" label={`Spent in ${monthWord}`} value={formatRupees(load.data.total_expense)} />
            <Tile tone="green" emoji="💰" label={`Got in ${monthWord}`} value={formatRupees(load.data.total_income)} />
            {byCategory.length > 0 ? (
              <div className="sm:col-span-2 lg:col-span-1">
                <Tile label="Where it went" emoji="🍕">
                  <StackedBar items={byCategory} label="Where it went" />
                </Tile>
              </div>
            ) : null}
          </div>

          {load.data.transactions.length === 0 ? (
            noAccounts ? (
              <EmptyState
                emoji="👛"
                title="Add an account first"
                action={
                  <Link href="/accounts" className={PRIMARY}>
                    Go to accounts
                  </Link>
                }
              >
                Every rupee you spend or receive lives here, and each one belongs to an account.
              </EmptyState>
            ) : (
              <EmptyState
                emoji="🫥"
                title={ranged ? "Nothing matches" : `Nothing in ${formatMonth(filters.month)}`}
                action={
                  canAdd ? (
                    <button type="button" className={PRIMARY} onClick={openAdd}>
                      + Add transaction
                    </button>
                  ) : null
                }
              >
                {filtered || ranged || filters.accountId !== null || filters.type !== null
                  ? "Nothing matches this search and these filters. Try another month or clear a filter."
                  : "Everything you spend and receive shows up here, month by month. Add one now, or let the Android app read your bank texts."}
              </EmptyState>
            )
          ) : (
            <div className="flex flex-col gap-5">
              <div className="relative overflow-x-auto pb-1">
                <table className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
                  <caption className="sr-only">Transactions in {formatMonth(filters.month)}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        Date
                      </th>
                      <th scope="col" className={TH}>
                        What
                      </th>
                      <th scope="col" className={`${TH} hidden lg:table-cell`}>
                        Category
                      </th>
                      <th scope="col" className={`${TH} hidden lg:table-cell`}>
                        Account
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        Amount
                      </th>
                      <th scope="col" className={`${TH} w-px`}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {load.data.transactions.map((tx) => (
                      <TransactionRow
                        key={tx.id}
                        transaction={tx}
                        viewedAccountId={filters.accountId}
                        onEdit={() => setDialog({ kind: "form", transaction: tx })}
                        onDelete={() => setDialog({ kind: "delete", transaction: tx })}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {load.data.has_more && (
                <button type="button" className={`${QUIET} self-center`} disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              )}
            </div>
          )}

          {showsActivity(filters) && activity.length > 0 && <InvestmentActivity items={activity} />}
        </>
      )}

      {dialog.kind === "form" && accounts !== null && (
        <TransactionDialog
          key={dialog.transaction?.id ?? "new"}
          transaction={dialog.transaction}
          accounts={accounts.active}
          defaultAccountId={defaultAccountId}
          onClose={closeDialog}
          onSaved={(saved) => {
            closeDialog();
            // Show the month the transaction landed in, or it would seem to have vanished.
            if (usesRange(filtersRef.current)) reload();
            else applyFilters({ month: saved.date.slice(0, 7) });
            setDueKey((k) => k + 1);
          }}
          onConflict={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}

      {dialog.kind === "delete" && (
        <DeleteDialog
          transaction={dialog.transaction}
          onClose={closeDialog}
          onDone={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}
    </div>
  );
}

// The same sign style as the transaction rows: -₹1,000.00 or +₹1,000.00.
function activityAmount(signed: string): string {
  const text = signed.trim();
  return text.startsWith("-") ? `-${formatRupees(text.slice(1))}` : `+${formatRupees(text.replace(/^\+/, ""))}`;
}

function activityHref(item: Activity): string {
  if (item.kind === "stock") return `/investments/${item.instrument_id}`;
  if (item.kind === "mutual_fund") return `/investments/funds/${item.instrument_id}`;
  return `/investments/crypto/${item.instrument_id}`;
}

// Buys and sells of stocks, funds and coins through the viewed account. Not transactions: they have
// their own list, and the totals above ignore them.
function InvestmentActivity({ items }: { items: Activity[] }) {
  return (
    <section aria-labelledby="investment-activity-title" className="mt-8">
      <h2 id="investment-activity-title" className={SECTION_TITLE}>
        Investment activity
      </h2>
      <ul className={`${CARD} !py-2`}>
        {items.map((item) => (
          <li
            key={`${item.kind}-${item.trade_id}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b-[1.5px] border-dashed border-zinc-300 py-2 last:border-b-0"
          >
            <div className="min-w-32 flex-1">
              <Link href={activityHref(item)} className={`rounded text-sm font-extrabold [overflow-wrap:anywhere] hover:underline ${FOCUS}`}>
                {activityLabel(item)}
              </Link>
              <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">
                {formatDate(item.date)} · {item.name}
              </p>
            </div>
            <p className="min-w-0 max-w-full text-right text-sm font-black tabular-nums [overflow-wrap:anywhere]">
              {activityAmount(item.signed_amount)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Marks a transaction recorded from a bank SMS, as opposed to one typed in.
function SmsChip() {
  return (
    <span className="ml-2 inline-block rounded-full border-[1.5px] border-ink bg-blue/20 px-2 py-px align-middle text-[11px] font-black whitespace-nowrap text-ink">
      from SMS
    </span>
  );
}

function TransactionRow({
  transaction: tx,
  viewedAccountId,
  onEdit,
  onDelete,
}: {
  transaction: Transaction;
  viewedAccountId: number | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const category = tx.category ?? "Uncategorised";
  const title = tx.type === "transfer" ? "Transfer" : tx.type === "emi" ? `EMI · ${tx.to_account_name}` : category;
  const accountText =
    tx.type === "transfer"
      ? `${tx.account_name} → ${tx.to_account_name}`
      : tx.type === "emi" && tx.interest !== null
        ? `${tx.account_name} · ${formatRupees(tx.interest)} interest`
        : tx.account_name;
  const emoji = tx.type === "transfer" ? "🔁" : tx.type === "emi" ? "🏧" : categoryEmoji(tx.category);
  const amount = signedAmount(tx, viewedAccountId);
  const colour = amount.startsWith("+") ? "text-gain" : amount.startsWith("-") ? "text-loss" : "";
  return (
    <tr>
      <td className={`${TD} whitespace-nowrap`}>
        <span className="lg:hidden">{formatDate(tx.date).slice(0, -5)}</span>
        <span className="hidden lg:inline">{formatDate(tx.date)}</span>
      </td>
      <td className={`${TD} w-full min-w-32`}>
        <div className="flex items-center">
          <EmojiSquare emoji={emoji} tone={TYPE_TONE[tx.type]} />
          <div className="min-w-0">
            <p className="font-extrabold [overflow-wrap:anywhere]">
              {title}
              {tx.from_sms ? <SmsChip /> : null}
            </p>
            <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere] lg:hidden">{accountText}</p>
            {tx.note ? <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{tx.note}</p> : null}
          </div>
        </div>
      </td>
      <td className={`${TD} hidden [overflow-wrap:anywhere] lg:table-cell`}>
        {tx.type === "transfer" ? "Transfer" : tx.type === "emi" ? "EMI" : category}
      </td>
      <td className={`${TD} hidden max-w-56 [overflow-wrap:anywhere] lg:table-cell`}>{accountText}</td>
      <td className={`${TD_NUM} min-w-28 font-black [overflow-wrap:anywhere] ${colour}`}>
        {amount}
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        <div className="flex flex-col items-stretch justify-end gap-1.5 lg:flex-row">
          {tx.editable ? (
            <>
              <button type="button" className={ROW_ACTION} aria-label={`Edit ${title}, ${tx.date}`} onClick={onEdit}>
                Edit
              </button>
              <button type="button" className={ROW_ACTION} aria-label={`Delete ${title}, ${tx.date}`} onClick={onDelete}>
                Delete
              </button>
            </>
          ) : (
            <span className="px-2 py-1 text-xs font-bold text-zinc-600">Archived</span>
          )}
        </div>
      </td>
    </tr>
  );
}

function DeleteDialog({
  transaction: tx,
  onClose,
  onDone,
}: {
  transaction: Transaction;
  onClose: () => void;
  onDone: (message: string | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function confirm() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await apiFetch(`/transactions/${tx.id}`, { method: "DELETE" });
      onDone(null);
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else onDone(errorMessage(err));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="delete-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <div className="px-5 py-4">
        <h2 id="delete-title" className="text-base font-black">
          Delete this {TRANSACTION_TYPES.find((t) => t.value === tx.type)?.label.toLowerCase()} of{" "}
          {formatRupees(tx.amount)}?
        </h2>
        <p className="mt-2 text-sm font-bold text-zinc-600">
          It&apos;s removed for good, and the account balance moves back. This can&apos;t be undone.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t-[2.5px] border-ink px-5 py-3">
        <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className={PRIMARY} disabled={saving} onClick={confirm}>
          {saving ? "Deleting..." : "Delete"}
        </button>
      </div>
    </dialog>
  );
}
