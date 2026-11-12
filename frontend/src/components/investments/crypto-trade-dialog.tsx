"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type MarketMatch, asFirstTrade, prefillFromMatch, withTradePath } from "@/lib/investments";
import {
  type Coin,
  type CoinHolding,
  type CryptoTrade,
  type CryptoTradeForm,
  type CryptoTradeMode,
  cryptoTradeFormFrom,
  cryptoTradePayload,
  formatCoinQty,
  qtyMismatch,
  validNumber,
} from "@/lib/crypto";
import { todayIndia } from "@/lib/transactions";
import { Select } from "@/components/ui/select";

import { LinkField } from "./link-dialog";
import { BackButton, DIALOG, INPUT, PRIMARY, QUIET, StepLine, useAddFlow } from "./shared";

const MODES: { value: CryptoTradeMode; label: string }[] = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "opening", label: "Add existing coins" },
];

export const NEW_COIN = "new";
// The server's messages, so a local check reads the same as the server's.
export const QTY_RULE = "Enter a quantity above 0, with up to 8 decimals, like 0.00014067.";
export const PRICE_RULE = "Enter a price above 0, with up to 4 decimals, like 7504827.5.";
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const MISMATCH = "Quantity × price doesn't match the amount. Check the quantity and price.";
const RENDERED = ["coin_id", "name", "symbol", "account_id", "date", "amount", "charges", "price", "quantity", "note"] as const;

type Form = CryptoTradeForm & { name: string; symbol: string };
type Key = keyof Omit<Form, "mode">;

type Props = {
  trade: CryptoTrade | null; // null means adding
  initial: CryptoTradeForm; // the form to start from when adding; ignored when editing
  coins: Coin[];
  brokers: Account[]; // active exchange accounts
  holdings: CoinHolding[];
  onClose: () => void;
  onSaved: (saved: CryptoTrade) => void;
  onConflict: (message: string) => void;
  onCoinCreated: (coin: Coin) => void;
};

function startForm(props: Props, adding: boolean): Form {
  if (props.trade) return { ...cryptoTradeFormFrom(props.trade), name: "", symbol: "" };
  const form: Form = { ...props.initial, name: "", symbol: "" };
  if (form.coin_id === "" && (props.coins.length === 0 || adding) && form.mode !== "sell") form.coin_id = NEW_COIN;
  if (form.account_id === "" && props.brokers.length === 1) form.account_id = String(props.brokers[0].id);
  return form;
}

// The server's rules for the fields every trade needs, with its messages.
function localErrors(form: Form): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.coin_id === NEW_COIN) {
    if (form.symbol.trim() === "") errors.symbol = "Enter the coin's ticker, like BTC.";
    if (form.name.trim() === "") errors.name = "Enter a name.";
  } else if (form.coin_id === "") errors.coin_id = "Choose a coin.";
  if (form.account_id === "") errors.account_id = "Choose a broker or exchange account.";
  if (form.date === "") errors.date = "Choose a date.";
  else if (form.date > todayIndia()) errors.date = "The date can't be in the future.";
  // The server's limits: quantity up to 8 decimals and 16 whole digits, price up to 4 and 10.
  if (!validNumber(form.quantity.trim(), 8, 16)) errors.quantity = QTY_RULE;
  if (form.mode !== "opening" && !validNumber(form.price.trim(), 4, 10)) errors.price = PRICE_RULE;
  const amount = cleanMoney(form.amount);
  if (amount === "") errors.amount = "Enter the amount.";
  else if (!MONEY.test(amount)) errors.amount = "Enter an amount, like 3000 or 2999.85.";
  else if (Number(amount) <= 0) errors.amount = "Amount must be greater than 0.";
  const charges = cleanMoney(form.charges);
  if (charges !== "" && !MONEY.test(charges)) errors.charges = "Enter an amount, like 2.50.";
  return errors;
}

// What an edit sends: only what changed, so a stale dialog can't overwrite a change made elsewhere.
function changed(form: CryptoTradeForm, original: CryptoTrade): Record<string, unknown> {
  const before = cryptoTradePayload(cryptoTradeFormFrom(original), "edit");
  const after = cryptoTradePayload(form, "edit");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) result[key] = after[key];
  }
  return result;
}

function modeLabel(mode: CryptoTradeMode): string {
  return MODES.find((m) => m.value === mode)?.label ?? "";
}

export function CryptoTradeDialog(props: Props) {
  const { trade, brokers, holdings, onClose, onSaved, onConflict, onCoinCreated } = props;
  const editing = trade !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const needFocus = useRef(false);
  // In the Add investment flow this is a first purchase: a new one, bought or already held.
  const adding = useAddFlow();
  const [form, setForm] = useState<Form>(() => startForm(props, adding));
  const coins = props.coins;
  const [source, setSource] = useState<MarketMatch | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const mode = form.mode;
  // A match from the search fills in the name (and a coin's ticker), unless they were already typed.
  const pickSource = (match: MarketMatch | null) => {
    setSource(match);
    if (!match) return;
    const fill = prefillFromMatch("crypto", match);
    setForm((f) => ({ ...f, name: f.name.trim() || fill.name, symbol: f.symbol.trim() || fill.symbol }));
  };
  const set = (key: Key, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const changeMode = (next: CryptoTradeMode) => {
    setErrors({});
    setFormError(null);
    // A sale can only be of a coin held somewhere, so drop one that isn't (or a new coin).
    const coinId = next === "sell" && !holdings.some((h) => String(h.coin_id) === form.coin_id) ? "" : form.coin_id;
    setForm((f) => ({ ...f, mode: next, coin_id: coinId, charges: next === "opening" ? "" : f.charges }));
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;

    // Checked here before anything is sent, so a new coin isn't created for a trade bound to be refused.
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
      const current: CryptoTradeForm = form;
      if (!editing && form.coin_id === NEW_COIN) {
        // The new coin and its first trade are saved together: if the trade is refused, no coin is left behind.
        const symbol = form.symbol.trim();
        const saved = await apiFetch<{ coin: Coin; trade: CryptoTrade }>(withTradePath("crypto"), {
          method: "POST",
          body: JSON.stringify({
            coin: { name: form.name, symbol: symbol, source_code: source?.code ?? null },
            trade: asFirstTrade(cryptoTradePayload(current, "create")),
          }),
        });
        onCoinCreated(saved.coin);
        onSaved(saved.trade);
        return;
      }

      if (editing) {
        const payload = changed(current, trade);
        if (Object.keys(payload).length === 0) {
          ref.current?.close();
          return;
        }
        onSaved(await apiFetch<CryptoTrade>(`/investments/crypto-trades/${trade.id}`, { method: "PATCH", body: JSON.stringify(payload) }));
      } else {
        onSaved(
          await apiFetch<CryptoTrade>("/investments/crypto-trades", {
            method: "POST",
            body: JSON.stringify(cryptoTradePayload(current, "create")),
          }),
        );
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
      <label htmlFor={`ct-${key}`} className="mb-1 block text-xs font-black tracking-wide uppercase">
        {label}
      </label>
      {input}
      {hint}
      {errors[key] ? (
        <p id={`cte-${key}`} className="mt-1 text-xs font-extrabold text-loss">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const inputProps = (key: Key) => ({
    id: `ct-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `cte-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const pickerProps = (key: Key) => ({
    id: `ct-${key}`,
    value: form[key],
    disabled: saving,
    invalid: Boolean(errors[key]),
    describedBy: errors[key] ? `cte-${key}` : undefined,
  });

  // A sale can only be of a coin held somewhere (or the one being edited).
  const heldIds = new Set(holdings.map((h) => h.coin_id));
  const coinOptions = [
    ...coins
      .filter((c) => mode !== "sell" || heldIds.has(c.id) || c.id === trade?.coin_id)
      .map((c) => ({ value: String(c.id), label: `${c.name} (${c.symbol})` })),
    ...(!editing && mode !== "sell" ? [{ value: NEW_COIN, label: "New coin..." }] : []),
  ];
  const brokerOptions = brokers.map((b) => ({ value: String(b.id), label: b.name }));
  const held = holdings.find((h) => String(h.coin_id) === form.coin_id && String(h.account_id) === form.account_id);
  const broker = brokers.find((b) => String(b.id) === form.account_id);
  const amount = cleanMoney(form.amount);
  const amountShown = MONEY.test(amount) && Number(amount) > 0 ? formatRupees(amount) : null;
  const mismatch = !errors.quantity && !errors.price && qtyMismatch(form);
  const title = editing
    ? "Edit crypto trade"
    : mode === "buy"
      ? "Buy crypto"
      : mode === "sell"
        ? "Sell crypto"
        : "Add existing coins";

  const closeButton = (
    <button type="button" disabled={saving} onClick={() => ref.current?.close()} className={QUIET}>
      Cancel
    </button>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby="crypto-trade-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(32rem,calc(100vw-2rem))]`}
    >
      {brokers.length === 0 && !editing ? (
        <div>
          <h2 id="crypto-trade-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
            {title}
            <StepLine />
          </h2>
          <div className="px-5 py-4">
            <p className="text-sm font-extrabold">Add an exchange account first</p>
            <p className="mt-1 text-sm text-zinc-600">
              Coins are bought through an exchange account, like CoinDCX, and sales are paid back into it.
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
            <BackButton disabled={saving} />
            {closeButton}
            <Link href="/accounts" className={PRIMARY}>
              Go to accounts
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="flex max-h-[90vh] flex-col">
          <h2 id="crypto-trade-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
            {title}
            <StepLine />
          </h2>
          <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
            {editing ? (
              <div>
                <span className="mb-1 block text-xs font-black tracking-wide uppercase">Type</span>
                <p className="text-sm text-zinc-600">{modeLabel(mode)}</p>
              </div>
            ) : (
              <fieldset disabled={saving}>
                <legend className="mb-1 block text-xs font-black tracking-wide uppercase">Type</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {MODES.filter((option) => !adding || option.value === "buy" || option.value === "opening").map((option) => (
                    <label key={option.value} className="flex items-center gap-1.5 text-sm font-extrabold">
                      <input
                        type="radio"
                        className="size-4 accent-ink"
                        name="mode"
                        value={option.value}
                        checked={mode === option.value}
                        onChange={() => changeMode(option.value)}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {field(
              "coin_id",
              "Coin",
              <Select
                {...pickerProps("coin_id")}
                disabled={editing || saving}
                onChange={(v) => set("coin_id", v)}
                placeholder="Choose a coin"
                options={coinOptions}
              />,
              mode === "sell" && coinOptions.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-600">You don&apos;t hold any coins to sell.</p>
              ) : null,
            )}

            {form.coin_id === NEW_COIN && <LinkField kind="crypto" selected={source} onSelect={pickSource} disabled={saving} />}

            {form.coin_id === NEW_COIN && (
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4">
                {field(
                  "symbol",
                  "Ticker",
                  <input {...inputProps("symbol")} type="text" autoComplete="off" maxLength={20} placeholder="BTC" className={`${INPUT} uppercase`} />,
                )}
                {field(
                  "name",
                  "Coin name",
                  <input {...inputProps("name")} type="text" autoComplete="off" maxLength={60} placeholder="Bitcoin" />,
                )}
              </div>
            )}

            {field(
              "account_id",
              "Exchange account",
              <Select {...pickerProps("account_id")} onChange={(v) => set("account_id", v)} placeholder="Choose an exchange account" options={brokerOptions} />,
              mode === "sell" && form.coin_id && form.account_id ? (
                <p className="mt-1 text-xs text-zinc-600" aria-live="polite">
                  {held ? `You hold ${formatCoinQty(held.quantity)} here.` : "You hold none of this coin here."}
                </p>
              ) : null,
            )}

            <div className="grid grid-cols-2 gap-4">
              {field(
                "amount",
                mode === "sell" ? "Amount received (₹)" : mode === "opening" ? "Total cost (₹)" : "Amount (₹)",
                <input {...inputProps("amount")} type="text" inputMode="decimal" autoComplete="off" required />,
              )}
              {field(
                "date",
                mode === "opening" ? "Bought around" : "Date",
                <input {...inputProps("date")} type="date" max={todayIndia()} required />,
              )}
            </div>

            {field(
              "quantity",
              "Quantity",
              <input
                {...inputProps("quantity")}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00014067"
                required
                aria-describedby={errors.quantity ? "cte-quantity" : mismatch ? "ct-mismatch" : undefined}
              />,
            )}

            {mode !== "opening" && (
              <div className="grid grid-cols-2 gap-4">
                {field(
                  "price",
                  "Price per coin (₹)",
                  <input
                    {...inputProps("price")}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="7504827.5"
                    required
                    aria-describedby={errors.price ? "cte-price" : mismatch ? "ct-mismatch" : undefined}
                  />,
                )}
                {field(
                  "charges",
                  "Charges (₹, optional)",
                  <input {...inputProps("charges")} type="text" inputMode="decimal" autoComplete="off" />,
                )}
              </div>
            )}

            {mismatch ? (
              <p id="ct-mismatch" className="-mt-2 text-xs font-extrabold text-orange-700" aria-live="polite">
                {MISMATCH}
              </p>
            ) : null}

            {field("note", "Note (optional)", <input {...inputProps("note")} type="text" autoComplete="off" maxLength={200} />)}

            <p className="rounded-[14px] border-2 border-ink bg-bg px-3 py-2 text-sm font-bold" aria-live="polite">
              {mode === "opening" ? (
                <>Your {broker ? broker.name : "exchange"} balance won&apos;t change.</>
              ) : amountShown === null ? (
                <span className="text-zinc-600">
                  {mode === "buy" ? "Enter the amount, quantity and price." : "Enter the amount you received."}
                </span>
              ) : (
                <>
                  <span className="font-black tabular-nums">{amountShown}</span>
                  {mode === "buy" ? " leaves " : " goes into "}
                  {broker ? broker.name : "your exchange account"}.
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
            <BackButton disabled={saving} />
            {closeButton}
            <button ref={submitRef} type="submit" disabled={saving} className={PRIMARY}>
              {saving ? "Saving..." : editing ? "Save changes" : mode === "buy" ? "Buy" : mode === "sell" ? "Sell" : "Add coins"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
