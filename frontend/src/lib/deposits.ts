import {
  type Account,
  type AccountType,
  type FdPayout,
  type PpfFigures,
  FD_PAYOUT_LABELS,
  cleanMoney,
  formatFullDate,
  formatDueDate,
  formatRupees,
} from "./accounts.ts";
import { type TransactionForm, blankForm } from "./transactions.ts";

const idText = (id: number | null) => (id === null ? "" : String(id));
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

// "HDFC FD matured on 15 Nov 2026. Close or renew it." for a matured FD still open, else null.
export function fdMaturedText(account: Account): string | null {
  const deposit = account.deposit;
  if (account.type !== "fd" || deposit?.kind !== "fd" || !deposit.matured || account.archived) return null;
  return `${account.name} matured on ${formatFullDate(deposit.maturity_date)}. Close or renew it.`;
}

// The short name of a deposit type, for lists that mix them: "PPF", "RD" or "FD".
export function depositShortLabel(type: "ppf" | "rd" | "fd"): string {
  return type.toUpperCase();
}

export function ppfRoomText(figures: PpfFigures): string {
  return `${whole(figures.deposited_this_year)} of ${whole(figures.year_limit)} this year`;
}

// The RD's next instalment: a transfer from its usual account, dated at the oldest one due.
export function instalmentForm(account: Account, today: string): TransactionForm {
  const due = account.deposit?.kind === "rd" ? account.deposit.due[0] : undefined;
  return {
    ...blankForm("transfer", due ?? today, account.pay_from_id),
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

// Closing an RD or FD: the amount received (the server's maturity estimate to start with), the
// date and the bank it lands in.
export type CloseDepositForm = { amount: string; date: string; account_id: string };

export function closeDepositForm(account: Account, today: string): CloseDepositForm {
  const deposit = account.deposit;
  return {
    amount: deposit?.kind === "rd" || deposit?.kind === "fd" ? deposit.maturity_value : "",
    date: today,
    account_id: idText(account.pay_from_id),
  };
}

export function closeDepositPayload(form: CloseDepositForm): Record<string, unknown> {
  return {
    amount: cleanMoney(form.amount),
    date: form.date,
    account_id: form.account_id === "" ? null : Number(form.account_id),
  };
}

// Renewing an FD: closing it at the amount received, then putting some or all of it in a new FD.
export type RenewFdForm = CloseDepositForm & {
  reinvest: string; // blank means all of the amount received
  name: string; // blank keeps the old name
  interest_rate: string;
  matures_on: string;
  fd_payout: string;
};

export function renewFdForm(account: Account, today: string): RenewFdForm {
  const close = closeDepositForm(account, today);
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
  const money = (raw: string) => {
    const cleaned = cleanMoney(raw);
    return cleaned === "" ? null : cleaned;
  };
  return {
    ...closeDepositPayload(form),
    reinvest: money(form.reinvest),
    name: form.name.trim() === "" ? null : form.name.trim(),
    interest_rate: money(form.interest_rate),
    matures_on: form.matures_on === "" ? null : form.matures_on,
    fd_payout: form.fd_payout === "" ? null : form.fd_payout,
  };
}

const DEPOSIT_TYPES = new Set<AccountType>(["ppf", "rd", "fd"]);

// Accounts a form can offer as "paid from": a PPF, RD or FD comes from an active bank; a loan from
// any account but a loan or a deposit. Never the account being edited.
export function payFromAccounts(accounts: Account[], type: AccountType, editingId?: number): Account[] {
  if (DEPOSIT_TYPES.has(type)) return accounts.filter((a) => a.type === "bank");
  return accounts.filter((a) => a.type !== "loan" && !DEPOSIT_TYPES.has(a.type) && a.id !== editingId);
}

const PAYOUT_EVERY: Record<Exclude<FdPayout, "cumulative">, string> = { monthly: "month", quarterly: "quarter" };

// The figure lines under a PPF, RD or FD row, all from the server's numbers. Empty for other types.
export function depositLines(account: Account): string[] {
  const deposit = account.deposit;
  if (deposit?.kind === "ppf") {
    return [
      `Interest this year ≈ ${formatRupees(deposit.interest_this_year)} (estimate)`,
      ppfRoomText(deposit),
      `Matures ${formatFullDate(deposit.maturity_date)}`,
    ];
  }
  if (deposit?.kind === "rd") {
    return [
      `Paid ${deposit.deposits_paid} of ${account.tenure_months}`,
      `Value today ≈ ${formatRupees(deposit.value_today)} (estimate)`,
      `${formatRupees(deposit.maturity_value)} on ${formatFullDate(deposit.maturity_date)}`,
    ];
  }
  if (deposit?.kind === "fd") {
    const rate = account.interest_rate !== null ? [`${account.interest_rate}% a year`] : [];
    const matures = `${deposit.matured ? "Matured" : "Matures"} ${formatFullDate(deposit.maturity_date)}`;
    if (deposit.payout === "cumulative") {
      return [
        ...rate,
        FD_PAYOUT_LABELS.cumulative,
        `Value today ≈ ${formatRupees(deposit.value_today)} (estimate)`,
        `${formatRupees(deposit.maturity_value)} on ${formatFullDate(deposit.maturity_date)}`,
      ];
    }
    return [
      ...rate,
      FD_PAYOUT_LABELS[deposit.payout],
      ...(deposit.payout_amount !== null
        ? [`${formatRupees(deposit.payout_amount)} interest every ${PAYOUT_EVERY[deposit.payout]}`]
        : []),
      matures,
    ];
  }
  return [];
}
