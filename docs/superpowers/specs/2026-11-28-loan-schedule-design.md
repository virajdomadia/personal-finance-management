# Loan repayment schedule

## Why

Gullak already suggests each EMI's interest (`next_emi`: owed × rate ÷ 1200) and counts EMIs left, but nowhere shows the rest of the loan: when it ends, how much interest is still to come, and how each EMI splits from here on. The owner asked for "what's best".

## Approaches

- **Computed on the fly (chosen).** Work the schedule out on every request from what's stored: what's owed now, the rate, the EMI and the due day. Nothing new is stored, no migration, and it's always right after a prepayment or a balance correction, because it starts from today's balance.
- Import the bank's schedule (PDF). Much more work, and stale the moment anything is prepaid. Dropped.

## Design

- **Endpoint:** `GET /api/accounts/{id}/schedule` for a loan the user owns (404 otherwise; 422 "Only a loan has a repayment schedule." for another type).
- **Needs** `interest_rate` and `emi_amount`, and something owed. Otherwise the response has no rows and a `problem`: "Add the interest rate to see the schedule." / "Add the EMI to see the schedule." / nothing owed → `paid_off: true`.
- **Rows, month by month,** from the balance owed now:
  - interest = balance × rate ÷ 1200, rounded half up to the paisa (the same rule as `next_emi`, so row 1 equals the suggested EMI);
  - amount = the EMI, or balance + interest when that's smaller (the last EMI); principal = amount − interest; balance after = balance − principal.
  - **First month:** this month, unless an EMI to this loan is already recorded for it (the same test the "next 30 days" list uses, `emis_paid`); then next month. Each row's date is the due day clamped to the month (`clamped_date`), or only the month when the loan has no due day.
- **Never pays off:** when the EMI doesn't cover the first month's interest, no rows, and `problem`: "This EMI doesn't cover the monthly interest, so the loan never gets paid off."
- **Summary:** EMIs left (number of rows), the last row's date (`ends`), total interest still to pay, total still to pay. A cap of 600 rows (50 years) stops a runaway; past it, `problem` says so.
- **Web:** a **Schedule** button on each loan row in Accounts opens a dialog: the summary line, then a table (Due, EMI, Interest, Principal, Left after).
- **Phone:** a **Schedule** action on each loan in Accounts opens a screen with the same summary and rows.
- **Rules doc:** a "Repayment schedule" paragraph in `docs/architecture/financial-calculations.md` near the loans rules.

## Not doing

A "what if I prepay ₹X" calculator (the natural next step), floating rates, reducing-tenure vs reducing-EMI choices after a prepayment, importing the bank's schedule, storing a schedule.

## Left to the builder

Exact copy beyond the messages above, the table's look, and where the buttons sit next to "Record EMI".
