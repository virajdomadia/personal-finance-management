// Search and filters on the transactions list. Every filter goes to the server as a query
// parameter (backend/app/api/routes/transactions.py, list_transactions), so its totals match.

import { cleanMoney } from "./accounts.ts";
import { formatDate } from "./dates.ts";
import { whole } from "./recurring.ts";
import { TRANSACTION_TYPES, type TransactionType } from "./transactions.ts";

export type TransactionFilters = {
  month: string; // "YYYY-MM"; left out of the query while a date range is set
  q: string;
  dateFrom: string; // "YYYY-MM-DD" or ""
  dateTo: string;
  accountId: number | null;
  type: TransactionType | null;
  category: string | null; // a name; "Uncategorised" finds those without one
  amountMin: string; // as typed, "" for none
  amountMax: string;
};

export const UNCATEGORISED = "Uncategorised";

export function blankFilters(month: string, accountId: number | null = null): TransactionFilters {
  return {
    month,
    q: "",
    dateFrom: "",
    dateTo: "",
    accountId,
    type: null,
    category: null,
    amountMin: "",
    amountMax: "",
  };
}

export const hasDateRange = (f: TransactionFilters) => f.dateFrom !== "" || f.dateTo !== "";

const amountParam = (raw: string) => cleanMoney(raw).trim();

export function transactionsQuery(f: TransactionFilters, offset: number, limit: number): string {
  const params: [string, string][] = [];
  if (hasDateRange(f)) {
    if (f.dateFrom !== "") params.push(["date_from", f.dateFrom]);
    if (f.dateTo !== "") params.push(["date_to", f.dateTo]);
  } else {
    params.push(["month", f.month]);
  }
  params.push(["limit", String(limit)], ["offset", String(offset)]);
  if (f.accountId !== null) params.push(["account_id", String(f.accountId)]);
  if (f.type !== null) params.push(["type", f.type]);
  const q = f.q.trim();
  if (q !== "") params.push(["q", q]);
  if (f.category !== null && f.category.trim() !== "") params.push(["category", f.category.trim()]);
  if (amountParam(f.amountMin) !== "") params.push(["amount_min", amountParam(f.amountMin)]);
  if (amountParam(f.amountMax) !== "") params.push(["amount_max", amountParam(f.amountMax)]);
  return `/transactions?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}

export type FilterKey = "dates" | "account" | "type" | "category" | "amount" | "q";
export type FilterChip = { key: FilterKey; label: string };

const shortDate = (iso: string) => formatDate(iso);

// "₹500 – ₹2,000", "₹500 or more", "Up to ₹2,000".
export function amountLabel(min: string, max: string): string | null {
  const low = amountParam(min);
  const high = amountParam(max);
  if (low !== "" && high !== "") return `${whole(low)} – ${whole(high)}`;
  if (low !== "") return `${whole(low)} or more`;
  if (high !== "") return `Up to ${whole(high)}`;
  return null;
}

// "1 Nov 2026 – 12 Nov 2026", "From 1 Nov 2026", "Until 12 Nov 2026".
export function dateRangeLabel(from: string, to: string): string | null {
  if (from !== "" && to !== "") return from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  if (from !== "") return `From ${shortDate(from)}`;
  if (to !== "") return `Until ${shortDate(to)}`;
  return null;
}

// One chip per active filter (the month and the search box show themselves). `fixedAccount` hides
// the account, for a list that only ever shows one.
export function filterChips(
  f: TransactionFilters,
  accountName: (id: number) => string | undefined,
  fixedAccount = false,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const dates = dateRangeLabel(f.dateFrom, f.dateTo);
  if (dates) chips.push({ key: "dates", label: dates });
  if (f.type !== null) chips.push({ key: "type", label: TRANSACTION_TYPES.find((t) => t.value === f.type)?.label ?? f.type });
  if (!fixedAccount && f.accountId !== null) chips.push({ key: "account", label: accountName(f.accountId) ?? "One account" });
  if (f.category !== null) chips.push({ key: "category", label: f.category });
  const amount = amountLabel(f.amountMin, f.amountMax);
  if (amount) chips.push({ key: "amount", label: amount });
  return chips;
}

export function removeFilter(f: TransactionFilters, key: FilterKey): TransactionFilters {
  switch (key) {
    case "dates":
      return { ...f, dateFrom: "", dateTo: "" };
    case "account":
      return { ...f, accountId: null };
    case "type":
      return { ...f, type: null };
    case "category":
      return { ...f, category: null };
    case "amount":
      return { ...f, amountMin: "", amountMax: "" };
    case "q":
      return { ...f, q: "" };
  }
}

// Anything narrower than the whole month (or range): the totals then read as "matching".
export function isNarrowed(f: TransactionFilters, fixedAccount = false): boolean {
  return filterChips(f, () => "", fixedAccount).some((c) => c.key !== "dates") || f.q.trim() !== "";
}

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

// The sheet's checks, in the server's words where it has them.
export function filterErrors(f: TransactionFilters): Record<string, string> {
  const errors: Record<string, string> = {};
  if (f.dateFrom !== "" && f.dateTo !== "" && f.dateFrom > f.dateTo) {
    errors.dateTo = "The end date can't be before the start.";
  }
  const low = amountParam(f.amountMin);
  const high = amountParam(f.amountMax);
  if (low !== "" && !MONEY.test(low)) errors.amountMin = "Enter an amount like 500 or 500.50.";
  if (high !== "" && !MONEY.test(high)) errors.amountMax = "Enter an amount like 500 or 500.50.";
  if (!errors.amountMin && !errors.amountMax && low !== "" && high !== "" && Number(low) > Number(high)) {
    errors.amountMax = "The highest amount can't be below the lowest.";
  }
  return errors;
}

// Handed between the list and the filter screen (and from the month screen to the list): the list
// puts its filters in `draft` before opening the sheet, and whoever wants the list to change puts
// the new filters in `next`, which the list reads when it regains focus.
export const filterHandoff: { draft: TransactionFilters | null; next: TransactionFilters | null } = {
  draft: null,
  next: null,
};
