import { formatRupees } from "./accounts.ts";
import { formatDate } from "./transactions.ts";

// These mirror the response models in backend/app/api/routes/corporate_actions.py.
export type ActionKind = "split" | "consolidation" | "bonus" | "merger" | "demerger" | "dividend" | "other";
export type ActionStatus = "pending" | "applied" | "dismissed";

export type Preview = {
  shares_before: number;
  shares_after: number;
  average_before: string;
  average_after: string;
};

export type DividendAccount = { account_id: number; account_name: string; gross: string; links: number[] };
export type DividendFigures = { gross: string; by_account: DividendAccount[] };

export type CorporateAction = {
  id: number;
  stock_id: number;
  symbol: string;
  kind: ActionKind;
  ex_date: string;
  ratio_new: string | null;
  ratio_old: string | null;
  amount_per_share: string | null;
  status: ActionStatus;
  purpose: string | null;
  target_stock_id: number | null;
  cost_share_pct: string | null;
  preview: Preview | null;
  dividend: DividendFigures | null;
};

export type ActionList = { actions: CorporateAction[]; pending_count: number };
export type StockActions = { actions: CorporateAction[]; suspect_drop_on: string | null; backfilled: boolean };

export type LinkSuggestion = {
  id: number;
  date: string;
  amount: string;
  account_id: number;
  account_name: string;
  note: string | null;
};
export type LinkSuggestions = {
  accounts: { account_id: number; account_name: string; gross: string; suggestions: LinkSuggestion[] }[];
};

// Fields sent when entering or editing an action; every value is text, a number or null.
export type ActionBody = {
  kind?: ActionKind;
  ex_date?: string;
  ratio_new?: string | null;
  ratio_old?: string | null;
  amount_per_share?: string | null;
  target_stock_id?: number | null;
  cost_share_pct?: string | null;
  status?: ActionStatus;
};

// api.ts is loaded on first call so the pure helpers below stay importable by the node tests,
// which cannot load its class parameter properties.
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const api = await import("./api.ts");
  return api.apiFetch<T>(path, init);
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const listActions = (status: ActionStatus = "pending") =>
  apiFetch<ActionList>(`/investments/actions?status=${status}`);
export const stockActions = (stockId: number) => apiFetch<StockActions>(`/investments/stocks/${stockId}/actions`);
export const createAction = (stockId: number, body: ActionBody) =>
  apiFetch<CorporateAction>(`/investments/stocks/${stockId}/actions`, json("POST", body));
export const updateAction = (id: number, body: ActionBody) =>
  apiFetch<CorporateAction>(`/investments/actions/${id}`, json("PATCH", body));
export const linkSuggestions = (id: number) => apiFetch<LinkSuggestions>(`/investments/actions/${id}/link-suggestions`);
export const link = (id: number, transactionId: number) =>
  apiFetch<CorporateAction>(`/investments/actions/${id}/links/${transactionId}`, json("POST"));
export const unlink = (id: number, transactionId: number) =>
  apiFetch<CorporateAction>(`/investments/actions/${id}/links/${transactionId}`, json("DELETE"));
export const dismissSuspectDrop = (stockId: number) =>
  apiFetch<StockActions>(`/investments/stocks/${stockId}/suspect-drop`, json("DELETE"));

// A per-share amount with at least two decimals: "2.5" -> "₹2.50".
function perShare(amount: string): string {
  const [whole, fraction = ""] = amount.split(".");
  return formatRupees(`${whole}.${fraction.padEnd(2, "0")}`);
}

const KIND_LABEL: Record<ActionKind, string> = {
  split: "Split",
  consolidation: "Consolidation",
  bonus: "Bonus",
  merger: "Merger",
  demerger: "Demerger",
  dividend: "Dividend",
  other: "Other action",
};

// "Split 1:5 on 12 Mar 2026". A 1:5 split turns one share into five.
export function describeAction(a: CorporateAction): string {
  const date = formatDate(a.ex_date);
  if (a.kind === "dividend") {
    return `Dividend ${a.amount_per_share !== null ? `${perShare(a.amount_per_share)}/share` : ""} on ${date}`.replace("Dividend  on", "Dividend on");
  }
  if (a.kind === "other") return `${a.purpose ?? KIND_LABEL.other} on ${date}`;
  // A bonus is quoted as new:old ("2:1" is two free shares per one held); a split as old:new.
  const pair = a.kind === "bonus" ? [a.ratio_new, a.ratio_old] : [a.ratio_old, a.ratio_new];
  const ratio = a.ratio_old !== null && a.ratio_new !== null ? ` ${pair[0]}:${pair[1]}` : "";
  return `${KIND_LABEL[a.kind]}${ratio} on ${date}`;
}

// "40 → 200 shares · avg ₹1,500.00 → ₹300.00"; empty when there is nothing to preview.
export function describePreview(p: Preview | null): string {
  if (p === null) return "";
  return `${p.shares_before} → ${p.shares_after} shares · avg ${formatRupees(p.average_before)} → ${formatRupees(p.average_after)}`;
}

export function isUpcoming(a: { ex_date: string }, today: string): boolean {
  return a.ex_date > today;
}

// What a dividend paid (or will pay). Empty for any other kind.
export function dividendLabel(a: CorporateAction, today: string): string {
  if (a.kind !== "dividend" || a.dividend === null) return "";
  const { gross, by_account } = a.dividend;
  if (a.status === "applied" && by_account.length === 0 && Number(gross) === 0) return "Not held on record date";
  const money = formatRupees(gross);
  if (a.status !== "applied") return `Would pay ${money}`;
  return isUpcoming(a, today) ? `Expected ${money}` : `Received ${money}`;
}

// Cost-share percent as typed: digits and one dot, or empty.
export function cleanPercent(value: string): string {
  return value.replace(/[^\d.]/g, "");
}
