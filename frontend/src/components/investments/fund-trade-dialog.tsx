"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, cleanMoney, errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type MarketMatch, type Prefill, applyPick, asFirstTrade, withTradePath } from "@/lib/investments";
import {
  type Fund,
  type FundHolding,
  type FundTrade,
  type FundTradeForm,
  type FundTradeMode,
  type Sip,
  formatUnits,
  fundTradeFormFrom,
  fundTradePayload,
  stampDuty,
  suggestedUnits,
  unitsMismatch,
} from "@/lib/funds";
import { todayIndia } from "@/lib/transactions";
import { Select } from "@/components/ui/select";

import { LinkField } from "./link-dialog";
import { BackButton, DIALOG, INPUT, PRIMARY, QUIET, StepLine, useAddFlow } from "./shared";

const MODES: { value: FundTradeMode; label: string }[] = [
  { value: "sip", label: "Record SIP" },
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Redeem" },
  { value: "opening", label: "Add existing units" },
];

export const NEW_FUND = "new";
// The server's messages, so a local check reads the same as the server's.
export const UNITS_RULE = "Enter units above 0, with up to 3 decimals, like 35.552.";
export const NAV_RULE = "Enter a NAV above 0, with up to 4 decimals, like 84.3793.";
const MONEY = /^\d+(?:\.\d{1,2})?$/;
const UNITS = /^\d+(?:\.\d{1,3})?$/;
const NAV = /^\d+(?:\.\d{1,4})?$/;
const MISMATCH = "Units × NAV doesn't match the amount. Check the units and NAV.";
const RENDERED = ["fund_id", "name", "symbol", "account_id", "sip_id", "date", "amount", "charges", "nav", "units", "note"] as const;

type Form = FundTradeForm & { name: string; symbol: string };
type Key = keyof Omit<Form, "mode">;

type Props = {
  trade: FundTrade | null; // null means adding
  initial: FundTradeForm; // the form to start from when adding; ignored when editing
  funds: Fund[];
  banks: Account[]; // active bank accounts
  holdings: FundHolding[];
  sips: Sip[];
  focusNav?: boolean;
  onClose: () => void;
  onSaved: (saved: FundTrade) => void;
  onConflict: (message: string) => void;
  onFundCreated: (fund: Fund) => void;
};

function startForm(props: Props, adding: boolean): Form {
  if (props.trade) return { ...fundTradeFormFrom(props.trade), name: "", symbol: "" };
  const form: Form = { ...props.initial, name: "", symbol: "" };
  if (form.fund_id === "" && (props.funds.length === 0 || adding) && form.mode !== "sell") form.fund_id = NEW_FUND;
  if (form.account_id === "" && props.banks.length === 1) form.account_id = String(props.banks[0].id);
  if (form.mode === "sip" && form.sip_id === "") {
    const only = onlySip(props.sips, form.fund_id);
    if (only) return { ...form, ...sipFields(only) };
  }
  return form;
}

// The fund's one active SIP, if it has exactly one.
function onlySip(sips: Sip[], fundId: string): Sip | null {
  const active = sips.filter((s) => String(s.fund_id) === fundId && s.active);
  return active.length === 1 ? active[0] : null;
}

// Choosing a SIP brings its bank account, amount and stamp duty.
function sipFields(sip: Sip): Partial<Form> {
  return {
    sip_id: String(sip.id),
    account_id: String(sip.account_id),
    amount: sip.amount,
    charges: stampDuty(sip.amount) ?? "",
  };
}

// The server's rules for the fields every transaction needs, with its messages.
function localErrors(form: Form): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.fund_id === NEW_FUND) {
    if (form.name.trim() === "") errors.name = "Enter a name.";
  } else if (form.fund_id === "") errors.fund_id = "Choose a fund.";
  if (form.account_id === "") errors.account_id = "Choose a bank account.";
  if (form.date === "") errors.date = "Choose a date.";
  else if (form.date > todayIndia()) errors.date = "The date can't be in the future.";
  const units = form.units.trim();
  if (!UNITS.test(units) || Number(units) <= 0 || units.split(".")[0].length > 15) errors.units = UNITS_RULE;
  if (form.mode !== "opening") {
    const nav = form.nav.trim();
    if (!NAV.test(nav) || Number(nav) <= 0 || nav.split(".")[0].length > 10) errors.nav = NAV_RULE;
  }
  const amount = cleanMoney(form.amount);
  if (amount === "") errors.amount = "Enter the amount.";
  else if (!MONEY.test(amount)) errors.amount = "Enter an amount, like 3000 or 2999.85.";
  else if (Number(amount) <= 0) errors.amount = "Amount must be greater than 0.";
  const charges = cleanMoney(form.charges);
  if (charges !== "" && !MONEY.test(charges)) errors.charges = "Enter an amount, like 0.15.";
  return errors;
}

// What an edit sends: only what changed, so a stale dialog can't overwrite a change made elsewhere.
function changed(form: FundTradeForm, original: FundTrade): Record<string, unknown> {
  const before = fundTradePayload(fundTradeFormFrom(original), "edit");
  const after = fundTradePayload(form, "edit");
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) result[key] = after[key];
  }
  return result;
}

function modeLabel(mode: FundTradeMode): string {
  return MODES.find((m) => m.value === mode)?.label ?? "";
}

function sipLabel(sip: Sip): string {
  const amount = formatRupees(sip.amount.replace(/\.00$/, ""));
  return `${amount} on day ${sip.day} · ${sip.account_name}${sip.active ? "" : " (stopped)"}`;
}

export function FundTradeDialog(props: Props) {
  const { trade, banks, holdings, sips, focusNav, onClose, onSaved, onConflict, onFundCreated } = props;
  const editing = trade !== null;
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLInputElement>(null);
  const needFocus = useRef(false);
  // In the Add investment flow this is a first purchase: a new one, bought or already held.
  const adding = useAddFlow();
  const [form, setForm] = useState<Form>(() => startForm(props, adding));
  const funds = props.funds;
  const [source, setSource] = useState<MarketMatch | null>(null);
  // Units and stamp duty follow the amount and NAV until the owner types them by hand.
  const [unitsByHand, setUnitsByHand] = useState(editing);
  const [chargesByHand, setChargesByHand] = useState(editing);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    if (focusNav) navRef.current?.focus();
  }, [focusNav]);

  useEffect(() => {
    if (!needFocus.current || saving) return;
    needFocus.current = false;
    const invalid = ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? submitRef.current)?.focus();
  }, [errors, formError, saving]);

  const mode = form.mode;
  const purchase = mode === "buy" || mode === "sip";

  // Applies a change, then works out stamp duty and units again where they aren't typed by hand.
  const update = (change: Partial<Form>, hand: { units?: boolean; charges?: boolean } = {}) => {
    const unitsHand = hand.units ?? unitsByHand;
    const chargesHand = hand.charges ?? chargesByHand;
    setForm((f) => {
      const next = { ...f, ...change };
      const isPurchase = next.mode === "buy" || next.mode === "sip";
      if (isPurchase && !chargesHand && change.charges === undefined && change.amount !== undefined) {
        next.charges = stampDuty(next.amount) ?? "";
      }
      if (isPurchase && !unitsHand && change.units === undefined) {
        next.units = suggestedUnits(next.amount, next.charges, next.nav) ?? "";
      }
      return next;
    });
  };
  // A match links live prices and fills in the name (and symbol). What the last pick filled in is
  // remembered, so a new pick replaces it and clearing removes it; text typed by hand stays.
  const filled = useRef<Prefill | null>(null);
  const pickSource = (match: MarketMatch | null) => {
    setSource(match);
    const next = applyPick("mutual_fund", { name: form.name, symbol: form.symbol }, filled.current, match);
    filled.current = next.filled;
    setForm((f) => ({ ...f, ...next.fields }));
  };
  const set = (key: Key, value: string) => {
    if (key === "units") {
      setUnitsByHand(true);
      update({ units: value }, { units: true });
    } else if (key === "charges") {
      setChargesByHand(true);
      update({ charges: value }, { charges: true });
    } else {
      update({ [key]: value });
    }
  };

  const changeMode = (next: FundTradeMode) => {
    setErrors({});
    setFormError(null);
    // A redemption can only be of a fund held somewhere, so drop one that isn't (or a new fund).
    const fundId = next === "sell" && !holdings.some((h) => String(h.fund_id) === form.fund_id) ? "" : form.fund_id;
    const change: Partial<Form> = { mode: next, fund_id: fundId, sip_id: next === "sip" ? form.sip_id : "" };
    if (next !== "buy" && next !== "sip") {
      // Worked-out units and stamp duty belong to a purchase. What was typed by hand stays.
      if (!unitsByHand) change.units = "";
      if (!chargesByHand || next === "opening") change.charges = "";
    }
    const only = next === "sip" && form.sip_id === "" ? onlySip(sips, fundId) : null;
    if (only) {
      setChargesByHand(false);
      update({ ...change, ...sipFields(only) }, { charges: false });
    } else {
      update(change);
    }
  };

  const changeFund = (value: string) => {
    const only = form.mode === "sip" ? onlySip(sips, value) : null;
    if (only) {
      setChargesByHand(false);
      update({ fund_id: value, ...sipFields(only) }, { charges: false });
    } else {
      update({ fund_id: value, sip_id: "" });
    }
  };

  const changeSip = (value: string) => {
    const sip = sips.find((s) => String(s.id) === value);
    if (!sip) {
      update({ sip_id: value });
      return;
    }
    setChargesByHand(false);
    update(sipFields(sip), { charges: false });
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;

    // Checked here before anything is sent, so a new fund isn't created for a transaction bound to be refused.
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
      const current: FundTradeForm = form;
      if (!editing && form.fund_id === NEW_FUND) {
        // The new fund and its first trade are saved together: if the trade is refused, no fund is left behind.
        const symbol = form.symbol.trim();
        const saved = await apiFetch<{ fund: Fund; trade: FundTrade }>(withTradePath("mutual_fund"), {
          method: "POST",
          body: JSON.stringify({
            fund: { name: form.name, symbol: symbol === "" ? null : symbol, source_code: source?.code ?? null },
            trade: asFirstTrade(fundTradePayload(current, "create")),
          }),
        });
        onFundCreated(saved.fund);
        onSaved(saved.trade);
        return;
      }

      if (editing) {
        const payload = changed(current, trade);
        if (Object.keys(payload).length === 0) {
          ref.current?.close();
          return;
        }
        onSaved(await apiFetch<FundTrade>(`/investments/fund-trades/${trade.id}`, { method: "PATCH", body: JSON.stringify(payload) }));
      } else {
        onSaved(
          await apiFetch<FundTrade>("/investments/fund-trades", { method: "POST", body: JSON.stringify(fundTradePayload(current, "create")) }),
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
      <label htmlFor={`ft-${key}`} className="mb-1 block text-xs font-black tracking-wide uppercase">
        {label}
      </label>
      {input}
      {hint}
      {errors[key] ? (
        <p id={`fte-${key}`} className="mt-1 text-xs font-extrabold text-loss">
          {errors[key]}
        </p>
      ) : null}
    </div>
  );
  const inputProps = (key: Key) => ({
    id: `ft-${key}`,
    name: key,
    value: form[key],
    disabled: saving,
    className: INPUT,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `fte-${key}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value),
  });
  const pickerProps = (key: Key) => ({
    id: `ft-${key}`,
    value: form[key],
    disabled: saving,
    invalid: Boolean(errors[key]),
    describedBy: errors[key] ? `fte-${key}` : undefined,
  });

  // A redemption can only be of a fund held somewhere (or the one being edited).
  const heldIds = new Set(holdings.map((h) => h.fund_id));
  const fundOptions = [
    ...funds
      .filter((f) => mode !== "sell" || heldIds.has(f.id) || f.id === trade?.fund_id)
      .map((f) => ({ value: String(f.id), label: f.name })),
    ...(!editing && mode !== "sell" ? [{ value: NEW_FUND, label: "New fund..." }] : []),
  ];
  const bankOptions = banks.map((b) => ({ value: String(b.id), label: b.name }));
  const fundSips = sips.filter((s) => String(s.fund_id) === form.fund_id && (s.active || String(s.id) === form.sip_id));
  const sipOptions = fundSips.map((s) => ({ value: String(s.id), label: sipLabel(s) }));
  const held = holdings.find((h) => String(h.fund_id) === form.fund_id && String(h.account_id) === form.account_id);
  const bank = banks.find((b) => String(b.id) === form.account_id);
  const amount = cleanMoney(form.amount);
  const amountShown = MONEY.test(amount) && Number(amount) > 0 ? formatRupees(amount) : null;
  const mismatch = purchase && !errors.units && unitsMismatch(form);
  const title = editing
    ? "Edit fund transaction"
    : mode === "sip"
      ? "Record SIP"
      : mode === "buy"
        ? "Buy fund units"
        : mode === "sell"
          ? "Redeem fund units"
          : "Add existing units";

  const closeButton = (
    <button type="button" disabled={saving} onClick={() => ref.current?.close()} className={QUIET}>
      Cancel
    </button>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby="fund-trade-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(32rem,calc(100vw-2rem))]`}
    >
      {banks.length === 0 && !editing ? (
        <div>
          <h2 id="fund-trade-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
            {title}
            <StepLine />
          </h2>
          <div className="px-5 py-4">
            <p className="text-sm font-extrabold">Add a bank account first</p>
            <p className="mt-1 text-sm text-zinc-600">
              Mutual funds are bought from a bank account, and redemptions are paid back into one.
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
          <h2 id="fund-trade-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
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
              "fund_id",
              "Fund",
              <Select {...pickerProps("fund_id")} disabled={editing || saving} onChange={changeFund} placeholder="Choose a fund" options={fundOptions} />,
              mode === "sell" && fundOptions.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-600">You don&apos;t hold any fund units to redeem.</p>
              ) : null,
            )}

            {form.fund_id === NEW_FUND && <LinkField kind="mutual_fund" selected={source} onSelect={pickSource} disabled={saving} />}

            {form.fund_id === NEW_FUND && (
              <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-4">
                {field(
                  "name",
                  "Fund name",
                  <input {...inputProps("name")} type="text" autoComplete="off" maxLength={60} placeholder="Parag Parikh Flexi Cap" />,
                )}
                {field(
                  "symbol",
                  "Short name (optional)",
                  <input {...inputProps("symbol")} type="text" autoComplete="off" maxLength={20} placeholder="PPFAS" className={`${INPUT} uppercase`} />,
                )}
              </div>
            )}

            {mode === "sip" &&
              form.fund_id !== "" &&
              form.fund_id !== NEW_FUND &&
              field(
                "sip_id",
                "SIP",
                sipOptions.length > 0 ? (
                  <Select {...pickerProps("sip_id")} onChange={changeSip} placeholder="Choose a SIP" options={sipOptions} />
                ) : (
                  <p className="text-sm text-zinc-600">
                    This fund has no SIP, so this is recorded as a plain purchase. Add the SIP from the fund&apos;s page.
                  </p>
                ),
              )}

            {field(
              "account_id",
              "Bank account",
              <Select {...pickerProps("account_id")} onChange={(v) => set("account_id", v)} placeholder="Choose a bank account" options={bankOptions} />,
              mode === "sell" && form.fund_id && form.account_id ? (
                <p className="mt-1 text-xs text-zinc-600" aria-live="polite">
                  {held ? `You hold ${formatUnits(held.units)} units here.` : "You hold none of this fund here."}
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

            {mode !== "opening" && (
              <div className="grid grid-cols-2 gap-4">
                {field(
                  "nav",
                  "NAV (₹)",
                  <input {...inputProps("nav")} ref={navRef} type="text" inputMode="decimal" autoComplete="off" placeholder="84.3793" required />,
                )}
                {field(
                  "charges",
                  purchase ? "Stamp duty (₹)" : "Charges (₹, optional)",
                  <input {...inputProps("charges")} type="text" inputMode="decimal" autoComplete="off" />,
                )}
              </div>
            )}

            {field(
              "units",
              "Units",
              <input
                {...inputProps("units")}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                required
                aria-describedby={errors.units ? "fte-units" : mismatch ? "ft-mismatch" : undefined}
              />,
              <>
                {purchase && !unitsByHand && form.units !== "" ? (
                  <p className="mt-1 text-xs text-zinc-600">Worked out from the amount, stamp duty and NAV. Check it against your statement.</p>
                ) : null}
                {mismatch ? (
                  <p id="ft-mismatch" className="mt-1 text-xs font-extrabold text-orange-700" aria-live="polite">
                    {MISMATCH}
                  </p>
                ) : null}
              </>,
            )}

            {field("note", "Note (optional)", <input {...inputProps("note")} type="text" autoComplete="off" maxLength={200} />)}

            <p className="rounded-[14px] border-2 border-ink bg-bg px-3 py-2 text-sm font-bold" aria-live="polite">
              {mode === "opening" ? (
                <>Your bank balance won&apos;t change.</>
              ) : amountShown === null ? (
                <span className="text-zinc-600">
                  {purchase ? "Enter the amount and NAV, and the units are worked out." : "Enter the amount you received."}
                </span>
              ) : (
                <>
                  <span className="font-black tabular-nums">{amountShown}</span>
                  {purchase ? " leaves " : " goes into "}
                  {bank ? bank.name : "your bank account"}.
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
              {saving
                ? "Saving..."
                : editing
                  ? "Save changes"
                  : mode === "sip"
                    ? "Record SIP"
                    : mode === "buy"
                      ? "Buy"
                      : mode === "sell"
                        ? "Redeem"
                        : "Add units"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
