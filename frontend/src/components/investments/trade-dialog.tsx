"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Holding,
  type Stock,
  type Trade,
  type TradeForm,
  blankTradeForm,
  tradeFormFrom,
  tradePayload,
  tradeTotal,
} from "@/lib/investments";
import { todayIndia } from "@/lib/transactions";
import { Select } from "@/components/ui/select";

import { DIALOG, INPUT, PRIMARY, QUIET, sideLabel } from "./shared";

export type TradeKind = "buy" | "sell" | "opening";

const KINDS: { value: TradeKind; label: string }[] = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "opening", label: "Add existing shares" },
];

const NEW_STOCK = "new";
const QUANTITY_RULE = "Enter a whole number of shares, from 1 to 10,00,00,000.";
const MAX_QUANTITY = 100_000_000;
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const RENDERED = ["stock_id", "account_id", "date", "quantity", "price", "charges", "note"] as const;

type Form = TradeForm & { symbol: string; name: string };
type Key = keyof Omit<Form, "side" | "opening">;

type Props = {
  trade: Trade | null; // null means adding
  kind: TradeKind; // what to add; ignored when editing
  stocks: Stock[];
  brokers: Account[]; // active broker accounts
  holdings: Holding[];
  defaultStockId?: number | null;
  defaultAccountId?: number | null;
  onClose: () => void;
  onSaved: (saved: Trade) => void;
  onConflict: (message: string) => void;
  onStockCreated: (stock: Stock) => void;
};

function startForm(props: Props): Form {
  if (props.trade) return { ...tradeFormFrom(props.trade), symbol: "", name: "" };
  const base = blankTradeForm(props.kind === "sell" ? "sell" : "buy", todayIndia(), props.kind === "opening");
  const stockId = props.defaultStockId ?? null;
  const accountId = props.defaultAccountId ?? (props.brokers.length === 1 ? props.brokers[0].id : null);
  return {
    ...base,
    stock_id: stockId !== null ? String(stockId) : props.stocks.length === 0 && props.kind !== "sell" ? NEW_STOCK : "",
    account_id: accountId !== null && props.brokers.some((b) => b.id === accountId) ? String(accountId) : "",
    symbol: "",
    name: "",
  };
}

// The server's rules for the fields every trade needs, with its messages.
function localErrors(form: Form): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.account_id === "") errors.account_id = "Choose a broker account.";
  if (form.date === "") errors.date = "Choose a date.";
  else if (form.date > todayIndia()) errors.date = "The date can't be in the future.";
  const quantity = form.quantity.trim();
  if (!/^\d+$/.test(quantity) || Number(quantity) < 1 || Number(quantity) > MAX_QUANTITY) errors.quantity = QUANTITY_RULE;
  const price = cleanMoney(form.price);
  if (!MONEY.test(price)) errors.price = "Enter a price, like 1234.50.";
  else if (Number(price) <= 0) errors.price = "Price must be greater than 0.";
  const charges = cleanMoney(form.charges);
  if (charges !== "" && !MONEY.test(charges)) errors.charges = "Enter an amount, like 1234.50.";
  return errors;
}

function kindOf(form: { side: "buy" | "sell"; opening: boolean }): TradeKind {
  return form.opening ? "opening" : form.side;
}

// What an edit sends: only what changed, so a stale dialog can't overwrite a change made elsewhere.
function changed(form: TradeForm, original: Trade): Record<string, unknown> {
  const before = tradePayload(tradeFormFrom(original), "edit");
  const after = tradePayload(form, "edit");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) result[key] = after[key];
  }
  return result;
}

export function TradeDialog(props: Props) {
  const { trade, brokers, holdings, onClose, onSaved, onConflict, onStockCreated } = props;
  const editing = trade !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  const [form, setForm] = useState<Form>(() => startForm(props));
  const [stocks, setStocks] = useState<Stock[]>(props.stocks);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // After a failed save, move focus to the first invalid field (or the submit button).
  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const kind = kindOf(form);
  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const changeKind = (next: TradeKind) => {
    setErrors({});
    setFormError(null);
    setForm((f) => ({
      ...f,
      side: next === "sell" ? "sell" : "buy",
      opening: next === "opening",
      // A sell can only be of a stock held somewhere, so drop one that isn't (or a new stock).
      stock_id: next === "sell" && !holdings.some((h) => String(h.stock_id) === f.stock_id) ? "" : f.stock_id,
    }));
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;

    // Checked here before anything is sent: tradePayload sends NaN for a quantity that isn't a whole
    // number, and a new stock must not be created for a trade that is bound to be refused.
    const local = localErrors(form);
    if (Object.keys(local).length > 0) {
      needFocus.current = true;
      setFormError(null);
      setErrors(local);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      let current: TradeForm = form;
      if (!editing && form.stock_id === NEW_STOCK) {
        let created: Stock;
        try {
          created = await apiFetch<Stock>("/investments/stocks", {
            method: "POST",
            body: JSON.stringify({ symbol: form.symbol, name: form.name }),
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 422) {
            needFocus.current = true;
            const { fields, general } = splitErrors(err.body, ["symbol", "name"]);
            setErrors(fields);
            if (general.length > 0) setFormError(general.join(" "));
            return;
          }
          throw err;
        }
        // The stock exists now. If the trade below fails, it stays chosen so a retry doesn't add it twice.
        setStocks((list) => [...list, created].sort((a, b) => a.symbol.localeCompare(b.symbol)));
        setForm((f) => ({ ...f, stock_id: String(created.id), symbol: "", name: "" }));
        onStockCreated(created);
        current = { ...form, stock_id: String(created.id) };
      }

      if (editing) {
        const payload = changed(current, trade);
        if (Object.keys(payload).length === 0) {
          ref.current?.close();
          return;
        }
        onSaved(await apiFetch<Trade>(`/investments/trades/${trade.id}`, { method: "PATCH", body: JSON.stringify(payload) }));
      } else {
        onSaved(await apiFetch<Trade>("/investments/trades", { method: "POST", body: JSON.stringify(tradePayload(current, "create")) }));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        needFocus.current = true;
        const { fields, general } = splitErrors(err.body, RENDERED);
        setErrors(fields);
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

  const field = (key: Key, label: string, input: React.ReactNode, hint?: React.ReactNode) => (
    <div>
      <label htmlFor={`tr-${key}`} className="mb-1 block text-xs font-black tracking-wide uppercase">
        {label}
      </label>
      {input}
      {hint}
      {errors[key] ? (
        <p id={`tre-${key}`} className="mt-1 text-xs font-extrabold text-loss">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const props_ = (key: Key) => ({
    id: `tr-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `tre-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const pickerProps = (key: Key) => ({
    id: `tr-${key}`,
    value: form[key],
    disabled: saving,
    invalid: Boolean(errors[key]),
    describedBy: errors[key] ? `tre-${key}` : undefined,
    onChange: (value: string) => set(key, value),
  });

  // A sell can only be of a stock held somewhere (or the one being edited).
  const heldIds = new Set(holdings.map((h) => h.stock_id));
  const stockOptions = [
    ...stocks
      .filter((s) => kind !== "sell" || heldIds.has(s.id) || s.id === trade?.stock_id)
      .map((s) => ({ value: String(s.id), label: `${s.symbol} · ${s.name}` })),
    ...(!editing && kind !== "sell" ? [{ value: NEW_STOCK, label: "New stock..." }] : []),
  ];
  const brokerOptions = brokers.map((b) => ({ value: String(b.id), label: b.name }));
  const held = holdings.find((h) => String(h.stock_id) === form.stock_id && String(h.account_id) === form.account_id);
  const total = tradeTotal(form);
  const title = editing ? "Edit trade" : kind === "opening" ? "Add existing shares" : kind === "buy" ? "Buy shares" : "Sell shares";

  const closeButton = (
    <button type="button" disabled={saving} onClick={() => ref.current?.close()} className={QUIET}>
      Cancel
    </button>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby="trade-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(32rem,calc(100vw-2rem))]`}
    >
      {brokers.length === 0 && !editing ? (
        <div>
          <h2 id="trade-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
            {title}
          </h2>
          <div className="px-5 py-4">
            <p className="text-sm font-extrabold">Add a broker account first</p>
            <p className="mt-1 text-sm text-zinc-600">
              Shares are held in a broker account, and buys and sells move its cash.
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
            {closeButton}
            <Link href="/accounts" className={PRIMARY}>
              Go to accounts
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
          <h2 id="trade-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
            {title}
          </h2>
          <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
            {editing ? (
              <div>
                <span className="mb-1 block text-xs font-black tracking-wide uppercase">Type</span>
                <p className="text-sm text-zinc-600">{sideLabel(form)}</p>
              </div>
            ) : (
              <fieldset disabled={saving}>
                <legend className="mb-1 block text-xs font-black tracking-wide uppercase">Type</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {KINDS.map((option) => (
                    <label key={option.value} className="flex items-center gap-1.5 text-sm font-extrabold">
                      <input
                        type="radio"
                        className="size-4 accent-ink"
                        name="kind"
                        value={option.value}
                        checked={kind === option.value}
                        onChange={() => changeKind(option.value)}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {field(
              "stock_id",
              "Stock",
              <Select {...pickerProps("stock_id")} placeholder="Choose a stock" options={stockOptions} />,
              kind === "sell" && stockOptions.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-600">You don&apos;t hold any shares to sell.</p>
              ) : null,
            )}

            {form.stock_id === NEW_STOCK && (
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4">
                {field(
                  "symbol",
                  "Symbol",
                  <input {...props_("symbol")} type="text" autoComplete="off" maxLength={20} placeholder="INFY" className={`${INPUT} uppercase`} />,
                )}
                {field("name", "Company name", <input {...props_("name")} type="text" autoComplete="off" maxLength={60} placeholder="Infosys" />)}
              </div>
            )}

            {field(
              "account_id",
              "Broker account",
              <Select {...pickerProps("account_id")} placeholder="Choose a broker account" options={brokerOptions} />,
              kind === "sell" && form.stock_id && form.account_id ? (
                <p className="mt-1 text-xs text-zinc-600" aria-live="polite">
                  {held ? `You hold ${held.shares} here.` : "You hold none of this stock here."}
                </p>
              ) : null,
            )}

            <div className="grid grid-cols-2 gap-4">
              {field("quantity", "Shares", <input {...props_("quantity")} type="text" inputMode="numeric" autoComplete="off" required />)}
              {field(
                "date",
                kind === "opening" ? "Bought around" : "Date",
                <input {...props_("date")} type="date" max={todayIndia()} required />,
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              {field(
                "price",
                kind === "opening" ? "Average buy price (₹)" : "Price per share (₹)",
                <input {...props_("price")} type="text" inputMode="decimal" autoComplete="off" required />,
              )}
              {field("charges", "Charges (₹, optional)", <input {...props_("charges")} type="text" inputMode="decimal" autoComplete="off" />)}
            </div>

            {field("note", "Note (optional)", <input {...props_("note")} type="text" autoComplete="off" maxLength={200} />)}

            <p className="rounded-[14px] border-2 border-ink bg-bg px-3 py-2 text-sm font-bold" aria-live="polite">
              {kind === "opening" ? (
                <>
                  {total !== null && !total.startsWith("-") ? `Cost ${formatRupees(total)}. ` : null}
                  Your broker&apos;s cash won&apos;t change.
                </>
              ) : total === null ? (
                <span className="text-zinc-600">
                  Enter shares and price to see the total. Charges are brokerage, taxes and fees together.
                </span>
              ) : total.startsWith("-") ? (
                <span className="text-zinc-600">The charges are more than the sale value.</span>
              ) : (
                <>
                  {kind === "buy" ? "You pay " : "You receive "}
                  <span className="font-black tabular-nums">{formatRupees(total)}</span>
                  {kind === "buy" ? " from your broker's cash." : " into your broker's cash."}
                </>
              )}
            </p>

            {formError ? (
              <p role="alert" className="text-sm font-extrabold text-loss">
                {formError}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
            {closeButton}
            <button ref={submitRef} type="submit" disabled={saving} className={PRIMARY}>
              {saving ? "Saving..." : editing ? "Save changes" : kind === "opening" ? "Add shares" : kind === "buy" ? "Buy" : "Sell"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
