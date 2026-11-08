# Loans: design

## Why

The owner has a loan taken on their HDFC credit card: ₹21,632 outstanding, repaid in 3 EMIs of ₹7,500 billed to the card. Today the whole ₹21,632 sits in the card's balance, so the card looks like ordinary spending that is due now, and nothing shows what the loan costs or how many EMIs are left. Loans in general (personal, vehicle, card loans, purchases converted to EMI) need the same treatment.

## Decided with the owner

- Build loans now, ahead of the ledger milestone in the roadmap.
- A loan on a card is its own thing, linked to the card. The same balance is never recorded twice ([database design](../../architecture/database-design.md)).

## Model

**A loan is an account of type `loan`.** Like a card, its balance is what's owed, and it counts in "You owe" and net worth. It can't go below ₹0.

| Field | Meaning |
|---|---|
| `balance` | Outstanding principal, ≥ 0 |
| `institution` | Lender |
| `due_day` | EMI day of the month, 1 to 31 |
| `interest_rate` | Optional. Annual %, 0 to 100, at most 2 decimals |
| `emi_amount` | Optional. > 0 |
| `emis_left` | Optional. 1 to 600. Goes down by one for each EMI recorded |
| `pay_from_id` | Optional. The account EMIs are paid from: an active account of the owner's that isn't a loan |

**An EMI is a transaction of type `emi`.** `account_id` is the account it's paid from, `to_account_id` the loan, `amount` the full EMI and `interest` the part that is interest and charges (GST included), with `0 ≤ interest ≤ amount`.

| Effect | |
|---|---|
| Paying account | Loses `amount` (a card's owed goes up) |
| Loan | Owed goes down by the principal, `amount − interest` |
| Spending | `interest` only, under "Loan interest" |

This is the ledger design's three-line EMI (`Loan +principal · Expense:Loan interest +interest · Bank −amount`) kept in one row, so the backfill maps it directly.

**Taking or moving a loan uses transfers.** Money paid into a bank is a transfer from the loan to the bank. A prepayment is a transfer from a bank to the loan.

**Moving a loan off a card.** When a loan is created with a card as `pay_from_id`, `moved_from_card: true` records a transfer of the outstanding amount from the loan to the card, dated today. The loan's opening balance is then 0, so the transfer is what makes it owed. The card's owed drops by the same amount, and the total owed doesn't change.

**A card's available credit** is its limit minus its own balance and minus what's outstanding on the active loans paid from it, because the bank blocks that part of the limit. Dashboard credit use counts those loans too.

**The suggested next EMI** is part of a loan's response (`next_emi`: amount, interest, principal), or null without `emi_amount` or with nothing owed:

- With a rate: interest = outstanding × rate ÷ 1200, rounded half up to paise.
- Without a rate but with `emis_left`: the remaining extra cost spread evenly, (emis_left × EMI − outstanding) ÷ emis_left, never below 0. For the owner's loan that's ₹289.33.
- Otherwise interest is null, and the form asks for it.
- The amount is the EMI, or outstanding + interest when that's smaller (the final EMI).

The client pre-fills the EMI form with it. The owner can always change it to what the statement says.

## API changes

- Accounts: type `loan`, the fields above, and `moved_from_card` on create only. Every account response carries `interest_rate`, `emi_amount`, `emis_left`, `pay_from_id` and `next_emi`, which are null except for loans.
- Transactions: type `emi` and an `interest` field, which only an EMI has. `total_expense` adds EMI interest. EMIs are filtered as their own type.
- Storage: `accounts` gains `interest_rate`, `emi_amount`, `emis_at_opening` and `pay_from_id`. `emis_left` = `emis_at_opening` − EMIs recorded, and editing it moves `emis_at_opening`, the way a balance correction moves the opening balance. `transactions` gains `interest`.

## Clients

- **Web:** the account dialog gains the loan type and its fields. A loan row shows owed, EMI, EMIs left and the next EMI date, with a "Record EMI" action. The transaction dialog gains the EMI type with the pre-filled split and the principal shown. The dashboard caption no longer says loans are missing.
- **Android:** its own screens, built after the website is tested on production.

## Non-goals

A full amortisation schedule, reminders, auto-posting EMIs, floating rates, a pre-closure calculator, loans given to others, and buy now pay later.

## Design calls made by Claude, not yet confirmed by the owner

- Loans are stored as columns on `accounts`, like the card details, rather than in a separate `loan_details` table.
- The EMI's interest and charges go to one spending category, "Loan interest".
- Loans sort after the other account types.
- A loan's EMI count goes down only when an EMI is recorded, not with the calendar.
