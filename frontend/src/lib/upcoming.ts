// The next 30 days (`GET /upcoming`) and safe to spend (`GET /safe-to-spend`). The server works out
// every figure, the running balance and the breakdown; these helpers only word and format them.

import { formatDueDate, formatRupees } from "./accounts.ts";

export type UpcomingKind = "recurring" | "insurance" | "emi" | "sip" | "rd" | "card_bill" | "goal";

export type UpcomingItem = {
  date: string;
  kind: UpcomingKind;
  name: string;
  account_id: number | null;
  account_name: string | null;
  amount: string;
  varies: boolean; // a card bill with no statement yet: `amount` is what is owed now
  direction: "out" | "in" | "none";
  overdue: boolean;
  balance_after: string;
  ref_id: number;
};

export type Upcoming = {
  start: string;
  through: string;
  starting_balance: string;
  ending_balance: string;
  items: UpcomingItem[];
};

export type Part = { name: string; amount: string };
export type DuePart = Part & { date: string; kind: UpcomingKind; overdue: boolean; varies: boolean };
export type BudgetPart = Part & { category_id: number; remaining: string; due: string };

export type SafeToSpend = {
  amount: string; // can be negative: money short
  until: string;
  reason: "salary" | "month_end";
  payday: { name: string; date: string } | null;
  money: string;
  due: string;
  goals: string;
  budgets: string;
  money_items: Part[];
  due_items: DuePart[];
  goal_items: Part[];
  budget_items: BudgetPart[];
};

export const KIND_LABELS: Record<UpcomingKind, string> = {
  recurring: "Reminder",
  insurance: "Premium",
  emi: "EMI",
  sip: "SIP",
  rd: "RD instalment",
  card_bill: "Card bill",
  goal: "Goal set-aside",
};

const isNegative = (amount: string) => amount.startsWith("-") && !/^-0+(\.0+)?$/.test(amount);
export const isZero = (amount: string) => /^-?0+(\.0+)?$/.test(amount);

// The headline: "₹16,200.00", or "₹3,000.00 short" when the server's figure is negative.
export function safeFigure(amount: string): { text: string; short: boolean } {
  return isNegative(amount)
    ? { text: `${formatRupees(amount.slice(1))} short`, short: true }
    : { text: formatRupees(amount.replace(/^-/, "")), short: false };
}

// "until payday, Salary on 1 Dec", "until the end of the month" or "until 30 Nov".
export function untilText(s: Pick<SafeToSpend, "reason" | "payday" | "until">): string {
  if (s.reason === "salary" && s.payday) return `until payday, ${s.payday.name} on ${formatDueDate(s.payday.date)}`;
  if (s.reason === "month_end") return "until the end of the month";
  return `until ${formatDueDate(s.until)}`;
}

// The due line's label follows the window the server used.
export function dueLabel(s: Pick<SafeToSpend, "reason" | "until">): string {
  return s.reason === "salary" ? "Due before payday" : `Due by ${formatDueDate(s.until)}`;
}

// An item's amount: "₹4,250.00 so far · amount varies" for a card bill with no statement yet.
export function amountText(item: Pick<UpcomingItem, "amount" | "varies">): string {
  return item.varies ? `${formatRupees(item.amount)} so far · amount varies` : formatRupees(item.amount);
}

// The amount with the way it moves the balance: "−₹20,000.00", "+₹90,000.00" (a goal set-aside
// or a card charge doesn't move it, so it has no sign).
export function signedAmountText(item: Pick<UpcomingItem, "amount" | "varies" | "direction">): string {
  const sign = item.direction === "out" ? "−" : item.direction === "in" ? "+" : "";
  return `${sign}${amountText(item)}`;
}

// The small line under an item: "EMI · HDFC Bank · overdue".
export function itemMeta(item: Pick<UpcomingItem, "kind" | "account_name" | "overdue">): string {
  return [KIND_LABELS[item.kind], item.account_name, item.overdue ? "overdue" : null].filter(Boolean).join(" · ");
}

export type BreakdownLine = {
  key: "money" | "due" | "goals" | "budgets";
  sign: "" | "−";
  label: string;
  amount: string;
  items: { key: string; label: string; amount: string; note: string | null }[];
  empty: string;
};

// The four lines of "How this is worked out", each with the items behind it.
export function breakdown(s: SafeToSpend): BreakdownLine[] {
  return [
    {
      key: "money",
      sign: "",
      label: "Money now",
      amount: s.money,
      items: s.money_items.map((p, i) => ({ key: `m${i}`, label: p.name, amount: p.amount, note: null })),
      empty: "No bank, cash or wallet accounts.",
    },
    {
      key: "due",
      sign: "−",
      label: dueLabel(s),
      amount: s.due,
      items: s.due_items.map((d, i) => ({
        key: `d${i}`,
        label: `${formatDueDate(d.date)} · ${d.name}`,
        amount: d.amount,
        note: [KIND_LABELS[d.kind], d.overdue ? "overdue" : null, d.varies ? "amount varies" : null]
          .filter(Boolean)
          .join(" · "),
      })),
      empty: "Nothing due.",
    },
    {
      key: "goals",
      sign: "−",
      label: "Set aside for goals",
      amount: s.goals,
      items: s.goal_items.map((p, i) => ({ key: `g${i}`, label: p.name, amount: p.amount, note: null })),
      empty: "Nothing set aside.",
    },
    {
      key: "budgets",
      sign: "−",
      label: "Budgets left",
      amount: s.budgets,
      items: s.budget_items.map((b) => ({
        key: `b${b.category_id}`,
        label: b.name,
        amount: b.amount,
        note: budgetNote(b),
      })),
      empty: "No budgets this month.",
    },
  ];
}

// "₹20,000.00 left, less ₹20,000.00 in bills above", or "₹800.00 left".
export function budgetNote(b: Pick<BudgetPart, "remaining" | "due">): string {
  const left = `${formatRupees(b.remaining)} left`;
  return isZero(b.due) ? left : `${left}, less ${formatRupees(b.due)} in bills above`;
}
