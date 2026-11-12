"use client";

import { type ReactNode, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, cleanMoney, errorMessage, formatRupees, maskLast4, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type Action,
  type Candidate,
  type ReviewItem,
  accountChoices,
  actionsFor,
  categoryType,
  expectedBody,
  marketPrefill,
  needsNav,
  reviewTitle,
} from "@/lib/review";
import { type CategoryList, formatDate } from "@/lib/transactions";
import { INPUT } from "@/components/investments/shared";
import { EmojiSquare, FOCUS, Segmented, type Tone, buttonClass } from "@/components/ui/chunky";
import { ComboBox, Select } from "@/components/ui/select";

const LABEL = "mb-1 block text-xs font-black tracking-wide uppercase";
const ERROR = "mt-1 text-xs font-extrabold text-loss";
const GROUP = "flex flex-col gap-2.5 border-t-[1.5px] border-dashed border-zinc-300 pt-3";
const SMALL_GREEN = `${buttonClass("green")} !px-3 !py-1.5 uppercase`;
const SMALL_ALT = `${buttonClass("alt")} !px-3 !py-1.5 uppercase`;
const CHOICE = `${buttonClass("alt")} !px-3 !py-1.5 text-left !normal-case hover:bg-yellow`;

// Every field a 422 can name that the card has a control for; anything else shows under the card.
const FIELDS = ["category", "account_id", "units", "nav", "stock_id", "symbol", "name", "price", "charges", "side"] as const;
type Field = (typeof FIELDS)[number];

const EMOJI: Record<string, { emoji: string; tone: Tone }> = {
  category: { emoji: "🏷️", tone: "yellow" },
  account: { emoji: "👛", tone: "blue" },
  maybe_duplicate: { emoji: "👯", tone: "purple" },
  maybe_transfer: { emoji: "🔁", tone: "blue" },
  expected: { emoji: "🔔", tone: "orange" },
  sip_units: { emoji: "🥧", tone: "green" },
  demat: { emoji: "📈", tone: "green" },
  card_payment: { emoji: "💳", tone: "pink" },
  balance: { emoji: "⚠️", tone: "pink" },
};

const ofKind = (item: ReviewItem, kind: string) => (item.candidates ?? []).filter((c) => c.kind === kind);

type Props = {
  item: ReviewItem;
  accounts: Account[]; // active
  categories: CategoryList;
  // The answer applied. `next` is the item when it still waits (a SIP whose units to check), else null.
  onAnswered: (item: ReviewItem, next: ReviewItem | null) => void;
  // The item was answered elsewhere or is gone (409/404).
  onStale: (message: string) => void;
};

// One message to answer, with its own controls. Each button posts one answer.
export function ReviewCard({ item, accounts, categories, onAnswered, onStale }: Props) {
  const actions = actionsFor(item);
  const has = (action: Action) => actions.includes(action);
  const prefix = `r${item.id}`;
  const stocks = ofKind(item, "stock");
  const markets = ofKind(item, "market");
  const brokers = accounts.filter((a) => a.type === "broker");
  const firstChoice = stocks[0] ? `stock:${stocks[0].id}` : markets[0] ? `market:${markets[0].id}` : "new";
  const firstMarket = markets[0] ? marketPrefill(markets[0].label) : { symbol: "", name: "" };

  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [remember, setRemember] = useState(true);
  const [accountId, setAccountId] = useState("");
  const [units, setUnits] = useState("");
  const [nav, setNav] = useState("");
  const [stock, setStock] = useState(firstChoice);
  const [symbol, setSymbol] = useState(stocks.length === 0 ? firstMarket.symbol : "");
  const [name, setName] = useState(stocks.length === 0 ? firstMarket.name : "");
  const [brokerId, setBrokerId] = useState(brokers.length === 1 ? String(brokers[0].id) : "");
  const [price, setPrice] = useState(item.suggested_price ?? "");
  const [charges, setCharges] = useState("");
  const [side, setSide] = useState<"" | "buy" | "sell">("");
  const [needsSide, setNeedsSide] = useState(false);

  async function answer(key: string, body: Record<string, unknown>) {
    if (busyRef.current) return;
    // The server wants a whole id here; say so plainly rather than show its type error.
    if ("account_id" in body && body.account_id === null) {
      setErrors({ account_id: key === "trade" ? "Choose a broker." : "Choose an account." });
      setFormError(null);
      return;
    }
    busyRef.current = true;
    setBusy(key);
    setErrors({});
    setFormError(null);
    try {
      const next = await apiFetch<ReviewItem | null>(`/sms/review/${item.id}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (next && next.reason === "balance" && item.reason === "balance") {
        setFormError(next.message ?? "It still couldn't be recorded.");
      }
      onAnswered(item, next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logout();
      else if (err instanceof ApiError && err.status === 422) {
        const { fields, general } = splitErrors(err.body, FIELDS);
        if ("side" in fields) setNeedsSide(true);
        setErrors(fields);
        if (general.length > 0) setFormError(general.join(" "));
      } else if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        onStale(errorMessage(err));
      } else setFormError(errorMessage(err));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  const disabled = busy !== null;
  const errorText = (field: Field) =>
    errors[field] ? (
      <p id={`${prefix}-e-${field}`} className={ERROR}>
        {errors[field]}
      </p>
    ) : null;
  const fieldProps = (field: Field) => ({
    id: `${prefix}-${field}`,
    disabled,
    invalid: Boolean(errors[field]),
    describedBy: errors[field] ? `${prefix}-e-${field}` : undefined,
  });
  const inputProps = (field: Field, value: string, set: (v: string) => void) => ({
    id: `${prefix}-${field}`,
    value,
    disabled,
    className: INPUT,
    autoComplete: "off",
    inputMode: "decimal" as const,
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? `${prefix}-e-${field}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value),
  });
  const labelled = (field: Field, label: string, control: ReactNode) => (
    <div className="min-w-0 flex-1">
      <label htmlFor={`${prefix}-${field}`} className={LABEL}>
        {label}
      </label>
      {control}
      {errorText(field)}
    </div>
  );
  const button = (key: string, text: string, busyText: string, onClick: () => void, cls = SMALL_GREEN, label?: string) => (
    <button type="button" className={cls} disabled={disabled} aria-label={label} onClick={onClick}>
      {busy === key ? busyText : text}
    </button>
  );

  const type = categoryType(item);
  const categoryOptions = categories[type].map((c) => ({ value: c, label: c }));
  const categoryText = (c: string) => c.trim() || null;

  // The category picker with "Always use this", shared by the category, not-a-transfer and
  // none-of-these answers.
  const categoryPicker = (optional: boolean) => (
    <>
      {labelled(
        "category",
        optional ? "Category (optional)" : "Category",
        <ComboBox {...fieldProps("category")} value={category} onChange={setCategory} options={categoryOptions} maxLength={40} />,
      )}
      {item.payee !== null && (
        <label className="flex items-center gap-2 text-sm font-extrabold">
          <input
            type="checkbox"
            checked={remember}
            disabled={disabled}
            onChange={(e) => setRemember(e.target.checked)}
            className={`size-4 accent-ink ${FOCUS}`}
          />
          Always use this for {item.payee}
        </label>
      )}
    </>
  );
  const categoryBody = () => ({ action: "category", category: categoryText(category), remember: item.payee !== null && remember });

  const transactions = ofKind(item, "transaction");
  const expected = (item.candidates ?? []).filter((c) => c.kind === "emi" || c.kind === "sip" || c.kind === "template");
  const choiceButtons = (list: Candidate[], prefixText: string, body: (c: Candidate) => Record<string, unknown>) => (
    <div className="flex flex-wrap gap-2">
      {list.map((c) => {
        const key = `${c.kind}-${c.id}`;
        return (
          <button
            key={key}
            type="button"
            className={CHOICE}
            disabled={disabled}
            onClick={() => answer(key, body(c))}
          >
            {busy === key ? "Saving..." : `${prefixText}${c.label}`}
          </button>
        );
      })}
    </div>
  );

  const stockOptions = [
    ...stocks.map((c) => ({ value: `stock:${c.id}`, label: c.label })),
    ...markets.map((c) => ({ value: `market:${c.id}`, label: `New: ${c.label}` })),
    { value: "new", label: "Another new stock" },
  ];
  function chooseStock(value: string) {
    setStock(value);
    const market = markets.find((c) => `market:${c.id}` === value);
    if (market) {
      const prefill = marketPrefill(market.label);
      setSymbol(prefill.symbol);
      setName(prefill.name);
    } else if (value === "new") {
      setSymbol("");
      setName("");
    }
  }
  const newStock = !stock.startsWith("stock:");
  function tradeBody() {
    return {
      action: "trade",
      stock_id: newStock ? null : Number(stock.slice(6)),
      account_id: brokerId === "" ? null : Number(brokerId),
      price: cleanMoney(price) || null,
      charges: cleanMoney(charges) || "0",
      symbol: newStock ? symbol.trim() || null : null,
      name: newStock ? name.trim() || null : null,
      side: side || null,
    };
  }

  const { emoji, tone } = EMOJI[item.reason ?? ""] ?? { emoji: "📩", tone: "card" as Tone };
  const accountLine = [item.account_name, item.last4 ? maskLast4(item.last4) : null].filter(Boolean).join(" · ");
  const headingId = `${prefix}-title`;

  return (
    <article
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col overflow-hidden rounded-[18px] border-[2.5px] border-ink bg-card shadow-chunky"
    >
      <header className="flex items-center gap-1 border-b-[2.5px] border-ink bg-due px-3.5 py-2.5">
        <EmojiSquare emoji={emoji} tone={tone} />
        <h2 id={headingId} className="min-w-0 flex-1 text-base font-black [overflow-wrap:anywhere]">
          {reviewTitle(item)}
        </h2>
        <span className="shrink-0 text-xs font-bold text-zinc-600">{formatDate(item.date)}</span>
      </header>

      <div className="flex flex-col gap-3 p-3.5">
        <div>
          <p className="flex flex-wrap items-baseline gap-x-3">
            {item.amount !== null && (
              <span className="text-xl font-black tabular-nums">{formatRupees(item.amount)}</span>
            )}
            {item.quantity !== null && (
              <span className="text-xl font-black tabular-nums">{item.quantity} shares</span>
            )}
            {item.payee && <span className="text-sm font-extrabold [overflow-wrap:anywhere]">{item.payee}</span>}
          </p>
          {accountLine && <p className="text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">{accountLine}</p>}
          {item.message && <p className="mt-1 text-sm font-bold [overflow-wrap:anywhere]">{item.message}</p>}
        </div>

        {has("same") && (
          <div className={GROUP}>
            <p className="text-xs font-black tracking-wide uppercase">
              {item.reason === "expected" ? "Already recorded as" : "Same as one of these?"}
            </p>
            {choiceButtons(transactions, "Same as ", (c) => ({ action: "same", transaction_id: c.id }))}
          </div>
        )}
        {has("new") && (
          <div className="flex flex-wrap gap-2">{button("new", "No, it's new", "Saving...", () => answer("new", { action: "new" }), SMALL_ALT)}</div>
        )}

        {has("transfer") && (
          <div className={GROUP}>
            <p className="text-xs font-black tracking-wide uppercase">
              {item.reason === "card_payment" ? "Paid by this debit?" : "A transfer with"}
            </p>
            {choiceButtons(transactions, item.reason === "card_payment" ? "Paid by " : "", (c) => ({
              action: "transfer",
              transaction_id: c.id,
            }))}
          </div>
        )}

        {has("expected") && (
          <div className={GROUP}>
            <p className="text-xs font-black tracking-wide uppercase">Is it one of these?</p>
            {needsNav(item) && (
              <div className="flex flex-col gap-1">
                {labelled("nav", "SIP NAV on the day", <input {...inputProps("nav", nav, setNav)} type="text" />)}
                <p className="text-xs font-bold text-zinc-600">No NAV is known for that day. Copy it from your fund statement.</p>
              </div>
            )}
            {choiceButtons(expected, "", (c) => expectedBody(item, c, remember, nav))}
            {item.payee !== null && expected.some((c) => c.kind === "template") && (
              <label className="flex items-center gap-2 text-sm font-extrabold">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={disabled}
                  onChange={(e) => setRemember(e.target.checked)}
                  className={`size-4 accent-ink ${FOCUS}`}
                />
                Always match {item.payee} to that reminder
              </label>
            )}
          </div>
        )}

        {has("category") && (
          <div className={item.reason === "category" ? "flex flex-col gap-2.5" : GROUP}>
            {item.reason === "maybe_transfer" && (
              <p className="text-xs font-black tracking-wide uppercase">Not a transfer</p>
            )}
            {item.reason === "expected" && <p className="text-xs font-black tracking-wide uppercase">None of these</p>}
            {categoryPicker(item.reason === "maybe_transfer")}
            <div className="flex flex-wrap gap-2">
              {button(
                "category",
                item.reason === "maybe_transfer" ? "Not a transfer" : item.reason === "expected" ? "Save as spending" : "Save",
                "Saving...",
                () => answer("category", categoryBody()),
                item.reason === "category" ? SMALL_GREEN : SMALL_ALT,
              )}
            </div>
          </div>
        )}

        {has("account") && (
          <div className={item.reason === "account" ? "flex flex-col gap-2.5" : GROUP}>
            {labelled(
              "account_id",
              item.reason === "card_payment" ? "Paid from" : "Account",
              <Select
                {...fieldProps("account_id")}
                value={accountId}
                onChange={setAccountId}
                placeholder="Choose an account"
                options={
                  item.reason === "card_payment"
                    ? ofKind(item, "account").map((c) => ({ value: String(c.id), label: c.label }))
                    : accountChoices(item, accounts).map((a) => ({ value: String(a.id), label: a.name }))
                }
              />,
            )}
            {item.reason === "account" && item.last4 !== null && (
              <label className="flex items-center gap-2 text-sm font-extrabold">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={disabled}
                  onChange={(e) => setRemember(e.target.checked)}
                  className={`size-4 accent-ink ${FOCUS}`}
                />
                Remember {maskLast4(item.last4)} is this account
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              {button("account", item.reason === "card_payment" ? "Paid from this account" : "Save", "Saving...", () =>
                answer("account", {
                  action: "account",
                  account_id: accountId === "" ? null : Number(accountId),
                  remember: item.reason === "account" && item.last4 !== null && remember,
                }),
              )}
            </div>
          </div>
        )}

        {has("units") && (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap gap-2.5">
              {labelled("units", "Units", <input {...inputProps("units", units, setUnits)} type="text" />)}
              {labelled("nav", "NAV", <input {...inputProps("nav", nav, setNav)} type="text" />)}
            </div>
            <div className="flex flex-wrap gap-2">
              {button("units", "Save units", "Saving...", () =>
                answer("units", { action: "units", units: units.trim() || null, nav: nav.trim() || null }),
              )}
              {button("units_ok", "The estimate is right", "Saving...", () => answer("units_ok", { action: "units_ok" }), SMALL_ALT)}
            </div>
          </div>
        )}

        {has("trade") && (
          <div className="flex flex-col gap-2.5">
            {labelled(
              "stock_id",
              "Stock",
              <Select {...fieldProps("stock_id")} value={stock} onChange={chooseStock} options={stockOptions} />,
            )}
            {newStock && (
              <div className="flex flex-wrap gap-2.5">
                {labelled(
                  "symbol",
                  "Symbol",
                  <input {...inputProps("symbol", symbol, setSymbol)} type="text" inputMode="text" maxLength={20} />,
                )}
                {labelled("name", "Name", <input {...inputProps("name", name, setName)} type="text" inputMode="text" maxLength={100} />)}
              </div>
            )}
            {labelled(
              "account_id",
              "Broker",
              <Select
                {...fieldProps("account_id")}
                value={brokerId}
                onChange={setBrokerId}
                placeholder={brokers.length === 0 ? "Add a broker account first" : "Choose a broker"}
                options={brokers.map((a) => ({ value: String(a.id), label: a.name }))}
              />,
            )}
            <div className="flex flex-wrap gap-2.5">
              {labelled("price", "Price per share", <input {...inputProps("price", price, setPrice)} type="text" />)}
              {labelled("charges", "Charges (optional)", <input {...inputProps("charges", charges, setCharges)} type="text" />)}
            </div>
            {needsSide && (
              <div>
                <span className={LABEL}>
                  Bought or sold?
                </span>
                <Segmented
                  label="Bought or sold?"
                  value={side}
                  onChange={(v) => setSide(v)}
                  options={[
                    { value: "buy", label: "Bought" },
                    { value: "sell", label: "Sold" },
                  ]}
                />
                {errorText("side")}
              </div>
            )}
            <div className="flex flex-wrap gap-2">{button("trade", "Save trade", "Saving...", () => answer("trade", tradeBody()))}</div>
          </div>
        )}

        {has("retry") && (
          <div className="flex flex-wrap gap-2">{button("retry", "Try again", "Trying...", () => answer("retry", { action: "retry" }))}</div>
        )}

        {formError && (
          <p role="alert" className="text-sm font-extrabold text-loss">
            {formError}
          </p>
        )}
      </div>

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t-[1.5px] border-zinc-200 bg-bg px-3.5 py-2">
        <span className="text-xs font-bold text-zinc-600">
          {item.transaction_id !== null || item.trade_id !== null ? "Already in your records." : "Not recorded yet."}
        </span>
        {button(
          "dismiss",
          "Dismiss",
          "Dismissing...",
          () => answer("dismiss", { action: "dismiss" }),
          `${buttonClass("alt")} !px-2.5 !py-1 uppercase`,
          `Dismiss ${reviewTitle(item)}`,
        )}
      </footer>
    </article>
  );
}
