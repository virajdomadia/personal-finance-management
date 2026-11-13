# Budgets, the next 30 days and safe to spend: design

## Why

Phase 3 of the [product review plan](../plans/2026-11-12-product-review-plan.md) fixes complaint 2:

| # | Complaint | Check that proves it's fixed |
|---|---|---|
| 2 | No budgets ("I can't say ₹8k a month on food and see when I've gone over") | Set Food and dining to ₹8,000. The dashboard and the month page show spent, remaining and a progress bar, and the category turns red once over. |

Phase 3 is done when the dashboard shows safe to spend and the next 30 days, and the numbers can be checked by hand from the breakdown.

Everything not decided by the plan was left to Claude ("do what's best"). Those calls are marked *my call* and listed at the end. The rules are in [financial-calculations.md](../../architecture/financial-calculations.md#budgets-the-next-30-days-and-safe-to-spend), written before the code.

## Budgets

### The table

`budgets` keeps one row per change, so editing this month never rewrites last month (*my call* on the shape):

| Column | Meaning |
|---|---|
| `id`, `user_id` | as everywhere |
| `category_id`, `kind` | the category; `(category_id, user_id, kind)` references `categories (id, user_id, kind)`, and `kind` is always `expense` (a check), so the database itself refuses another user's category or an income one |
| `effective_from` | the 1st of the month the row applies from |
| `amount` | `NUMERIC(14,2)`, above 0, or NULL for "no budget from this month" |
| `created_at`, `updated_at` | |

`UNIQUE (user_id, category_id, effective_from)`. The budget for a month is the row with the latest `effective_from` on or before that month.

- **Set** (create or change) writes the current month's row. If the month before already had the same amount, the row is dropped instead, so an undo leaves no trace.
- **Remove** writes a NULL row for the current month (or deletes the current month's row when nothing was in force before it).
- Past and future months can't be edited (*my call*): a budget is a plan for now. Past months show the budget that was in force then.

### Spent, and the category rollup

Spent comes from `app.api.cash_flow`: the same rows (`income`, `expense`, `emi` in the month's window), `spent()` and `grouped()` with the parent rollup. A budget on a top-level category reads that group's amount; on a subcategory, the child group's. No figure is re-derived, so a budget and the `/cash-flow` row for the same category always agree.

### Archived and merged categories (*my call*)

- **Archived:** the budget shows as inactive ("Archived"), with what was spent; it's left out of the total and of safe to spend. Setting is refused until the category is restored; removing works.
- **Merged:** the budget follows the merge to the target (read time, by `merged_into_id`), so merging Swiggy into Food and dining carries Swiggy's budget over when Food and dining has none. When the target has its own budget, the merged one shows as inactive ("Merged into Food and dining") in the current month; in an ended month its amount is added to the target's, so that month's total doesn't change. Setting or removing the target's budget also ends any budget that reached it by a merge. Nothing in the merge code changes, which keeps this branch clear of the category fixes on `cash-flow`.

### API

`GET /budgets?month=YYYY-MM` (default this month; a future month is refused like `/cash-flow`):

```
month, is_current, start, through
budgets: [{
  category_id, name, icon, colour, parent_id, parent_name,
  amount, spent, left, remaining, over_by, percent, bar, over,
  active, note,          # note: "Archived" / "Merged into X, which has its own budget"
  counted,               # in the total (a subcategory under a budgeted parent isn't)
  since                  # "YYYY-MM" the amount applies from
}]
total: { amount, spent, left, remaining, over_by, percent, bar, over }
unbudgeted: [{ category_id, name, icon, colour, parent_id, parent_name, spent }]   # live expense categories without a budget
```

Lines are ordered like the category pickers: each top-level category, then its subcategories. `PUT /budgets/{category_id}` `{amount}` sets from this month and returns the month's line; `DELETE /budgets/{category_id}` removes from this month. A bad category is 404; an income, archived or merged one is a 422 with a sentence.

## The next 30 days

`GET /upcoming` returns, from today to today + 30 days plus anything overdue:

```
start, through, starting_balance, ending_balance
items: [{
  date, kind,            # recurring | insurance | emi | sip | rd | card_bill | goal
  name, account_id, account_name,
  amount, varies,        # varies: a card bill with no statement yet, amount = owed now
  direction,             # out | in | none (none: on a card, a goal set-aside, a transfer within the group)
  overdue, balance_after,
  ref_id                 # the template, loan, SIP, RD, card or goal it belongs to
}]
```

Every kind reuses its existing due logic: recurring occurrence status (`app.api.recurring`, extended to look further ahead than the reminder days), SIP due months (`app.api.sips.load_due`), RD due months, the dashboard's card bill (now a list of every card's bill), goal reminders (`reminder_due`), and the loan's next EMI (`next_emi`) on its instalment day.

## Safe to spend

`GET /safe-to-spend`:

```
amount                 # can be negative
until, payday          # the last day counted; payday: {name, date} or null
reason                 # "salary" | "month_end"
note                   # "Today's salary isn't recorded yet." on payday before it is recorded, else null
money, due, goals, budgets                        # the four lines
money_items:  [{name, amount}]                    # each bank, cash and wallet account
due_items:    [{date, name, kind, amount, overdue, varies}]
goal_items:   [{name, amount}]                    # earmarks by goal
budget_items: [{category_id, name, remaining, due, amount}]   # due: bills already counted above
```

The formula and its edge cases are in financial-calculations.md. `amount = money − due − goals − budgets`.

## Clients

Each platform gets its own UI on the shared backend. Clients only format server figures and draw `bar`/`percent`.

**Website**
- **Budgets page** (`/budgets`, `?month=`): the total at the top; a row per budget with a progress bar (red when over), spent of budget, remaining or "over by", and a link to the transactions filtered by that category and month. Inline set/edit/remove for the current month; "Add a budget" picks from the unbudgeted categories (showing what each has spent). Past months are read-only with month navigation. Linked from the nav.
- **Month report** (`/cash-flow`): each spending category row with a budget shows a slim budget bar and "₹X of ₹Y", red when over. Fetched from `/budgets?month=` alongside the report.
- **Dashboard:** a "Safe to spend" card (the figure, payday, a "How this is worked out" disclosure listing each line and its items) and a "Next 30 days" card (the list with dates, amounts or "amount varies", and the balance after each). Two self-contained components, one line each in the dashboard.

**Android** (react-native-paper, chunky style, no new native modules)
- **Budgets screen** (`/budgets`): reached from the dashboard month card / month screen and from Profile. Chunky cards with thick progress bars, red when over; tapping one opens a sheet to change or remove the amount; "Add budget" lists unbudgeted categories.
- **Dashboard:** a Safe to spend card; tapping it opens the breakdown screen (`/safe-to-spend`).
- **Next 30 days screen** (`/upcoming`): reached from the dashboard card, a day-grouped list with the balance after each item.

## Non-goals

Rollover, budgets on income, weekly or yearly budgets, budget alerts and notifications (the weekly digest in Phase 5 covers "budgets at risk"), editing past months, predicting variable spending.

## Design calls made by Claude ("do what's best"), not yet confirmed by the owner

1. **Budgets are versioned by `effective_from` month**; every change applies from the current month; past and future months are read-only.
2. **A parent's budget includes its subcategories' spending**; with both budgeted, the total counts only the parent.
3. **Archived category → inactive budget; merged category → follows the merge** unless the target has its own budget.
4. **Overdue items count** in the next 30 days and in safe to spend: they're still owed.
5. **One card bill per card**: the unpaid statement, overdue until paid; or else what's owed now on the date it will fall due ("amount varies"). A card, loan or RD paid by a transfer reminder relies on that reminder.
6. **Payday is the earliest Salary income reminder after today**; items on payday itself are left to the salary; expected income is never counted. On payday before the salary is recorded, the window ends today.
7. **Budgets left subtracts the bills already counted in the same category**, so a rent reminder and a rent budget aren't taken twice.
8. **The running balance is the real balance** of bank, cash and wallet accounts; goal set-asides and card charges don't move it; same-day money out goes before money in.
9. **Safe to spend can be negative** and is shown as "₹X short".
10. **Separate endpoints** (`/budgets`, `/upcoming`, `/safe-to-spend`), so the dashboard response doesn't change while other branches change it.
11. **An item paid from an archived account** (not a card) is taken to come from a bank, and **no EMI is listed before the loan was added**.
