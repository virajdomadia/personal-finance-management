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

**Current.** `total_have` is the sum of positive asset balances plus any overpaid card balance. `total_owe` is the sum of card balances plus any overdrawn bank balance. Archived accounts are left out.

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

## Investment returns (built for stocks)

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

Acquisition fees (brokerage and charges on a purchase) are proposed to go into the cost basis. This is a reporting choice based on our understanding of Indian capital gains rules. It must be confirmed against current tax rules by a qualified professional, and the app makes no tax-compliance claim from it.

The ledger carries holdings at cost, and market value comes only from recorded prices. In net worth, a recorded price always wins over cost. A holding that cost ₹1,00,000 and was last valued at ₹1,20,000 counts as ₹1,20,000. Cost stands in only before the first price is recorded, and is labelled "at cost".

A partial sale takes cost from specific lots, oldest first unless the owner chooses otherwise. Realised gain is the sale proceeds minus that lots' cost. Realised gains, dividend income and XIRR come later. New contributions raise portfolio value without being returns, so growth and performance are reported separately.

## Dates

"Today" is India's date (UTC+05:30). Future-dated transactions are refused.

**Known gap.** The below-zero rule judges today's balance, not the balance on the transaction's date. A backdated expense can therefore be accepted even though the account would have been negative on that day. This is a deliberate simplification for now.
