import { cleanMoney, formatDueDate, formatRupees } from "./accounts.ts";
import { type Template, amountError, dateError, limitError, whole } from "./recurring.ts";
import { formatDate } from "./transactions.ts";

// Mirrors PolicyResponse in backend/app/api/routes/policies.py.
export type FundedBy = {
  account_id: number;
  name: string;
  maturity_date: string | null;
  maturity_estimate: string | null;
  covers: boolean | null;
  shortfall: string | null;
  matured: boolean; // the server's word that the RD matured before today
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

export type PolicyForm = {
  insurer: string;
  plan: string;
  policy_number: string;
  insured: string;
  sum_insured: string;
  period_start: string;
  period_end: string;
  premium: string;
  account_id: string;
  funded_by_id: string;
  details: string;
  paid_on: string;
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
const idOrNull = (raw: string) => (raw === "" ? null : Number(raw));

export function renewPayload(form: RenewForm): Record<string, unknown> {
  return {
    date: textOrNull(form.date),
    amount: textOrNull(cleanMoney(form.amount)),
    account_id: idOrNull(form.account_id),
    period_start: textOrNull(form.period_start),
    period_end: textOrNull(form.period_end),
    sum_insured: textOrNull(cleanMoney(form.sum_insured)),
  };
}

// A period must end after it starts and within a year of it (a clamped same day next year counts).
function periodError(start: string, end: string): string | null {
  const s = start.trim();
  const e = end.trim();
  return s < e && e <= addYear(s) ? null : "The period must end after it starts, within a year.";
}

// The server's rules for renewing, with its messages, checked before saving. `today` is "YYYY-MM-DD"
// in India; `currentEnd`, when given, is the policy's present period end, which the new one must follow.
export function renewErrors(form: RenewForm, today: string, currentEnd?: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const set = (field: string, message: string | null) => {
    if (message !== null) errors[field] = message;
  };
  set("period_start", dateError(form.period_start, "Choose the date the period starts."));
  if (!errors.period_start && currentEnd !== undefined && form.period_start.trim() <= currentEnd) {
    errors.period_start = "The new period must start after the current one ends.";
  }
  set("period_end", dateError(form.period_end, "Choose the date the period ends."));
  if (!errors.period_start && !errors.period_end) set("period_end", periodError(form.period_start, form.period_end));
  set("sum_insured", amountError(form.sum_insured, "Enter the sum insured.", "Sum insured"));
  set("amount", amountError(form.amount, "Enter an amount."));
  const date = form.date.trim();
  set("date", dateError(date, "Choose a date."));
  if (!errors.date && date > today) errors.date = "The date can't be in the future.";
  if (form.account_id === "") errors.account_id = "Choose an account.";
  return errors;
}

export function policyFormBlank(): PolicyForm {
  return {
    insurer: "",
    plan: "",
    policy_number: "",
    insured: "",
    sum_insured: "",
    period_start: "",
    period_end: "",
    premium: "",
    account_id: "",
    funded_by_id: "",
    details: "",
    paid_on: "",
  };
}

export function policyFormFrom(policy: Policy): PolicyForm {
  const latest = policy.periods[policy.periods.length - 1];
  return {
    insurer: policy.insurer,
    plan: policy.plan,
    policy_number: policy.policy_number,
    insured: policy.insured,
    sum_insured: policy.sum_insured,
    period_start: policy.period_start,
    period_end: policy.period_end,
    premium: policy.premium,
    account_id: String(policy.paying_account_id),
    funded_by_id: policy.funded_by === null ? "" : String(policy.funded_by.account_id),
    details: policy.details ?? "",
    paid_on: latest?.paid_on ?? "",
  };
}

// The kind is fixed (health) and only sent on create.
export function policyPayload(form: PolicyForm, mode: "create" | "edit"): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (mode === "create") payload.kind = "health";
  payload.insurer = textOrNull(form.insurer);
  payload.plan = textOrNull(form.plan);
  payload.policy_number = textOrNull(form.policy_number);
  payload.insured = textOrNull(form.insured);
  payload.sum_insured = textOrNull(cleanMoney(form.sum_insured));
  payload.period_start = textOrNull(form.period_start);
  payload.period_end = textOrNull(form.period_end);
  payload.premium = textOrNull(cleanMoney(form.premium));
  payload.account_id = idOrNull(form.account_id);
  payload.funded_by_id = idOrNull(form.funded_by_id);
  payload.details = textOrNull(form.details);
  payload.paid_on = textOrNull(form.paid_on);
  return payload;
}

// What an edit sends: only what differs from the loaded policy. Empty means nothing to save.
export function changedPolicy(form: PolicyForm, original: Policy): Record<string, unknown> {
  const before = policyPayload(policyFormFrom(original), "edit");
  const after = policyPayload(form, "edit");
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (!Object.is(after[key], before[key])) changed[key] = after[key];
  }
  return changed;
}

// The server's rules for a policy, with its messages, checked before saving. With `today` given, the
// payment date is also kept out of the future.
export function policyErrors(form: PolicyForm, today?: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const set = (field: string, message: string | null) => {
    if (message !== null) errors[field] = message;
  };
  const required = (field: keyof PolicyForm, blank: string, limit: number) =>
    set(field, form[field].trim() === "" ? blank : limitError(form[field], limit));
  required("insurer", "Enter the insurer.", 52);
  required("plan", "Enter the plan.", 100);
  required("policy_number", "Enter the policy number.", 40);
  required("insured", "Enter who is insured.", 100);
  set("details", limitError(form.details, 2000));
  set("sum_insured", amountError(form.sum_insured, "Enter the sum insured.", "Sum insured"));
  set("premium", amountError(form.premium, "Enter the premium.", "Premium"));
  set("period_start", dateError(form.period_start, "Choose the date the period starts."));
  set("period_end", dateError(form.period_end, "Choose the date the period ends."));
  if (!errors.period_start && !errors.period_end) set("period_end", periodError(form.period_start, form.period_end));
  if (form.account_id === "") errors.account_id = "Choose an account.";
  set("paid_on", dateError(form.paid_on, "Choose the date it was paid."));
  if (!errors.paid_on && today !== undefined && form.paid_on.trim() > today) {
    errors.paid_on = "The date can't be in the future.";
  }
  return errors;
}

// Money text rounded half up to whole rupees, from the digits so no float is involved.
export function roundRupees(money: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(money.trim());
  if (!match) return money;
  const [, sign, digits, fraction = ""] = match;
  const up = fraction.length > 0 && fraction[0] >= "5";
  return formatRupees(`${sign}${up ? (BigInt(digits) + BigInt(1)).toString() : BigInt(digits).toString()}`);
}

// "Funded by Bank of India RD: matures 19 May 2027, about ₹18,643. Covers the ₹11,936 premium."
// Once the server says the RD has matured, "matured 19 May 2027".
export function fundingText(policy: Policy): string | null {
  const fund = policy.funded_by;
  if (fund === null) return null;
  let matures = "";
  if (fund.maturity_date !== null) {
    const about = fund.maturity_estimate === null ? "" : `, about ${roundRupees(fund.maturity_estimate)}`;
    matures = `: ${fund.matured ? "matured" : "matures"} ${formatDate(fund.maturity_date)}${about}`;
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
  return `This premium's card bill is due ${formatDate(bill.due)},${maturity}. Plan to pay it from the bank.`;
}

// "Renews 6 Apr 2027 (147 days)": the server's date and day count. Null once lapsed.
export function renewalText(policy: Policy): string | null {
  const days = policy.days_to_renewal;
  if (days === null) return null;
  let when = `${days} days`;
  if (days === 0) when = "today";
  else if (days === 1) when = "1 day";
  else if (days < 0) when = `${-days} days ago`;
  return `Renews ${formatDate(policy.period_end)} (${when})`;
}
