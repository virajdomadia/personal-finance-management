# Backend (FastAPI)

```bash
uv sync
uv run fastapi dev app/main.py   # http://localhost:8000/api/docs
uv run pytest
uv run ruff check .
```

## Tests on PostgreSQL

`uv run pytest` uses in-memory SQLite and skips the PostgreSQL-only tests. To run everything on PostgreSQL, point `TEST_DATABASE_URL` at a database whose name ends in `_test`. It's created if missing and wiped on every run.

```bash
npm run db:start   # from the repo root, if the local cluster isn't running
TEST_DATABASE_URL=postgresql+psycopg://pfm:<password>@localhost:5434/pfm_test uv run pytest
```

CI (`.github/workflows/backend.yml`) runs both. What the PostgreSQL tests cover is in [docs/architecture/testing.md](../docs/architecture/testing.md).

## Nightly prices

Vercel Cron calls `GET /api/cron/prices` every day at 18:00 UTC (23:30 IST), set in `vercel.json`. It sends `Authorization: Bearer <CRON_SECRET>`. Set `CRON_SECRET` (any long random string) on the Vercel project; while it is empty the endpoint stays closed. On the Hobby plan Vercel fires a daily cron at some point within the scheduled hour, so a run lands between 23:30 and 00:29 IST; crypto prices are stored under the run's date (IST), so a run after midnight files them under the next day.

The job reads AMFI `NAVAll.txt`, the NSE equity list and bhavcopy (today, then up to 3 earlier weekdays, then Yahoo for linked stocks) and CoinGecko for linked coins. It writes the shared `market_codes` table and copies prices to linked holdings, committing each source as it finishes (coins, then funds, then stocks), so a slow NSE that runs out the function's time loses only the stocks. NSE requests time out after 8 seconds; a timeout ends the bhavcopy lookback, and the Yahoo fallback stops once the stock step has run 45 seconds. Whatever was skipped is listed under `failed.stock` in the response. Coins are also refreshed when opened if last refreshed over 6 hours ago, or not priced yet. `COINGECKO_API_KEY` is optional.

To run it by hand:

```bash
uv run python -m app.cli refresh-prices
```

A local run takes about 6 seconds for around 14,000 fund NAVs and 2,600 stocks.

## Export, backup and restore

Each signed-in user can download their own data (read-only, never anyone else's):

- `GET /api/export/csv`: a zip with one CSV per entity (accounts, transactions, stock, fund and crypto trades, SIPs, loans, deposits, goals, insurance policies, recurring templates, budgets, categories). Human headers, names instead of ids, plain numbers (`1234.50`), ISO dates, UTF-8 with a BOM for Excel.
- `GET /api/export/backup`: the full JSON backup below.

### Backup format (version 1)

```json
{
  "format": "pfm-backup",
  "format_version": 1,
  "alembic_revision": "<the database's alembic_version>",
  "exported_at": "2026-11-13T10:15:00+00:00",
  "user": {"email": "me@example.com"},
  "tables": {"accounts": [{"id": 1, "name": "HDFC", "opening_balance": "1000.00"}]}
}
```

`tables` has every row the user owns, every column by name, except columns pointing at `users.id`. Decimals are strings, dates and times ISO 8601, JSON columns as stored.

The tables are found from the SQLAlchemy metadata (`app/export/tables.py`): every table with a `user_id` is included, a table without one is included when a foreign key ties it to a user's table, and `EXCLUDED` lists the rest with reasons (`users`: login identity; `market_codes`: shared market data). `tests/test_export_coverage.py` fails on any table that is neither, and on ids restore couldn't remap (a foreign key to an unexported table, an `_id` column that isn't a foreign key, a JSON column without an entry in `JSON_ID_FIELDS` in `app/export/backup.py`). So a new table with `user_id` is backed up automatically; a table that shouldn't be needs a line in `EXCLUDED`. `tests/export_fixture.py` must put a row in every exported table, or the restore test fails.

### Restore procedure

Restore is an admin step, done from a machine that can reach the database:

```bash
# A backup of one user (same file as the website's "Download backup")
uv run python -m app.cli export-user me@example.com backup.json

# Load it into a user (created if missing) who has no data yet
uv run python -m app.cli restore-user me@example.com backup.json

# Or replace that user's data: deletes it and loads the backup in one transaction
uv run python -m app.cli restore-user me@example.com backup.json --replace
```

- The database must be at the backup's schema revision (`alembic_revision`); otherwise restore refuses. Migrate an empty database to that revision (`uv run alembic upgrade <revision>`), restore, then `uv run alembic upgrade head`.
- Restore refuses a user who already has rows (categories are seeded on first sign-in) unless `--replace` is given.
- Every row gets a new id and every foreign key is remapped, so it works on a database with other users. Ids inside `sms_entries.candidates` are remapped too; choices pointing at rows no longer in the backup are dropped.
- Any error rolls the whole restore back.
- To restore production, point `DATABASE_URL` at it for the one command, and take a Neon branch first.
