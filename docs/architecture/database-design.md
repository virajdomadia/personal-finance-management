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
| `recurring_templates` | `name`, `type`, `amount NUMERIC(14,2)`, `account_id`, `to_account_id`, `category`, `note`, `frequency` (`monthly`, `yearly`), `day`, `month`, `start_date`, `end_date`, `remind_days`, `active` |
| `recurring_skips` | `template_id`, `occurrence` date, unique on the pair |
| `insurance_policies` | `kind`, `insurer`, `plan`, `policy_number`, `insured`, `sum_insured`, `period_start`, `period_end`, `premium`, `template_id` (unique), `funded_by_id` (an RD account), `details`, `active` |
| `policy_periods` | `policy_id`, `period_start`, `period_end`, `premium`, `sum_insured`, `paid_on`, `transaction_id` (unique, the payment) |

`transactions` also has `recurring_template_id` (nullable), which links a payment to the template it settles. The four tables above were added on branch `recurring-insurance`.

Indexes: `user_id`, `account_id` and `to_account_id` on transactions, and `user_id` on accounts.

### Goals tables

Added on branch `goals`, in one migration that refuses to downgrade while any of the three has a row.

| Table | Columns that matter |
|---|---|
| `goals` | `user_id`, `name` (60), `kind` (`custom`, `emergency`), `target_amount NUMERIC(14,2)` (null for the emergency fund), `target_date`, `ef_months`, `ef_monthly_override`, `monthly_amount`, `reminder_day`, `reminder_start` (the 1st of the month the reminder was turned on), `note` (200), `archived_at` |
| `goal_earmarks` | `user_id`, `goal_id`, `account_id`, `amount NUMERIC(14,2)` signed (+ set aside, − release), `date`, `note`. Append-only: entries are added and deleted, never edited. |
| `goal_holdings` | `user_id`, `goal_id`, `instrument_id` or `account_id` (a PPF or RD), `active` (false while the goal is archived) |

Constraints and indexes:

- `uq_goals_one_emergency`: unique on `user_id` where `kind = 'emergency' AND archived_at IS NULL`, so a user has at most one active emergency fund.
- `uq_goal_holdings_active_instrument` and `uq_goal_holdings_active_account`: unique on `instrument_id` and on `account_id` where `active`, so an instrument or account is in at most one active goal.
- `goal_holdings`: a check that exactly one of `instrument_id` and `account_id` is set.
- `goal_earmarks`: a check that `amount <> 0`.
- Indexes on `goals.user_id`, `goal_earmarks.goal_id` and `account_id`, and `goal_holdings.goal_id`.
- Deleting a goal is allowed only with no earmark entries (its holdings go with it); otherwise archive it.

### Market prices tables and columns

Added on branch `automation`, in migration `c7e2a95d1b48`.

| Table | Columns that matter |
|---|---|
| `market_codes` | `kind` (`mutual_fund`, `stock`, `crypto`), `code` (AMFI scheme code, NSE symbol or CoinGecko id), `name` (160), `isin`, `price NUMERIC(14,4)`, `price_date`, `updated_at`. Shared by all users, not per user. |

- `market_codes` is unique on (`kind`, `code`) and indexed on (`kind`, `name`) for search.
- `instruments.source_code` (nullable, 40) links a holding to a `market_codes.code`. Unlinked holdings stay manual.
- `instrument_prices.source` (10) is `manual` or `auto`, default `manual`. A typed price for the same date always wins over an automatic one.
- Automatic price rows are removed when the linked stock or fund is deleted.

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
| Accounts | add `opening_date`, `opening_date_source`, `currency` and a generated `ledger_kind` to `accounts`; types `loan`, `ppf` and `rd` (built; see the Deposits row) | A credit card stays one account, which is also its liability ledger account. There is never a second record of the same balance. |
| Budgets | `budgets` (category, period, amount) | Spending comes from expense ledger lines |
| Recurring | `recurring_templates` | Reminds and pre-fills. Never posts on its own. |
| Assets | `assets`, `asset_valuations` | Purchase date and value, ownership %, dated valuations |
| Investments | **Built as the general model (2026-11-09), with stocks and mutual funds:** `instruments` (kind `stock`, `mutual_fund` or `crypto`), `investment_trades`, `instrument_prices` (a NAV for a fund, a price for a coin) and `sips`. The stock tables were migrated into it, and every stock row and figure is unchanged. Each trade stores its `amount`, the source of truth for money. `investment_lots` is not built: lots are derived. | Holdings and cost basis are derived from trades by FIFO, never stored. See the [stocks design](../superpowers/specs/2026-11-08-stocks-design.md) and the [mutual funds design](../superpowers/specs/2026-11-09-mutual-funds-design.md). Crypto is built on branch `crypto`: `investment_trades.quantity` widened to `NUMERIC(24,8)`, coins are instruments of kind `crypto` traded through broker accounts, and the [crypto design](../superpowers/specs/2026-11-09-crypto-design.md) has the details. |
| Liabilities | **Built (2026-11-08):** loan columns on `accounts` (`interest_rate`, `emi_amount`, `emis_at_opening`, `pay_from_id`) and `transactions.interest` | Each loan is a liability account. An EMI is one `emi` transaction: principal against the loan, interest to spending. See the [loans design](../superpowers/specs/2026-11-08-loans-design.md). |
| Deposits | **Built (2026-11-09):** `accounts` gains `opened_on` (date), `deposit_amount` (the RD instalment), `tenure_months` and `deposits_at_opening` (RD instalments paid before the app's own transfers). It reuses `interest_rate`, `due_day` and `pay_from_id`. Types `ppf` and `rd`. | A PPF or RD is an account. Deposits, interest and withdrawals are ordinary transfers and income. Maturity and interest estimates are computed, never stored. See the [deposits design](../superpowers/specs/2026-11-09-deposits-design.md). |
| Goals | **Built on branch `goals`:** `goals`, `goal_earmarks`, `goal_holdings` (see Goals tables above) | A goal points at existing accounts and holdings. It never holds money itself, creates no transaction and doesn't touch net worth. See the [goals design](../superpowers/specs/2026-11-11-goals-design.md). |
| Intelligence | `net_worth_snapshots` (date, assets, liabilities, net worth, breakdown JSON, recorded_at) | Preserves what was known at the time. Past balances can always be recomputed from the ledger as well. |
