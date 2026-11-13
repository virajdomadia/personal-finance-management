# Export, backup and restore: design

## Why

Phase 1 of the [product review plan](../plans/2026-11-12-product-review-plan.md) fixes complaint 9:

| # | Complaint | Check that proves it's fixed |
|---|---|---|
| 9 | Can't get my data out | Website: download all data as CSVs and a JSON backup. App: share sheet export. A backup restored into a fresh database gives identical balances, net worth and portfolio totals (a CI test). |

Everything not decided by the plan was left to Claude ("do what's best"). Those calls are marked *my call* and listed at the end. No migration.

## The JSON backup

`GET /api/export/backup` returns one document, downloaded as `pfm-backup-YYYY-MM-DD.json`:

```json
{
  "format": "pfm-backup",
  "format_version": 1,
  "alembic_revision": "2d46fef3dab4",
  "exported_at": "2026-11-13T10:15:00+00:00",
  "user": {"email": "me@example.com"},
  "tables": {"accounts": [{"id": 1, "name": "HDFC", "opening_balance": "1000.00", ...}], ...}
}
```

- Every column of every row the user owns, keyed by column name. Decimals are strings (`"1234.50"`), dates and times ISO 8601, JSON columns as they are. Columns that point at `users.id` (`user_id`) are left out: restore sets them.
- `alembic_revision` is the database's `alembic_version` (null on a database built without Alembic, such as the SQLite tests).
- Read-only: export never writes.

### Which tables (generic)

The tables come from `Base.metadata`, not a hand-written list, in `app/export/tables.py`:

1. **Owned directly:** every table with a `user_id` column. Rows are `WHERE user_id = :me`.
2. **Owned through a parent:** a table without `user_id` whose foreign key points at an owned table. Rows are those whose parent row is the user's. None exist today; the code handles them so a future child table needs nothing.
3. **Excluded, with a reason:** `EXCLUDED` in `app/export/tables.py`.
4. Anything else is **unclassified**, and the coverage test fails.

So a new table with `user_id` (for example `net_worth_snapshots` from the net-worth branch) is backed up without any change (*my call*: auto-include rather than an explicit allow list, because silently missing data is the failure the owner complained about).

Today's decisions:

| Table | Decision | Reason |
|---|---|---|
| accounts, transactions, categories, budgets | exported | the ledger |
| instruments, investment_trades, instrument_prices, sips | exported | holdings; `instrument_prices` are per user (manual and nightly prices on the user's instruments) |
| recurring_templates, recurring_skips | exported | reminders |
| insurance_policies, policy_periods | exported | policies |
| goals, goal_earmarks, goal_holdings | exported | goals |
| sms_entries, payee_rules, account_identifiers, sms_samples | exported | the user's own SMS history and rules (*my call*: samples hold raw unparsed message text; it is the user's data and the file goes only to them) |
| users | excluded | login identity (Google id, session version); restore targets an existing or new user by email |
| market_codes | excluded | shared public market data, the same for every user, refreshed nightly |

### The coverage test

`tests/test_export_coverage.py` fails when:

- a table in the metadata is neither exported nor excluded with a reason;
- an exported table has a foreign key to a table that is neither exported nor `users` (restore couldn't remap it);
- an exported column ends in `_id` but isn't part of a foreign key (an id restore wouldn't remap);
- an exported JSON column has no entry in `JSON_ID_FIELDS` (ids hidden in JSON);
- the rich restore fixture has no rows in an exported table (restore isn't proven for it).

## Restore

`uv run python -m app.cli restore-user <email> <backup.json> [--replace]`, and `export-user <email> <out.json>`.

- **Revision check:** refuses when the backup's `alembic_revision` differs from the database's: "This backup was made at schema revision X but the database is at Y. Restore it into a database migrated to X (alembic upgrade X), then upgrade." Also refuses an unknown `format` or a newer `format_version`, and tables the code doesn't know.
- **Target user:** created when the email has no user yet (*my call*: restoring into a fresh database shouldn't need `create-user` first).
- **Empty check:** refuses when the user already owns any row (categories are seeded on first visit, so the message names the tables and suggests `--replace`). `--replace` deletes the user's rows (children first) and loads the backup in one transaction; any error rolls everything back.
- **Remapping:** tables are inserted in foreign-key order (`metadata.sorted_tables`); within a table, rows go in id order except that a row pointing at another row of the same table (accounts' `pay_from_id`, categories' `parent_id` and `merged_into_id`) waits for that row. Each insert gets a new id from the database; every foreign key column, including composite ones like `budgets (category_id, user_id, kind)`, is mapped through the old→new map, and `user_id` becomes the target user. A foreign key to a row missing from the backup refuses the restore, so a crafted file can't point at another user's rows.
- **Ids in JSON:** `sms_entries.candidates` holds `{"kind", "id"}` choices. After the inserts they are remapped by kind (`transaction`, `account`, `emi` → accounts, `sip`, `template`, `stock` → instruments); `market` points at the shared `market_codes` and is kept. A choice whose row isn't in the backup is dropped.

## CSV export

`GET /api/export/csv` returns `pfm-export-YYYY-MM-DD.zip` with one CSV per entity: accounts, transactions, stock_trades, fund_trades, crypto_trades, loans, deposits, goals, insurance_policies, recurring_templates, budgets, categories, sips. Human headers ("To account", "EMIs left"), names instead of ids, plain numbers (`1234.50`, no ₹ or Indian grouping), ISO dates, UTF-8 with a BOM so Excel reads ₹ and Hindi names. Balances and loan/deposit figures come from the same functions the accounts list uses.

## Website

A **Your data** page at `/data`, linked from the sidebar footer near sign-out: two buttons (Download backup (JSON), Download spreadsheets (CSV zip)) through the `/api` proxy with the session cookie, and one line: restoring a backup is done by the owner with `restore-user` on the server.

## App

Profile gets **Export my data**: a dialog with two choices (Spreadsheets (CSV zip), Full backup (JSON)); the file is downloaded with the bearer token into the cache directory with `expo-file-system` and handed to the Android share sheet with `expo-sharing`. Both are new native modules, so they need a new build (device-check list).

## My calls

- Auto-include every `user_id` table; exclusions are explicit with reasons.
- `sms_samples` exported.
- Restore creates the user if missing; refuses non-empty users without `--replace`.
- Candidate choices pointing at deleted rows are dropped on restore.
- The backup keeps `created_at`/`updated_at` as they were.
- CSV for SIPs too, beyond the plan's list.
- The website page lives at `/data` in the sidebar footer; the app puts export in a Profile row with a choice dialog.
