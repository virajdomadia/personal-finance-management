# Transactions: design

## Why

Accounts hold balances that only change when edited by hand. Transactions make balances follow what actually happens: money earned, spent, and moved between the owner's own accounts.

## Decided with the owner

- Three types: **income**, **expense**, and **transfer**. Income and expense carry a category.
- A transfer moves money between the owner's own accounts and counts as neither income nor spending. Paying a card bill is a transfer from a bank to the card, not its own feature. A card purchase counts as spending once, when it's made.
- Each transaction records an amount, date, account, and optional note.
- An account's balance is its opening balance plus or minus its transactions:

| Transaction | Bank, cash, wallet, broker | Credit card (balance = owed) |
|---|---|---|
| Expense | Down | Up |
| Income or refund | Up | Down |
| Transfer in | Up | Down |
| Transfer out | Down | Up |

- Correcting an account's balance is still allowed. It changes the opening balance so the current balance lands on the entered figure, and transactions stay as they are.
- Cash and wallets can't be taken below zero. The save is refused with a message.
- An archived account's transactions are kept. New ones can't be added to it until it's restored.
- Build backend, website, deploy and test on production, and only then the Android app.
- The owner left the rest to the builder ("build with what's best") and will improve the UI later.

## Non-goals

Budgets, recurring transactions, reports and charts, statement import, splitting one transaction across categories, tags, attachments, multiple currencies, and search. The dashboard shows no transaction figures yet, though its balances follow transactions.

## Backend

`transactions` table: `id`, `user_id`, `type`, `amount` as a positive `NUMERIC(14, 2)`, `date`, `account_id`, `to_account_id` (transfers only), `category` (income and expense only), `note`, timestamps. Balances are never stored; `app/api/balances.py` computes them.

| Method and path | Purpose |
|---|---|
| `GET /api/transactions` | Newest first. Filters: `account_id` (either side of a transfer), `type`, `month=YYYY-MM`. Pages with `limit` (default 50, max 200) and `offset`. Returns `transactions`, `has_more`, and `total_income` and `total_expense` over every match. |
| `POST /api/transactions` | Create. Returns 201. |
| `GET /api/transactions/categories` | `income` and `expense`: the default list plus what the user has typed. |
| `GET /api/transactions/{id}` | One transaction, for the Android edit screen. |
| `PATCH /api/transactions/{id}` | Partial update. `type` can't change. |
| `DELETE /api/transactions/{id}` | Permanent. Returns `{"id": n}`. |

Each transaction in a response carries `account_name`, `to_account_name`, and `editable` (false once a linked account is archived), so clients need no second lookup.

Rules:

- Writes lock the affected account rows in id order, so the below-zero check holds under concurrent saves and two opposite transfers can't deadlock. SQLite ignores the lock, so this was checked by hand on PostgreSQL.
- Field problems return 422 with `loc: ["body", <field>]`. A change that would take a balance below zero or past the maximum reports on `amount`.
- Someone else's account is reported the same as a missing one (`Choose an account.`). Someone else's transaction is a 404.
- Changing or deleting a transaction linked to an archived account is a 409. So is a delete that would take cash or a wallet below zero.

## Web

`/transactions`, linked from the sidebar and from a "Transactions" action on each account row (`/transactions?account=<id>`). Month navigation, account and type filters, income and spent totals, a list grouped by date, "Load more", and add and edit in a dialog. After saving, the view moves to the transaction's month so it doesn't seem to vanish.

## Android (next, after production is tested)

Follows the website, with its own Material screens per the accounts design: a Transactions tab between Accounts and Profile, a floating add button, pull to refresh, and a full-screen form. Open transactions for one account from the account screen. Add `DELETE` to `src/lib/api.ts`.

## Design calls made by Claude, not yet confirmed by the owner

- **Categories are text with a default list**, not a managed table. Typing a new name adds it, and a different capitalisation of a known name uses the known spelling. Renaming and removing categories can come later without losing data.
- One category per transaction.
- A transaction's type can't change after saving; delete and re-add instead.
- Transactions can be permanently deleted, after a confirmation. Accounts remain archive-only.
- Future dates are refused, judged on India's date.
- The below-zero rule looks only at the current balance, so a backdated expense is judged by today's balance, not the balance on that date.
- A correction can be refused if it would need an opening balance past the column's maximum.
- A refund is recorded as income, so it counts in that month's income rather than reducing spending.
- A transfer's sign in a list shows only when one account is being viewed.
- A transaction on an archived account shows "Archived" in place of Edit and Delete.
