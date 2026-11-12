"use client";

import { useEffect, useRef, useState } from "react";

import type { Account } from "@/lib/accounts";
import { type Coin, blankCryptoTradeForm } from "@/lib/crypto";
import { type Fund, type Sip, blankFundTradeForm } from "@/lib/funds";
import type { Portfolio, Stock } from "@/lib/investments";
import { accountEmoji, investmentEmoji } from "@/lib/fun";
import { todayIndia } from "@/lib/transactions";
import { AccountDialog } from "@/components/accounts/account-dialog";
import { EmojiSquare } from "@/components/ui/chunky";

import { CryptoTradeDialog } from "./crypto-trade-dialog";
import { FundTradeDialog } from "./fund-trade-dialog";
import { SipDialog } from "./sip-dialog";
import { AddFlow, DIALOG, QUIET } from "./shared";
import { TradeDialog } from "./trade-dialog";

export type AddType = "stock" | "mutual_fund" | "crypto" | "ppf" | "rd" | "sip";
// Where the dialog opens: at step 1, or straight at a type's second step (an empty section's button).
export type AddStart = { type: AddType; opening: boolean } | null;

type Choice = { type: Exclude<AddType, "sip">; title: string; text: string; emoji: string; tone: "blue" | "orange" };

const CHOICES: Choice[] = [
  { type: "stock", title: "Stock", text: "Shares held with a broker", emoji: investmentEmoji("stock"), tone: "blue" },
  { type: "mutual_fund", title: "Mutual fund", text: "A lump sum, or units you already hold", emoji: investmentEmoji("mutual_fund"), tone: "blue" },
  { type: "crypto", title: "Crypto", text: "Coins on an exchange", emoji: investmentEmoji("crypto"), tone: "blue" },
  { type: "ppf", title: "PPF", text: "Public Provident Fund account", emoji: accountEmoji("ppf"), tone: "orange" },
  { type: "rd", title: "Recurring deposit", text: "A monthly RD at a bank or post office", emoji: accountEmoji("rd"), tone: "orange" },
];

type Props = {
  start: AddStart;
  portfolio: Portfolio;
  stocks: Stock[] | null; // null when they didn't load, which turns that type off
  funds: Fund[] | null;
  sips: Sip[];
  coins: Coin[] | null;
  accounts: Account[]; // active accounts
  defaultBrokerId: number | null;
  onClose: () => void;
  onSaved: () => void;
  onConflict: (message: string) => void;
  onCreated: () => void; // something new exists (a stock, fund or coin), so the page should reload
};

// The one way to add an investment: step 1 picks the type, step 2 is that type's own form (the trade
// dialog for a first purchase, the account dialog for a PPF or RD, or the SIP dialog). Back returns here.
export function AddInvestmentDialog(props: Props) {
  const [type, setType] = useState<AddType | null>(props.start?.type ?? null);
  // "Already hold it" comes only from an empty section's button. Back to step 1 forgets it, so a type
  // picked there starts as a buy.
  const [opening, setOpening] = useState(props.start?.opening ?? false);
  const brokers = props.accounts.filter((a) => a.type === "broker");
  const banks = props.accounts.filter((a) => a.type === "bank");

  if (type === null) return <TypeStep {...props} onPick={setType} />;

  const flow = {
    onBack: () => {
      setOpening(false);
      setType(null);
    },
  };
  let step: React.ReactNode = null;
  if (type === "stock" && props.stocks) {
    step = (
      <TradeDialog
        trade={null}
        kind={opening ? "opening" : "buy"}
        stocks={props.stocks}
        brokers={brokers}
        holdings={props.portfolio.holdings}
        defaultAccountId={props.defaultBrokerId}
        onClose={props.onClose}
        onSaved={props.onSaved}
        onConflict={props.onConflict}
        onStockCreated={props.onCreated}
      />
    );
  } else if (type === "mutual_fund" && props.funds) {
    step = (
      <FundTradeDialog
        trade={null}
        initial={blankFundTradeForm(opening ? "opening" : "buy", todayIndia())}
        funds={props.funds}
        banks={banks}
        holdings={props.portfolio.funds.holdings}
        sips={props.sips}
        onClose={props.onClose}
        onSaved={props.onSaved}
        onConflict={props.onConflict}
        onFundCreated={props.onCreated}
      />
    );
  } else if (type === "crypto" && props.coins) {
    step = (
      <CryptoTradeDialog
        trade={null}
        initial={blankCryptoTradeForm(opening ? "opening" : "buy", todayIndia())}
        coins={props.coins}
        brokers={brokers}
        holdings={props.portfolio.crypto.holdings}
        onClose={props.onClose}
        onSaved={props.onSaved}
        onConflict={props.onConflict}
        onCoinCreated={props.onCreated}
      />
    );
  } else if (type === "sip" && props.funds) {
    step = (
      <SipDialog
        sip={null}
        funds={props.funds}
        banks={banks}
        onClose={props.onClose}
        onSaved={props.onSaved}
        onConflict={props.onConflict}
        onFundCreated={props.onCreated}
      />
    );
  } else if (type === "ppf" || type === "rd") {
    step = (
      <AccountDialog
        account={null}
        accounts={props.accounts}
        initialType={type}
        onClose={props.onClose}
        onSaved={props.onSaved}
        onConflict={props.onConflict}
      />
    );
  }
  return <AddFlow.Provider value={flow}>{step}</AddFlow.Provider>;
}

function TypeStep({ stocks, funds, coins, onClose, onPick }: Props & { onPick: (type: AddType) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    first.current?.focus();
  }, []);

  const loaded: Record<Choice["type"], boolean> = {
    stock: stocks !== null,
    mutual_fund: funds !== null,
    crypto: coins !== null,
    ppf: true,
    rd: true,
  };

  return (
    <dialog ref={ref} aria-labelledby="add-investment-title" onClose={onClose} className={`${DIALOG} w-[min(40rem,calc(100vw-2rem))]`}>
      <div className="flex max-h-[90vh] flex-col">
        <h2 id="add-investment-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          Add investment
          <span className="block text-xs font-extrabold tracking-wide text-zinc-700 uppercase">Step 1 of 2 · What are you adding?</span>
        </h2>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CHOICES.map((choice, index) => (
              <li key={choice.type}>
                <button
                  ref={index === 0 ? first : undefined}
                  type="button"
                  disabled={!loaded[choice.type]}
                  onClick={() => onPick(choice.type)}
                  className="flex h-full w-full items-center gap-3 rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-3 text-left shadow-chunky-sm transition hover:-translate-y-0.5 hover:bg-due/40 focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                >
                  <EmojiSquare emoji={choice.emoji} tone={choice.tone} />
                  <span className="min-w-0">
                    <span className="block font-black">{choice.title}</span>
                    <span className="block text-xs font-bold text-zinc-600">
                      {loaded[choice.type] ? choice.text : "Couldn't load these. Close and try again."}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-sm font-bold text-zinc-600">
            Starting a SIP before the first instalment?{" "}
            <button
              type="button"
              disabled={funds === null}
              onClick={() => onPick("sip")}
              className="rounded font-extrabold text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50"
            >
              Start a SIP
            </button>
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
          <button type="button" onClick={() => ref.current?.close()} className={QUIET}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
