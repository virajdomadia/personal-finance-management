import { cleanMoney, formatDueDate, formatFullDate, formatRupees } from "./accounts.ts";
import { type Template, whole } from "./recurring.ts";

// Mirrors PolicyResponse in backend/app/api/routes/policies.py.
export type FundedBy = {
  account_id: number;
  name: string;
  maturity_date: string | null;
  maturity_estimate: string | null;
  covers: boolean | null;
  shortfall: string | null;
};
export type CardBill = { due: string; before_funding: boolean };
export type PolicyPeriod = {
  period_start: string;
  period_end: string;
  premium: string;
  sum_insured: string;
  paid_on: string;
  transaction_id: number | null;
};
export type FyPremium = { fy: string; amount: string };

export type Policy = {
  id: number;
  kind: string;
  insurer: string;
  plan: string;
  policy_number: string;
  insured: string;
  sum_insured: string;
  period_start: string;
  period_end: string;
  premium: string;
  details: string | null;
  active: boolean;
  template: Template;
  paying_account_id: number;
  paying_account_name: string;
  funded_by: FundedBy | null;
  card_bill: CardBill | null;
  periods: PolicyPeriod[];
  premium_by_fy: FyPremium[];
  days_to_renewal: number | null; // null once lapsed
};

export type RenewForm = {
  date: string;
  amount: string;
  account_id: string;
  period_start: string;
  period_end: string;
  sum_insured: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

// The same day next year, clamped (29 Feb becomes 28 Feb).
export function addYear(date: string): string {
  const [y, m, d] = parts(date);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${pad(m)}-${pad(Math.min(d, last))}`;
}

// The next year's period, paid today from the paying account, at the sum insured it has now.
export function renewFormFrom(policy: Policy, today: string): RenewForm {
  return {
    date: today,
    amount: policy.premium,
    account_id: String(policy.paying_account_id),
    period_start: addDays(policy.period_end, 1),
    period_end: addYear(policy.period_end),
    sum_insured: policy.sum_insured,
  };
}

const textOrNull = (raw: string) => raw.trim() || null;

export function renewPayload(form: RenewForm): Record<string, unknown> {
  return {
    date: textOrNull(form.date),
    amount: textOrNull(cleanMoney(form.amount)),
    account_id: form.account_id === "" ? null : Number(form.account_id),
    period_start: textOrNull(form.period_start),
    period_end: textOrNull(form.period_end),
    sum_insured: textOrNull(cleanMoney(form.sum_insured)),
  };
}

// Money text rounded half up to whole rupees, from the digits so no float is involved.
export function roundRupees(money: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(money.trim());
  if (!match) return money;
  const [, sign, whole, fraction = ""] = match;
  const up = fraction.length > 0 && fraction[0] >= "5";
  return formatRupees(`${sign}${up ? (BigInt(whole) + BigInt(1)).toString() : BigInt(whole).toString()}`);
}

// "Funded by Bank of India RD: matures 19 May 2027, about ₹18,643. Covers the ₹11,936 premium."
export function fundingText(policy: Policy): string | null {
  const fund = policy.funded_by;
  if (fund === null) return null;
  let matures = "";
  if (fund.maturity_date !== null) {
    const about = fund.maturity_estimate === null ? "" : `, about ${roundRupees(fund.maturity_estimate)}`;
    matures = `: matures ${formatFullDate(fund.maturity_date)}${about}`;
  }
  let verdict = "";
  if (fund.covers === true) verdict = ` Covers the ${whole(policy.premium)} premium.`;
  else if (fund.covers === false && fund.shortfall !== null) verdict = ` ${roundRupees(fund.shortfall)} short.`;
  return `Funded by ${fund.name}${matures}.${verdict}`;
}

// A card bill that falls due before the funding arrives; null otherwise.
export function cardBillText(policy: Policy): string | null {
  const bill = policy.card_bill;
  const fund = policy.funded_by;
  if (bill === null || !bill.before_funding) return null;
  const maturity =
    fund?.maturity_date ? ` before your ${fund.name} matures on ${formatDueDate(fund.maturity_date)}` : "";
  return `This premium's card bill is due ${formatFullDate(bill.due)},${maturity}. Plan to pay it from the bank.`;
}

// "Renews 6 Apr 2027 (147 days)": the server's date and day count. Null once lapsed.
export function renewalText(policy: Policy): string | null {
  const days = policy.days_to_renewal;
  if (days === null) return null;
  let when = `${days} days`;
  if (days === 0) when = "today";
  else if (days === 1) when = "1 day";
  else if (days < 0) when = `${-days} days ago`;
  return `Renews ${formatFullDate(policy.period_end)} (${when})`;
}
