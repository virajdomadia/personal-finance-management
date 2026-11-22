import { cleanMoney, formatRupees } from "./accounts.ts";
import { formatDate } from "./transactions.ts";

// A credit card's statement, as GET /accounts/{id}/statements lists it.
export type CardStatement = {
  id: number;
  account_id: number;
  statement_date: string;
  total_due: string;
  minimum_due: string | null;
  due_date: string;
  source: "sms" | "manual";
};

export type BillStatus = "paid" | "minimum_paid" | "part_paid" | "unpaid";

// Where the latest statement's bill stands.
export type CurrentBill = {
  statement: CardStatement;
  paid: string;
  left: string;
  extra: string; // paid beyond the total; it counts toward the next bill
  minimum_left: string | null;
  status: BillStatus;
  overdue: boolean;
};

export type StatementList = { statements: CardStatement[]; current: CurrentBill | null; unbilled: string };

export type StatementForm = { statement_date: string; total_due: string; minimum_due: string; due_date: string };

const isZero = (money: string) => Number(money) === 0;

// The bill in a line or two: where it stands, then (until it is met) its minimum.
export function billLines(bill: CurrentBill): string[] {
  const total = bill.statement.total_due;
  let first: string;
  if (bill.status === "paid") {
    first = isZero(bill.extra) ? "Paid" : `Paid · ${formatRupees(bill.extra)} more than the bill, which counts toward the next one`;
  } else if (bill.status === "minimum_paid") {
    first = `Minimum paid · ${formatRupees(bill.left)} left`;
  } else if (bill.status === "part_paid") {
    first = `${formatRupees(bill.paid)} of ${formatRupees(total)} paid · ${formatRupees(bill.left)} left`;
  } else {
    first = `Unpaid · ${formatRupees(bill.left)} due ${formatDate(bill.statement.due_date)}`;
  }
  if (bill.overdue) first = `Overdue · ${first}`;
  const lines = [first];
  const minimum = bill.statement.minimum_due;
  if (minimum !== null && bill.minimum_left !== null && !isZero(bill.minimum_left)) {
    lines.push(
      bill.minimum_left === minimum
        ? `Minimum ${formatRupees(minimum)}`
        : `Minimum ${formatRupees(minimum)} · ${formatRupees(bill.minimum_left)} still to pay`,
    );
  }
  return lines;
}

export function blankStatementForm(today: string): StatementForm {
  return { statement_date: today, total_due: "", minimum_due: "", due_date: "" };
}

export function statementForm(s: CardStatement): StatementForm {
  return {
    statement_date: s.statement_date,
    total_due: s.total_due,
    minimum_due: s.minimum_due ?? "",
    due_date: s.due_date,
  };
}

const textOrNull = (raw: string) => raw.trim() || null;

export function statementPayload(form: StatementForm): Record<string, string | null> {
  return {
    statement_date: textOrNull(form.statement_date),
    total_due: textOrNull(cleanMoney(form.total_due)),
    minimum_due: textOrNull(cleanMoney(form.minimum_due)),
    due_date: textOrNull(form.due_date),
  };
}
