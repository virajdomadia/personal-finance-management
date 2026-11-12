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

**Current.** The transactions list returns `total_income` and `total_expense` over every transaction matching its filters (search included), not just the current page. Transfers count in neither, and an EMI counts its interest as spending. A refund is currently recorded as income, so it raises that month's income rather than lowering its spending.

**Decided, comes with the ledger.** A refund is its own type. It links to the original expense and reduces that expense's category spending, in the month of the refund. An unlinked refund names an expense category. The refunds linked to one expense can't add up to more than it.

### Monthly cash flow

**Built on branch `cash-flow`.** See the [design](../superpowers/specs/2026-11-12-cash-flow-design.md). `GET /cash-flow?month=YYYY-MM` returns a month's figures.

```
income    = Σ amount of income transactions in the window
spending  = Σ amount of expense transactions + Σ interest of EMI transactions, in the window
net       = income − spending
```

| Movement | Income | Spending |
|---|---|---|
| `income` (salary, interest, dividends, refunds) | amount | — |
| `expense` (any account, cards included, when the purchase is made) | — | amount |
| `emi` | — | `interest` only; the principal only lowers the loan |
| `transfer` (between own accounts, card bill payments, PPF/RD deposits and withdrawals) | — | — |
| Stock, fund and coin trades (`investment_trades`) | — | — |

- **The window** runs from the 1st of the month to the cut-off day: today (India's date) in the current month, the last day for a past month. A future month is refused.
- **Previous month at the same day**: the month before, from its 1st to the same day number, clamped to its length. 12 November compares with 1–12 October; 30 March with 1–28 February. On a month's last day the month counts as whole, so 31 March (like any later day) compares with the whole of February, and 30 April with the whole of March. A whole past month compares with the whole month before. The change is `this − previous`, and its percent is `change ÷ previous × 100` rounded half up to a whole number, with no percent when the previous figure is 0.
- **By category**: income and spending are grouped by category. A subcategory's figure also counts in its parent's (one level). Each group's share is `group ÷ total × 100`, rounded half up to a whole percent. A transaction without a category (SMS, not yet answered) is "Uncategorised"; an EMI's interest is "Loan interest". The top 3 are the three biggest spending groups, ties by name.
- **Daily spending**: each day's spending, and its bar height as `day ÷ the biggest day × 100`, rounded half up. Days after today have no figure.
- Refunds are income until they get their own type (below).

Example, November up to the 12th: salary ₹80,000; groceries ₹6,000; a Swiggy order ₹1,200 under Food and dining → Dining; an EMI of ₹12,000 with ₹3,000 interest; ₹20,000 paid to the credit card; ₹10,000 into a fund. Income ₹80,000, spending ₹6,000 + ₹1,200 + ₹3,000 = **₹10,200**, net **₹69,800**. The card payment, the fund purchase and the ₹9,000 principal are not spending.

## Budgets, the next 30 days and safe to spend

**Built on branch `budgets`.** See the [design](../superpowers/specs/2026-11-13-budgets-design.md). Everything here is worked out when asked for; only the budget amounts are stored.

### Monthly budgets

A budget is an amount a month for one **expense** category, top-level or subcategory. It stays the same every month until it is changed.

- **Versions by month.** Setting, changing or removing a budget always applies from the current month onwards. Each change is a row with an `effective_from` month (its 1st); the budget for a month is the latest row on or before it, and a row with no amount means "no budget from this month". Last month's figures never change because this month's budget did.
- **Spent** uses exactly the [monthly cash flow](#monthly-cash-flow) rules and window: expenses plus EMI interest, from the 1st to today in the current month (the whole month for a past one), grouped by category with subcategories rolled up into their parent. A budget on Food and dining counts Groceries and Dining under it; a budget on Dining counts only Dining.
- **Per budget:** `left = budget − spent`; `remaining = max(left, 0)`; `over by = max(−left, 0)`; **over** when spent > budget; `percent used = spent ÷ budget × 100`, rounded half up to a whole number (it can pass 100), and the bar is that percent capped at 100.
- **No rollover.** Unused budget doesn't carry into the next month, and an overspend doesn't reduce the next one.
- **The overall total** adds up the *counted* budgets: every active budget, except a subcategory's when its parent also has an active budget (the parent's already includes that spending, so nothing counts twice). Overall `left` = total budget − total spent, which can be negative; `remaining`, `over by` and `percent used` as above.
- **An archived category's budget** is shown as inactive. It isn't counted in the total or in safe to spend, and it can't be changed until the category is restored (removing it still works).
- **A merged category's budget follows the merge** to the category it was merged into, unless that one has its own budget, in which case the merged one is shown as inactive. Renaming changes nothing: a budget belongs to the category, not to its name.
- Spending with no category ("Uncategorised") can't have a budget.

Example, November to the 12th: Food and dining ₹8,000 with Groceries ₹6,000 and Dining ₹1,200 under it: ₹7,200 spent, ₹800 remaining, 90%. Dining also has its own budget of ₹1,000: ₹1,200 spent, over by ₹200, 120%, shown red. The total counts only Food and dining: ₹8,000 budget, ₹7,200 spent, ₹800 left.

### The next 30 days

One list of everything due from today to 30 days ahead, plus anything already overdue (it is still owed), soonest first. Each kind uses its existing due rules:

| Kind | Dates and amount |
|---|---|
| Recurring reminders (salary, rent, a card bill transfer) | Every open occurrence up to the end of the window, by the [occurrence rules](#occurrence-rules). The reminder's amount. |
| Insurance premiums | The policy's reminder, as above, shown as a premium. |
| EMIs | Each active loan with an instalment day, an EMI and money still owed: the instalment day in each month of the window, unless an EMI is already recorded for that period (in its calendar month or within 15 days, as the SMS matching does). This month's, if passed and unpaid, is overdue. The amount is the next EMI's. |
| SIPs | Every unrecorded debit date up to the end of the window, by the [SIP due rules](#mutual-fund-rules). The SIP's amount. |
| RD instalments | Every unpaid instalment date up to the end of the window, by the [RD rules](#rd-interest). The instalment. |
| Credit card bills | One bill per card: the latest statement's unpaid part on its due date (the dashboard's rule). A card with no unpaid statement but a due day and money owed shows its next due date with what is owed now, marked **amount varies**. A card that a recurring transfer reminder pays is left to that reminder, so its bill isn't listed twice. |
| Goal set-asides | A goal's monthly reminder: this month's part still to set aside (overdue from the reminder day), and next month's full amount when its reminder day falls in the window. |

**Running balance.** It starts at the sum of the balances of active bank, cash and wallet accounts (an overdrawn bank counts negative) and moves after each item:

- Money out of one of those accounts lowers it (expenses, EMIs, SIPs, RD instalments, transfers to a card, loan, deposit or any account outside the group). Money into one raises it (income, transfers in from outside the group). A transfer between two of them changes nothing.
- A card bill lowers it, since it will be paid from a bank. Anything charged to a card (a premium on a card, an EMI paid from a card) changes nothing now: it reaches the bank with a later card bill.
- A goal set-aside changes nothing, because earmarked money stays in its account.

Items on the same day: overdue first, then money out before money in, so the balance never looks better than it can be.

### Safe to spend

```
safe to spend = money now − due before payday − set aside for goals − budgets left
```

- **Money now** = the balances of active bank, cash and wallet accounts (the running balance's start). Brokers, deposits, investments and cards aren't counted.
- **Payday** is the next occurrence after today of an active income reminder whose category is Salary or a subcategory of it; with several, the earliest. **Due before payday** adds up everything in the next-30-days rules dated up to the day before payday, overdue items included: money leaving bank, cash or wallet (bills, EMIs, SIPs, RD instalments, transfers out), card bills, and goal set-asides. Anything due on payday itself is left to the new salary. Expected income, the salary included, is never counted before it arrives.
- **No salary reminder:** the window ends on the last day of this month.
- **Set aside for goals** = the earmarks of active goals in active bank, cash and wallet accounts (see [free balance](#free-balance)).
- **Budgets left** = for each counted budget this month, its remaining amount less the bills above that fall in its category this month (so a ₹20,000 rent reminder and a ₹20,000 Housing budget take ₹20,000 once, not twice), never below 0. For an EMI, only its interest is spending (in Loan interest). An overspent budget adds 0: it never gives money back.
- **Credit card dues.** Card purchases count against budgets when they are made. The bill counts in "due before payday" only when it falls due before payday.
- **Negative results** are shown as they are ("₹X short"). An overdrawn bank, overdue bills or more set aside than held can push the figure below zero, and it is not clamped.
- The API returns the figure and every line of the breakdown, with each bill and budget in it, so it can be checked by hand.

Example, 12 November, salary reminder on the 1st, so the window runs to 30 November: bank ₹60,000 and cash ₹2,000 = ₹62,000. Due: rent ₹20,000 (Housing) on the 15th, an EMI of ₹12,000 on the 20th, a card bill of ₹8,000 on the 25th = ₹40,000. Set aside for goals ₹5,000. Budgets: Food and dining ₹800 left; Housing ₹20,000 left less the ₹20,000 rent = ₹0; Shopping overspent, ₹0. Safe to spend = 62,000 − 40,000 − 5,000 − 800 = **₹16,200**.

## Weekly digest

**Built on branch `weekly-digest`.** See the [design](../superpowers/specs/2026-11-13-weekly-digest-design.md). `GET /digest?week=` works out one week's summary when asked; nothing is stored.

- **The week** runs Monday to Sunday, India's dates. The default is the last whole week, and a Sunday counts as whole from 6 pm India time (the app's reminder goes out at 7 pm), so from Sunday 6 pm to the next Sunday 6 pm the default is the week ending that first Sunday. `week=YYYY-MM-DD` picks the week holding that date; `week=current` is this week so far. A week that hasn't started is refused.
- **Spent** uses exactly the [monthly cash flow](#monthly-cash-flow) rules (expenses plus EMI interest; income, transfers, EMI principal and trades are not spending) over the week's window: Monday to Sunday, or Monday to today for this week so far.
- **Usual** is the average spending of the 4 weeks before it, each over the same days (Monday to the same weekday when the week isn't whole), added up and divided by the number of weeks, rounded half up to the paisa. Only weeks ending on or after the user's first transaction count, so someone with 2 weeks of history is compared with those 2; with none, there's no usual figure and no comparison.
- **Difference** = spent − usual; its percent is `difference ÷ usual × 100`, rounded half up, with no percent when usual is 0. Within ±5% reads as "about the same as usual".
- **Top categories:** the three biggest spending groups of the week, subcategories rolled into their parents, with each one's share, as in the month report.
- **Budgets at risk** look at the month holding the week's last counted day, up to that day (the [budget](#monthly-budgets) figures for that window). An active budget is at risk when it is **over** (spent > budget) or **on pace to go over**:

  ```
  used    = spent ÷ budget
  elapsed = days counted ÷ days in the month
  on pace to go over  ⇔  the month isn't whole, 50% ≤ used < 100% and used > elapsed + 10 points
  projected = spent × days in the month ÷ days counted (rounded half up to the paisa)
  ```

  The 10-point margin lets normal day-to-day unevenness pass, the 50% floor keeps one early purchase from flagging a budget in the first days of a month, and a budget used exactly up (rent paid on the 1st, budget = rent) isn't "on pace": it is at its limit, not past it. **Known gap:** a one-off bill paid early that leaves a little of its budget (rent ₹19,000 of ₹20,000) reads as on pace until the month catches up; the digest shows the projection, so the reason is visible. A whole month (a week ending on its last day) has no "on pace", only over. Over budgets come first, then by percent used, highest first.
- **Due in the next 7 days:** the [next 30 days](#the-next-30-days) list cut to today + 7 days (always from today, whichever week is shown), overdue items included, with the same running balance. **Due total** adds the amounts of items with money going out.
- **Headline:** one sentence built from the figures above, e.g. "You spent ₹4,250 last week, ₹600 more than usual." It says "this week" for the current week, "last week" for the one before, and "in the week of 26 October" for older weeks; "So far this week you've spent ₹X, ₹Y less than usual by now." for this week so far; "You didn't spend anything last week." when nothing was spent; and no comparison when there's no usual figure.

Example, Monday 9 November 2026: the default week is 2–8 November. Spent ₹4,250 (groceries ₹3,000, an EMI's ₹1,250 interest; a ₹20,000 card payment and the EMI principal don't count). The four weeks before spent ₹3,000, ₹4,000, ₹3,800 and ₹3,800: usual ₹14,600 ÷ 4 = ₹3,650. Difference +₹600, +16%: "You spent ₹4,250 last week, ₹600 more than usual." Budgets look at November 1–8: 8 of 30 days, 26.67% elapsed; Food and dining ₹8,000 with ₹4,400 spent (55%) is on pace to go over (55 > 36.67 and ≥ 50), projected ₹16,500.

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
- **A moved SIP keeps its history.** A month is also settled by an unlinked, non-opening buy of the same fund from any account, so a SIP moved to another bank isn't asked for its old months again. The exception is a buy from the account of another active SIP of that fund, whose own months it belongs to. A buy linked to a SIP always settles that SIP's month.
- **The portfolio** reports stocks and funds separately (and crypto, see below), plus `overall`: the sum of the figures of all of them, with its percent worked out from the summed figures.

### Crypto rules

See the [crypto design](../superpowers/specs/2026-11-09-crypto-design.md). Coins use the same cost, value and FIFO rules as funds, with these differences.

- **Quantity has up to 8 decimals.** `investment_trades.quantity` was widened from `NUMERIC(18,3)` to `NUMERIC(24,8)`, which keeps every existing value exactly. Stocks and funds still show 0 and 3 decimals, and coins show 8.
- **`amount` is the entered figure.** It is the cost of a buy and the proceeds of a sell, as for funds. Exchange fees and TDS (1% on a sell) go in charges, so a buy's cost is what left the account and a sell's proceeds are what arrived after TDS.
- **The quantity × price check, on both sides.** Quantity × price must be within the tolerance of `amount − charges` on a buy, and of `amount + charges` on a sell. The tolerance is ₹1.00 or quantity × ₹0.00005, whichever is more, because a price has at most 4 decimals and rounding it can move quantity × price by up to quantity × ₹0.00005. A difference exactly equal to the tolerance passes. Example: 1 crore coins at ₹0.0012 is ₹12,000.00; with an amount of ₹12,345.60 and no charges the difference is ₹345.60, within the ₹500.00 tolerance. At ₹0.0010 it is ₹2,345.60 off and is refused.
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

## Recurring reminders and health insurance

**Built on branch `recurring-insurance`.** See the [design](../superpowers/specs/2026-11-10-recurring-and-insurance-design.md). A recurring template never posts anything. It works out which occurrences are due and which are coming up, and the owner records or skips each one.

### Occurrence rules

- An occurrence falls on the template's day each month (or on its day and month each year), clamped to the month's length, from its start date until its end date.
- **One payment settles one occurrence.** A transaction linked to the template settles the occurrence it matches, and each payment settles only one. A monthly payment matches the occurrence in the same calendar month, or an occurrence up to `remind_days` after it (the days it showed as coming up). A yearly payment matches an occurrence from `max(45, remind_days)` days before to 45 days after, so a premium paid a little early or late still counts for its year.
- Payments are matched oldest first. Of the occurrences a payment matches and that are still open, it settles the one in its own calendar month when there is one, otherwise the nearest (the earlier on a tie). A skipped occurrence never takes a payment. Example: rent on the 1st, remind 3 days, October already paid on 5 October; a payment on 30 October (recorded from "Coming up 1 Nov") settles 1 November. A lone payment on 15 October with October unpaid settles October, even with a long reminder.
- An occurrence is **due** when its date is on or before today, nothing settles it and it isn't skipped. It is **coming up** when it falls within the template's `remind_days` after today (3 days by default for monthly, 30 for yearly). A skipped occurrence shows nowhere.
- A stopped template is never due or coming up.
- **An archived account stops the reminder.** A template whose account (or, for a transfer, its other account) is archived is never due or coming up, because nothing can be recorded against it. A policy's reminder is the exception: an account that pays an active policy's premium can't be archived ("This account pays the {insurer} premium. Change the policy's paying account or lapse the policy first."), so only lapsing the policy stops its reminder.
- A policy's template follows the policy: only its name, note, `remind_days` and whether it is active can change on the reminder; everything else changes on the policy. A policy's reminder is stopped only by lapsing the policy (it cannot be stopped or skipped on the reminder), and a lapsed policy's reminder cannot be restarted.
- A late payment is dated the occurrence it settles, not the day it is entered, so the month it belongs to stays right.

### Card bill date

For a premium or other expense charged to a credit card: the bill is the first statement date on or after the charge, and the payment is due on the first due day strictly after that statement date. With a statement day of 20 and a due day of 8, a charge on 6 April is billed on 20 April and due on 8 May.

### Policy periods and the premium by financial year

Each paid renewal is a policy period linked to its payment transaction. A period that has a payment reads its premium and paid date from that transaction, so editing the transaction changes the period. Renewing is atomic: the period, the payment and the template's next date move together. Deleting the latest renewal's payment rolls the policy back one period. The premium by financial year (April to March) adds up the premiums of the periods by the financial year of the date paid, so a premium paid on 6 April 2026 belongs to FY 2026-27.

### Funding estimate

A policy can name an RD that is set aside to pay it. The estimate is the RD's maturity value (see RD interest above), shown with the maturity date. Once the maturity date is before today the server marks it `matured`, and the line says "matured" instead of "matures". It **covers** the premium when the estimate is at least the premium, and otherwise shows the shortfall. When the card bill falls due before the RD matures, the policy is flagged. The estimate is never added to a balance or to net worth, and insurance has no value in net worth.

## Goals

**Built on branch `goals`.** See the [design](../superpowers/specs/2026-11-11-goals-design.md). A goal is a label on money the owner already has. It never moves money, creates a transaction or holds an account, and the figures below are worked out when asked for.

### Goals never touch net worth

Net worth, `total_have` and `total_owe` are unchanged by goals. Money set aside for a goal is still in its bank, and a holding in a goal is still in the investments totals. Archiving or deleting a goal changes no balance.

### Saved and progress

```
saved    = earmarked money + holdings' current value
progress = saved ÷ target, rounded half up to a whole percent (it can pass 100%)
reached  = saved ≥ target
```

- **Earmarked money.** A goal's earmark in an account is the sum of its signed entries there (set aside is +, release is −). Only active bank, cash and wallet accounts can be used. A release can't take a goal's earmark in an account below zero. Entries are added and deleted, never edited, and deleting one is refused when a later release depends on it. Earmark changes on an archived goal are refused ("Restore this goal first."). Restoring a goal, and deleting a release, is refused while an account it has money set aside in is archived ("{account} is archived. Restore it first.").
- **Holdings.** A whole instrument (all units, any account) counts at market value from the latest recorded price, or at cost before one exists, as the portfolio shows it. A PPF or RD counts at its balance, never the interest estimate. A holding that is sold out counts as ₹0 and shows "sold"; a closed (archived) PPF or RD counts as ₹0 and shows "closed". A PPF or RD that is also an active policy's `funded_by` carries the note "Also funds the {insurer} premium."
- **One active goal per holding.** An instrument or account can be in at most one active goal, so the same money never counts twice. Archiving a goal deactivates its holdings; restoring it is refused if one has since joined another active goal.

### Months left and the monthly figure

With a target date, `months left` counts the current month through the target's month, so 30 Nov 2026 is 1 and a date in an earlier month is 0. If the target isn't reached and months left is above 0:

```
per month = ceil_to_rupee((target − saved) ÷ months left)
```

Example: Bike, target ₹1,20,000 by June 2027, ₹45,500 saved, viewed in November 2026. That is 38%, 8 months left, and (₹1,20,000 − ₹45,500) ÷ 8 = ₹9,312.50, which rounds up to **₹9,313 a month**. A goal is **overdue** when its date is before today and it isn't reached.

### The emergency fund

```
target           = ef_months × monthly expenses        (ef_months 1 to 24, default 6)
monthly expenses = the owner's override, if set
                 = otherwise the average of the last 6 full calendar months
```

- A month's expenses are every `expense` (any account, cards included) plus the **full amount of every EMI**, principal and interest. Transfers, investment trades, PPF and RD deposits and income (refunds included) don't count.
- The window ends before the current month. It starts no earlier than the month after the owner's first transaction, or that month itself only when the first transaction is dated the 1st, so a part-recorded month never pulls the average down. With fewer than 6 usable months the average is over those; with none there is no computed figure and no target until an override is set. A computed monthly figure of 0 (months in the window but no expenses or EMIs in them) counts as not enough history, so it is treated the same way. The average is rounded half up to paise.
- Example: ₹32,400 a month × 6 = **₹1,94,400**. Only one emergency fund can be active at a time.

### Free balance

`GET /accounts` keeps `balance` as the real balance, and adds two keys:

```
set_aside    = sum of active (not archived) goals' earmarks in the account
free_balance = balance − set_aside
```

A bank with ₹80,000 and ₹50,000 set aside has a free balance of **₹30,000**. Clients show `free_balance` as the headline. It goes negative when more is set aside than the account holds, and each goal with an earmark there shows a warning ("₹X more is set aside than {account} holds."). Nothing is released automatically. A PPF or RD in a goal also carries an `in_goal` tag.

Archiving an account that has money set aside is refused ("₹X of {account} is set aside for {goals}. Release it first."). Account archiving locks the account and its PPFs in id order, rereads the PPF ids under the lock and retries up to 3 times if they changed.

### Monthly reminder

A goal with a `monthly_amount` and a `reminder_day` (1 to 31, clamped to the month's length) is **due** from that day of the month until the positive set-aside entries dated in the current month add up to the amount. The amount asked for is the part still to set aside. It starts in the month the reminder was turned on, and it stops once the goal is reached or archived. Only the current month is ever due: a missed month doesn't pile up, and there is no Skip. Clearing `monthly_amount` turns the reminder off. Releases do not reduce what was set aside this month.

Goal reminders come under their own key, `goals_due` in `GET /recurring/due`, and never inside `items`, which older app versions read as templates.

## Dates

"Today" is India's date (UTC+05:30). Future-dated transactions are refused.

**Known gap.** The below-zero rule judges today's balance, not the balance on the transaction's date. A backdated expense can therefore be accepted even though the account would have been negative on that day. This is a deliberate simplification for now.
