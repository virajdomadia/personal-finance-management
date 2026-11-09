# Database design

PostgreSQL. Neon in production, a local cluster on port 5434 (`backend/.pgdata`) in development. SQLite only in backend tests. Schema changes go through Alembic.

## Principles

1. Every financial record belongs to a user, and every read and write checks ownership. Someone else's record behaves exactly like a missing one. Where records reference each other, they carry `user_id`, and composite foreign keys make a cross-user reference impossible.
2. Writes that move money run in one database transaction and lock the affected accounts in id order.
3. Ledger lines are append-only. Corrections are reversals ([ledger design](ledger-design.md)).
4. Valuations (prices, asset values, loan outstanding) are append-only and dated. The latest one is the current one.
5. Archiving (soft delete) is for things that can come back: accounts, categories, instruments, goals. Financial events are voided, never archived.
6. Money is never a float ([ADR-003](../decisions/ADR-003-money-representation.md)). Each money record has a currency, `INR` for now.
7. Important invariants are database constraints where PostgreSQL can express them (checks, foreign keys, unique keys), and tests plus `check-ledger` where it can't.
8. Material financial changes leave an audit row.

## Current schema (2026-11-08)

| Table | Columns that matter |
|---|---|
| `users` | `id`, `email`, `session_version` |
| `accounts` | `type` (`bank`, `credit_card`, `cash`, `broker`, `wallet`), `name`, `opening_balance NUMERIC(14,2)`, `institution`, `bank_kind`, `last4`, `credit_limit`, `statement_day`, `due_day`, `archived_at` |
| `transactions` | `type` (`income`, `expense`, `transfer`), `amount NUMERIC(14,2)` > 0, `date`, `account_id`, `to_account_id`, `category` text, `note` |

Indexes: `user_id`, `account_id` and `to_account_id` on transactions, and `user_id` on accounts.

## Audit of the current code against these principles

| Area | Finding | Severity | Action |
|---|---|---|---|
| Ownership | Every route filters by `user_id`. Another user's ids return 404 or "Choose an account." Covered by `test_another_users_*`. | OK | None |
| Concurrency | Account rows are locked `FOR UPDATE` in id order before balance checks. Checked by hand on PostgreSQL. | OK | Add a PostgreSQL integration test |
| Money type | `NUMERIC(14,2)` and `Decimal` end to end. Clients do no arithmetic. | OK | None |
| Balance math | Correct, and covered by 8 new invariant tests, including a seeded randomised run against a reference model. | OK | None |
| Test database | Tests run on SQLite, which stores numerics as floats. Code works around it by summing in Python, but SQL-side sums can't be tested. | Medium | Integer paise in the ledger. Run the suite on PostgreSQL in CI. |
| History | Edits overwrite, deletes are permanent, and a balance correction rewrites `opening_balance`. There is no audit trail. | High | Ledger: postings, reversals, void and adjustments |
| Opening date | Accounts have no `opening_date`, so past balances aren't defined. | High | Ledger: creation date, plus owner reconciliation of transactions dated earlier |
| Categories | Free text per transaction. Can't be renamed or budgeted reliably. | Medium | Managed categories as ledger accounts |
| Database constraints | `amount > 0`, transfer has `to_account_id`, income and expense have a category, and `to_account_id ≠ account_id` are enforced only in Python. | Medium | Add `CHECK` constraints |
| Indexes | No index on `transactions.date`. The list loads every match to compute totals. | Low now | Index `(user_id, date DESC, id DESC)`. Compute totals in SQL once amounts are integers. |
| Currency | Implicitly INR. | Low | Add `currency CHAR(3) DEFAULT 'INR'` with the ledger |

## Planned tables by domain

Named here so that later work fits. Each gets its own design doc before it's built, and only the ledger's tables are created now. A later domain that holds value (holdings, possessions) joins the ledger by adding a typed backing column to `ledger_accounts` (see the ledger design).

| Domain | Tables | Notes |
|---|---|---|
| Ledger | `categories`, `category_changes`, `ledger_accounts`, `transaction_changes`, `postings`, `journal_lines` | The only tables created with the ledger. Full schema in the [ledger design](ledger-design.md). |
| Accounts | add `opening_date`, `opening_date_source`, `currency` and a generated `ledger_kind` to `accounts`; type `loan` (built), `deposit` later | A credit card stays one account, which is also its liability ledger account. There is never a second record of the same balance. |
| Budgets | `budgets` (category, period, amount) | Spending comes from expense ledger lines |
| Recurring | `recurring_templates` | Reminds and pre-fills. Never posts on its own. |
| Assets | `assets`, `asset_valuations` | Purchase date and value, ownership %, dated valuations |
| Investments | **Built as the general model (2026-11-09), with stocks and mutual funds:** `instruments` (kind `stock` or `mutual_fund`), `investment_trades`, `instrument_prices` (a NAV for a fund) and `sips`. The stock tables were migrated into it, and every stock row and figure is unchanged. Each trade stores its `amount`, the source of truth for money. `investment_lots` is not built: lots are derived. | Holdings and cost basis are derived from trades by FIFO, never stored. See the [stocks design](../superpowers/specs/2026-11-08-stocks-design.md) and the [mutual funds design](../superpowers/specs/2026-11-09-mutual-funds-design.md). |
| Liabilities | **Built (2026-11-08):** loan columns on `accounts` (`interest_rate`, `emi_amount`, `emis_at_opening`, `pay_from_id`) and `transactions.interest` | Each loan is a liability account. An EMI is one `emi` transaction: principal against the loan, interest to spending. See the [loans design](../superpowers/specs/2026-11-08-loans-design.md). |
| Deposits | **Built (2026-11-09):** `accounts` gains `opened_on` (date), `deposit_amount` (the RD instalment), `tenure_months` and `deposits_at_opening` (RD instalments paid before the app's own transfers). It reuses `interest_rate`, `due_day` and `pay_from_id`. Types `ppf` and `rd`. | A PPF or RD is an account. Deposits, interest and withdrawals are ordinary transfers and income. Maturity and interest estimates are computed, never stored. See the [deposits design](../superpowers/specs/2026-11-09-deposits-design.md). |
| Goals | `goals`, `goal_contributions` | A goal points at existing accounts. It never holds money itself. |
| Intelligence | `net_worth_snapshots` (date, assets, liabilities, net worth, breakdown JSON, recorded_at) | Preserves what was known at the time. Past balances can always be recomputed from the ledger as well. |
