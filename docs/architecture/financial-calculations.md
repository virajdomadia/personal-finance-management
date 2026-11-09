# Financial calculations

The rules every figure in the product follows. The backend computes all of them. The website and the app only format and display what the API returns, and as of 2026-11-08 neither client does any money arithmetic.

Sections are marked **Current**, meaning built and tested, or **Planned**.

## Money

**Current.** Amounts are `NUMERIC(14, 2)` in PostgreSQL and `Decimal` in Python. They cross the API as strings with two decimals (`"1234.50"`) and never as JSON numbers. Every amount must be below ₹10^12 (`MAX_MONEY`). Sums are done in Python with `Decimal`, not with SQL `SUM`, because the test database (SQLite) stores numerics as floats.

**Planned.** Ledger postings store integer paise (`BIGINT`). See [ADR-003](../decisions/ADR-003-money-representation.md).

## Account balance

**Current** (`backend/app/api/balances.py`). Balances are never stored. Each request computes them:

```
flow(account)    = income into it + transfers into it − expenses from it − transfers out of it
balance(asset)   = opening_balance + flow
balance(card)    = opening_balance − flow      (a card's balance is what is owed)
```

| Transaction | Bank, cash, wallet, broker | Credit card (balance = owed) |
|---|---|---|
| Expense | Down | Up |
| Income or refund | Up | Down |
| Transfer in | Up | Down |
| Transfer out | Down | Up |

Cash and wallets can't go below zero. Banks (overdraft), brokers and cards can.

**Balance correction (current).** Entering a new current balance changes `opening_balance` so the computed balance lands on the entered figure. Transactions are left alone. This rewrites history: every past balance shifts too.

**Balance correction (decided, comes with the ledger).** An `adjustment` transaction for the difference, dated the day it's entered, against the equity account "Balance adjustments". The opening balance is never rewritten to make a figure come out.

## Net worth

```
net worth = total assets − total liabilities
```

Net worth is always computed from asset and liability accounts only. Income, expense and equity accounts explain how net worth changed, and they are never added into it. The full definition, including market value for holdings and possessions, is in the [ledger design](ledger-design.md#net-worth).

**Current.** `total_have` is the sum of positive asset balances plus any overpaid card balance, plus investments at current value: each holding at its latest recorded price, or at cost before a price is recorded. Holdings are not accounts; they are added on top of the account balances. `total_owe` is the sum of card balances plus any overdrawn bank balance. Archived accounts are left out.

**Invariants, all tested:**

- A transfer between the owner's own accounts never changes net worth (`test_card_bill_payment_lowers_both_balances_and_keeps_net_worth`, `test_transfer_between_banks_moves_money_and_keeps_net_worth`).
- A card bill payment is a transfer. It lowers the bank and the amount owed by the same figure, so the purchase counts as spending only once, when it was made.
- Over any sequence of creates, edits and deletes, every balance equals a simple reference model, and net worth equals the sum (`test_random_operations_match_the_reference_model`).

**Built for stocks.** Buying shares with broker cash moves value from cash to investments. It is not an expense and doesn't change net worth on the day. Stocks count at their latest recorded price, or at cost until a price is recorded. Physical assets and other investment types join the totals when those domains are built.

### Worked example

| Component | Amount |
|---|---|
| Bank accounts | ₹1,50,000 |
| Cash | ₹10,000 |
| Mutual funds | ₹2,00,000 |
| Stocks | ₹1,00,000 |
| Gold | ₹75,000 |
| Real estate | ₹20,00,000 |
| **Total assets** | **₹25,35,000** |
| Credit cards | ₹25,000 |
| Personal loan | ₹1,00,000 |
| **Total liabilities** | **₹1,25,000** |
| **Net worth** | **₹24,10,000** |

## Cash flow

```
net cash flow = income − expenses
```

**Current.** The transactions list returns `total_income` and `total_expense` over every transaction matching its filters, not just the current page. Transfers count in neither. A refund is currently recorded as income, so it raises that month's income rather than lowering its spending.

**Decided, comes with the ledger.** A refund is its own type. It links to the original expense and reduces that expense's category spending, in the month of the refund. An unlinked refund names an expense category. The refunds linked to one expense can't add up to more than it.

**Planned.** Investment purchases, loan principal repayments and transfers stay out of cash flow. Loan interest and fees are expenses. Principal repayment only reduces the liability.

## Investment returns (built for stocks and mutual funds)

Three figures, always kept apart:

- **Cost basis**: what was paid for the units still held.
- **Market value**: units held × the latest price the owner recorded.
- **Unrealised gain or loss**: market value − cost basis.

Example: buy 10 units at ₹100, then 5 units at ₹120, then record a price of ₹130.

| Figure | Calculation | Value |
|---|---|---|
| Units | 10 + 5 | 15 |
| Cost basis | 10 × ₹100 + 5 × ₹120 | ₹1,600 |
| Market value | 15 × ₹130 | ₹1,950 |
| Unrealised gain | ₹1,950 − ₹1,600 | +₹350 |

Acquisition fees (brokerage and charges on a purchase) are included in the cost basis, and charges on a sale reduce its proceeds. This is a reporting choice based on our understanding of Indian capital gains rules. It must be confirmed against current tax rules by a qualified professional, and the app makes no tax-compliance claim from it.

Market value comes only from recorded prices. (Planned, with the ledger: the ledger carries holdings at cost. The ledger is not built yet.) In net worth, a recorded price always wins over cost. A holding that cost ₹1,00,000 and was last valued at ₹1,20,000 counts as ₹1,20,000. Cost stands in only before the first price is recorded, and is labelled "at cost".

A partial sale takes cost from the oldest lots first (FIFO), always; choosing specific lots is a non-goal for now. Realised gain is the sale proceeds minus those lots' cost, and it is built for stocks. Dividend income and XIRR come later. New contributions raise portfolio value without being returns, so growth and performance are reported separately.

### Mutual fund rules

Funds use the same cost, value and FIFO rules, with these differences. See the [mutual funds design](../superpowers/specs/2026-11-09-mutual-funds-design.md).

- **`amount` is the source of truth.** A buy's `amount` is its cost, and a sell's `amount` is its proceeds. The owner enters it, because units × NAV is never exactly the amount (35.552 × 84.3793 = ₹2,999.81, while the statement says ₹2,999.85). The FIFO replay uses `amount` and never recomputes it.
- **Stamp duty is part of the cost.** Stamp duty is `round_paise(amount × 0.00005)`, so "invested" equals what left the bank. The suggested units are `round((amount − stamp duty) ÷ NAV, 3)`.
- **Fractional FIFO.** Units have up to 3 decimals and are summed exactly as `Decimal`. A partial redemption takes `round_paise(cost × taken ÷ lot_units)` from the oldest lot, and the lot keeps the remaining cost, so redeeming every unit leaves no paisa behind.
- **Value is `round_paise(units × latest NAV)`.** With no NAV recorded, a fund is held at cost and labelled "at cost". Existing units (an opening purchase) store the average purchase NAV, `round(amount ÷ units, 4)`, and never record a NAV.
- **The ₹1.00 check.** On a purchase, units × NAV must be within ₹1.00 of `amount − charges`. This catches a misplaced decimal without rejecting the statement's own rounding.
- **Automatic NAVs.** Recording a purchase or redemption that isn't an opening one also records its NAV for that day, unless a NAV already exists for that date. The NAV follows the trade when it is edited or deleted.
- **SIP due months.** A SIP never posts by itself. From its start month to the current month, a month is due when its debit day (clamped to the month's length, so day 31 falls on 28 or 29 February) is on or before today and no purchase for that SIP is recorded that month. A start date after the debit day makes the following month the first due. Missed months stay due until recorded.
- **The portfolio** reports stocks and funds separately (and crypto, see below), plus `overall`: the sum of the figures of all of them, with its percent worked out from the summed figures.

### Crypto rules

See the [crypto design](../superpowers/specs/2026-11-09-crypto-design.md). Coins use the same cost, value and FIFO rules as funds, with these differences.

- **Quantity has up to 8 decimals.** `investment_trades.quantity` was widened from `NUMERIC(18,3)` to `NUMERIC(24,8)`, which keeps every existing value exactly. Stocks and funds still show 0 and 3 decimals, and coins show 8.
- **`amount` is the entered figure.** It is the cost of a buy and the proceeds of a sell, as for funds. Exchange fees and TDS (1% on a sell) go in charges, so a buy's cost is what left the account and a sell's proceeds are what arrived after TDS.
- **The ₹1.00 check, on both sides.** Quantity × price must be within ₹1.00 of `amount − charges` on a buy, and of `amount + charges` on a sell.
- **No automatic price.** A coin's price is recorded by hand and never taken from a trade. With no price recorded a coin is held at cost and labelled "at cost". Existing coins (an opening entry) store the average price and never record a price.
- **The portfolio** gains a `crypto` object shaped like `funds`, and `overall` now adds crypto to stocks, funds and deposits.

**Stock `amount` backfill.** When the investment model was generalised, each existing stock trade got `amount = round_paise(quantity × price ± charges)`, the figure the stock code had always computed. Stock figures are therefore unchanged, and a test pins them against the owner's data.

## Deposits (PPF and RD)

**Built (2026-11-09).** See the [deposits design](../superpowers/specs/2026-11-09-deposits-design.md). A PPF or RD is an account whose balance is what the passbook says: deposits plus interest credited, minus withdrawals. It moves only through ordinary transactions. A deposit is a transfer from a bank, interest is an income with category "Interest", and a withdrawal is a transfer to a bank. Nothing else is accepted: an expense, an EMI, or a transfer to or from anything but a bank is refused.

**Estimate shown, not counted.** Every interest figure below is an estimate worked out when you ask for it. It is shown next to the balance, but it is never added to the balance or to net worth. Interest becomes real only when you record what the bank credited. Net worth uses the balance alone. All money is `Decimal` and each figure is rounded half up to paise once, at the end. The one exception is PPF yearly interest, which is rounded to the rupee (see the PPF section).

### PPF interest

For each month, interest is `rate ÷ 12 ÷ 100 × the lowest balance between the end of the 5th and the end of the month`. A deposit on or before the 5th earns for that month, and one after the 5th doesn't. The year's interest is the sum of April to March, rounded once to the nearest rupee, as the owner's passbook shows (₹94.67 becomes ₹95), and the bank credits it on 31 March. A month counts once today has reached its last day.

Worked example, rate 7.1%, ₹1,00,000 on 1 April and ₹50,000 deposited on 10 April:

| Months | Lowest balance | Interest |
|---|---|---|
| April | ₹1,00,000 | ₹591.67 |
| May to March (11 months) | ₹1,50,000 | ₹887.50 × 11 = ₹9,762.50 |
| Sum | | ₹10,354.1667 |
| Year, to the nearest rupee | | **₹10,354** |

Deposited on 4 April instead, all twelve months earn on ₹1,50,000, which gives **₹10,650**. A PPF matures on 1 April, 16 years after the start of the financial year it was opened in: opened 10 June 2020, it matures on 1 April 2036. The yearly limit of ₹1,50,000 is shown and not enforced.

From 31 March, the year just ended is "due" when it ended on or after the day the account was added to the app, and no interest income is recorded between that 31 March and 30 March a year later. The app then offers to record the estimate, which you correct to the passbook figure.

### RD interest

Banks compound an RD quarterly. With `q = 1 + rate ÷ 400`, an amount held for `m` whole months grows to `amount × q^(m ÷ 3)`.

- **Maturity value** is the sum, for k = 1 to n, of `instalment × q^((n − k + 1) ÷ 3)`, where n is the tenure in months. It is what the RD pays if every instalment is on time. ₹5,000 a month for 24 months at 7% gives **₹1,29,098.90**. ₹1,000 a month for 12 months at 6.8% gives **₹12,448.73**.
- **Interest so far** is the sum, over every instalment paid, of `amount × (q^(m ÷ 3) − 1)`, where m is the whole months from the instalment to today (or to maturity, if earlier). The interest already recorded into the RD is subtracted, and the result is never below zero. Four ₹5,000 instalments at 7%, held 3, 2, 1 and 0 months, give **₹174.66**.
- **Value today** is the balance plus interest so far.

An instalment never posts on its own. A month is due when its instalment day (clamped to the month's length) is on or before today and no transfer into the RD is dated in that month. Missed months stay due until recorded.

### In the investments totals

Active PPF and RD accounts also show on the Investments page and count in the investments totals (`overall` in the portfolio, `investments` on the dashboard) at their balance, never at the estimate. The balance is added to both invested and value, so unrealised is unchanged and its percent is over the larger invested total. Net worth is unaffected, since the deposits are already in it as accounts.

### Closing an RD

Close RD records, in one step: the interest (what you received minus the balance) as an income with category "Interest", then a transfer of what you received to the bank, then archives the RD, which ends at exactly ₹0. If you received less than the balance, as with a penalty for closing early, the shortfall is an expense with category "Fees and charges" instead. Example: balance ₹20,000 and ₹19,800 received gives a ₹200 fee and a ₹19,800 transfer.

## Dates

"Today" is India's date (UTC+05:30). Future-dated transactions are refused.

**Known gap.** The below-zero rule judges today's balance, not the balance on the transaction's date. A backdated expense can therefore be accepted even though the account would have been negative on that day. This is a deliberate simplification for now.
