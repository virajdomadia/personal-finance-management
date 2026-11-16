import {
  type Account,
  type AccountType,
  DEPOSIT_TYPES,
  FD_PAYOUT_LABELS,
  type FdPayout,
  type PpfFigures,
  TYPE_LABELS,
  TYPE_ORDER,
  cleanMoney,
  formatDueDate,
  formatRupees,
} from "./accounts.ts";
import { type TransactionForm, blankForm } from "./transactions.ts";

const idText = (id: number | null) => (id === null ? "" : String(id));
const isOffered = (id: number | null, accounts?: Account[]) =>
  id !== null && (accounts === undefined || accounts.some((a) => a.id === id && a.type === "bank" && !a.archived));
const whole = (money: string) => formatRupees(money.replace(/\.00$/, ""));

// "SBI RD: ₹5,000 instalment due since 15 Nov. Record it." or null when nothing is due.
export function rdDueText(account: Account): string | null {
  const deposit = account.deposit;
  if (account.type !== "rd" || deposit?.kind !== "rd" || account.deposit_amount === null) return null;
  const first = deposit.due[0];
  if (!first) return null;
  const months = deposit.due.length > 1 ? ` (${deposit.due.length} months)` : "";
  return `${account.name}: ${whole(account.deposit_amount)} instalment due since ${formatDueDate(first)}${months}. Record it.`;
}

export function ppfInterestText(account: Account): string | null {
  const deposit = account.deposit;
  if (account.type !== "ppf" || deposit?.kind !== "ppf" || deposit.interest_due === null) return null;
  const { year, amount } = deposit.interest_due;
  return `${account.name}: record interest for ${year}, about ${whole(amount)}.`;
}

export function ppfRoomText(figures: PpfFigures): string {
  return `${whole(figures.deposited_this_year)} of ${whole(figures.year_limit)} this year`;
}

// The RD's next instalment: a transfer from its usual account, dated at the oldest one due.
// `accounts`, when given, is what can be picked: a usual bank that isn't an active bank there
// (archived, say) starts empty instead of showing a choice that would be refused.
export function instalmentForm(account: Account, today: string, accounts?: Account[]): TransactionForm {
  const due = account.deposit?.kind === "rd" ? account.deposit.due[0] : undefined;
  const usual = isOffered(account.pay_from_id, accounts) ? account.pay_from_id : null;
  return {
    ...blankForm("transfer", due ?? today, usual),
    to_account_id: String(account.id),
    amount: account.deposit_amount ?? "",
  };
}

export function ppfDepositForm(account: Account, today: string): TransactionForm {
  return { ...blankForm("transfer", today, account.pay_from_id), to_account_id: String(account.id) };
}

// Interest credited to the deposit, as the server suggested it.
export function interestForm(account: Account): TransactionForm {
  const due = account.deposit?.kind === "ppf" ? account.deposit.interest_due : null;
  return {
    ...blankForm("income", due?.date ?? "", account.id),
    category: "Interest",
    amount: due?.amount ?? "",
  };
}

// "SBI FD matured on 1 Nov 2026. Close or renew it." for an FD still open on or after its maturity
// date (the server says when), or null.
export function fdMaturedText(account: Account): string | null {
  const deposit = account.deposit;
  if (account.type !== "fd" || deposit?.kind !== "fd" || !deposit.matured || account.archived) return null;
  return `${account.name} matured on ${formatLongDate(deposit.maturity_date)}. Close or renew it.`;
}

// Closing an RD or an FD takes the same three fields.
export type CloseDepositForm = { amount: string; date: string; account_id: string };

const maturityValue = (account: Account) =>
  account.deposit?.kind === "rd" || account.deposit?.kind === "fd" ? account.deposit.maturity_value : "";

// The deposit's usual bank is pre-selected only while it is still an active bank; otherwise the user must choose.
export function closeDepositForm(account: Account, today: string, banks?: Account[]): CloseDepositForm {
  return {
    amount: maturityValue(account),
    date: today,
    account_id: isOffered(account.pay_from_id, banks) ? idText(account.pay_from_id) : "",
  };
}

export function closeDepositPayload(form: CloseDepositForm): Record<string, unknown> {
  return {
    amount: cleanMoney(form.amount),
    date: form.date,
    account_id: form.account_id === "" ? null : Number(form.account_id),
  };
}

// Renewing an FD: what the bank paid at maturity and where, then how much of it goes into the new FD
// and on what terms. Anything not renewed stays in the bank.
export type RenewFdForm = CloseDepositForm & {
  reinvest: string;
  name: string;
  interest_rate: string;
  matures_on: string;
  fd_payout: "" | FdPayout;
};

// Starts from the old FD: its maturity value, its bank, its rate and payout, renewing all of the
// amount received. A blank name keeps the old name; a blank amount to renew renews all of it.
export function renewFdForm(account: Account, today: string, banks?: Account[]): RenewFdForm {
  const close = closeDepositForm(account, today, banks);
  return {
    ...close,
    reinvest: close.amount,
    name: "",
    interest_rate: account.interest_rate ?? "",
    matures_on: "",
    fd_payout: account.fd_payout ?? "",
  };
}

export function renewFdPayload(form: RenewFdForm): Record<string, unknown> {
  const reinvest = cleanMoney(form.reinvest);
  const rate = cleanMoney(form.interest_rate);
  const name = form.name.trim();
  return {
    ...closeDepositPayload(form),
    ...(reinvest === "" ? {} : { reinvest }),
    ...(name === "" ? {} : { name }),
    interest_rate: rate === "" ? null : rate,
    matures_on: form.matures_on === "" ? null : form.matures_on,
    fd_payout: form.fd_payout === "" ? null : form.fd_payout,
  };
}

// "₹1,500 interest every month", from the server's payout figure; null for a cumulative FD.
export function fdPayoutText(account: Account): string | null {
  const deposit = account.deposit;
  if (deposit?.kind !== "fd" || deposit.payout === "cumulative" || deposit.payout_amount === null) return null;
  return `${formatRupees(deposit.payout_amount)} interest every ${deposit.payout === "monthly" ? "month" : "quarter"}`;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2036-04-01" -> "1 Apr 2036", split from the text so no timezone can shift the day.
export function formatLongDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

// The figure lines under a PPF, RD or FD row, all from the server's numbers. Empty for other types.
export function depositLines(account: Account): string[] {
  const deposit = account.deposit;
  if (deposit?.kind === "ppf") {
    return [
      `Interest this year ≈ ${formatRupees(deposit.interest_this_year)} (estimate)`,
      ppfRoomText(deposit),
      `Matures ${formatLongDate(deposit.maturity_date)}`,
    ];
  }
  if (deposit?.kind === "rd") {
    return [
      `Paid ${deposit.deposits_paid} of ${account.tenure_months}`,
      `Value today ≈ ${formatRupees(deposit.value_today)} (estimate)`,
      `${formatRupees(deposit.maturity_value)} on ${formatLongDate(deposit.maturity_date)}`,
    ];
  }
  if (deposit?.kind === "fd") {
    const terms = [
      account.interest_rate !== null ? `${account.interest_rate}% a year` : null,
      FD_PAYOUT_LABELS[deposit.payout],
    ].filter(Boolean);
    const maturity = `${deposit.matured ? "Matured" : "Matures"} ${formatLongDate(deposit.maturity_date)}`;
    if (deposit.payout === "cumulative") {
      return [
        terms.join(" · "),
        `Value today ≈ ${formatRupees(deposit.value_today)} (estimate)`,
        `${formatRupees(deposit.maturity_value)} on ${formatLongDate(deposit.maturity_date)}`,
      ];
    }
    const payout = fdPayoutText(account);
    return [terms.join(" · "), ...(payout ? [payout] : []), maturity];
  }
  return [];
}

// Accounts a form can offer as "paid from": a PPF, RD or FD comes from an active bank; a loan from any
// account but a loan or a deposit. Never the account being edited.
export function payFromAccounts(accounts: Account[], type: AccountType, editingId?: number): Account[] {
  if (DEPOSIT_TYPES.has(type)) return accounts.filter((a) => a.type === "bank");
  return accounts.filter((a) => a.type !== "loan" && !DEPOSIT_TYPES.has(a.type) && a.id !== editingId);
}

export type AccountSection = { key: string; title: string; data: Account[] };

// The Accounts tab's groups in TYPE_ORDER; PPF, RD and FD share one "Deposits" group.
export function accountSections(accounts: Account[]): AccountSection[] {
  const sections: AccountSection[] = [];
  for (const type of TYPE_ORDER) {
    const data = accounts.filter((a) => a.type === type);
    if (data.length === 0) continue;
    const deposit = DEPOSIT_TYPES.has(type);
    const last = sections[sections.length - 1];
    if (deposit && last?.key === "deposits") last.data.push(...data);
    else sections.push({ key: deposit ? "deposits" : type, title: deposit ? "Deposits" : TYPE_LABELS[type], data });
  }
  return sections;
}
