import { type Account, type AccountType, type PpfFigures, TYPE_LABELS, TYPE_ORDER, cleanMoney, formatDueDate, formatRupees } from "./accounts.ts";
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
  return `${account.name}: record interest for ${year}, about ${formatRupees(amount)}.`;
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

export type CloseRdForm = { amount: string; date: string; account_id: string };

export function closeRdForm(account: Account, today: string): CloseRdForm {
  return {
    amount: account.deposit?.kind === "rd" ? account.deposit.maturity_value : "",
    date: today,
    account_id: idText(account.pay_from_id),
  };
}

export function closeRdPayload(form: CloseRdForm): Record<string, unknown> {
  return {
    amount: cleanMoney(form.amount),
    date: form.date,
    account_id: form.account_id === "" ? null : Number(form.account_id),
  };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2036-04-01" -> "1 Apr 2036", split from the text so no timezone can shift the day.
export function formatLongDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

// The figure lines under a PPF or RD row, all from the server's numbers. Empty for other types.
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
  return [];
}

// Accounts a form can offer as "paid from": a PPF or RD comes from an active bank; a loan from any
// account but a loan or a deposit. Never the account being edited.
export function payFromAccounts(accounts: Account[], type: AccountType, editingId?: number): Account[] {
  if (type === "ppf" || type === "rd") return accounts.filter((a) => a.type === "bank");
  return accounts.filter((a) => a.type !== "loan" && a.type !== "ppf" && a.type !== "rd" && a.id !== editingId);
}

export type AccountSection = { key: string; title: string; data: Account[] };

// The Accounts tab's groups in TYPE_ORDER; PPF and RD share one "Deposits" group.
export function accountSections(accounts: Account[]): AccountSection[] {
  const sections: AccountSection[] = [];
  for (const type of TYPE_ORDER) {
    const data = accounts.filter((a) => a.type === type);
    if (data.length === 0) continue;
    const deposit = type === "ppf" || type === "rd";
    const last = sections[sections.length - 1];
    if (deposit && last?.key === "deposits") last.data.push(...data);
    else sections.push({ key: deposit ? "deposits" : type, title: deposit ? "Deposits" : TYPE_LABELS[type], data });
  }
  return sections;
}
