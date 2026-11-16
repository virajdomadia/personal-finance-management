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

## Net worth snapshots

After the prices, the same nightly job writes each user's net worth snapshot for that evening's date (IST): the dashboard's net worth, have, owe and asset split, one row per user per date, replaced if the job runs again that date. The response's `snapshots` is how many were written. A run that starts after midnight still files the snapshot under the evening it was meant for (India time minus 3 hours). The first `GET /api/net-worth` of a day also writes the user's snapshot if there is none yet. The rules are in [financial calculations](../docs/architecture/financial-calculations.md#net-worth-over-time).

To estimate the 12 month-ends before snapshots began, from transactions (investments left out, rows marked estimated):

```bash
uv run python -m app.cli backfill-net-worth              # every user
uv run python -m app.cli backfill-net-worth me@gmail.com --months 6
```

It never replaces a real snapshot and can be re-run.

## Export, backup and restore

Each signed-in user can download their own data (read-only, never anyone else's):

- `GET /api/export/csv`: a zip with one CSV per entity (accounts, transactions, stock, fund and crypto trades, SIPs, loans, deposits, goals, insurance policies, recurring templates, budgets, categories, net worth history). Human headers, names instead of ids, plain numbers (`1234.50`), ISO dates, UTF-8 with a BOM for Excel.
- `GET /api/export/xlsx`: the same tables as one Excel workbook, one sheet each (`app/export/xlsx.py`). Money, quantities and dates are typed cells; every text cell is stored as text, never a formula, and digits with a leading zero (a card's last 4) stay text.
- `GET /api/export/backup`: the full JSON backup below, as compact JSON gzipped (`pfm-backup-<date>.json.gz`, `application/gzip`). Gzipped, a backup has plenty of headroom under Vercel's 4.5 MB response limit: 15,000 synthetic rows of prices, SMS and transactions are 2.6 MB of JSON but 0.38 MB gzipped (a test keeps it under 1.5 MB). Each download logs both sizes.

### Importing transactions from Excel

`app/export/importing.py`, routes in `app/api/routes/imports.py`. The request body is the raw `.xlsx` file (up to 4 MB, 2000 rows).

- `GET /api/import/transactions/template`: a Transactions sheet (Date, Type, Amount, Account, To account, Category, Interest, Note) with dropdowns for type, the user's accounts and categories, and a "How to fill" sheet.
- `POST /api/import/transactions/preview`: every row checked, nothing saved. Returns each row with `status` `ok`, `duplicate` or `error` and its messages.
- `POST /api/import/transactions`: saves every `ok` row, or nothing if any row is in error.

Columns are found by header name, so the Transactions sheet of the Excel export loads back in. Accounts are matched by name, ignoring case. Each row goes through the same rules as a transaction typed in by hand, and the below-₹0 check runs row after row. A row with the same date, type, amount and accounts as a saved transaction is a duplicate and is skipped, so importing a file twice adds nothing. A preview never creates a category; the import creates a new category for a new name, as typing one in does. Imported rows have `source = "import"`, and the SMS reader links an SMS to them like a typed-in transaction (`TYPED_SOURCES` in `app/sms/ingest.py`).

### Importing holdings from Excel

`app/export/holdings_import.py`, routes in `app/api/routes/holdings_import.py`. For stocks, mutual funds and crypto you already own. Same body, limits and report as the transactions import.

- `GET /api/import/holdings/template`: a Holdings sheet (Type, Name, Symbol, Account, Quantity, Average price, Invested, Date, Market code) with dropdowns for type and the user's bank and broker accounts, and a "How to fill" sheet.
- `POST /api/import/holdings/preview` and `POST /api/import/holdings`: as for transactions. Each row also reports `invested`, the amount that will be stored.

Each row is what adding an existing holding by hand makes: the stock, fund or coin, unless one of that kind already matches (stocks and coins by symbol; funds by symbol if given, else by name, ignoring case), plus an opening buy that moves no cash. Rows go through the same request bodies and save checks as the forms (`StockCreate`/`FirstTrade`, `FundCreate`/`FirstFundTrade`, `CoinCreate`/`FirstCryptoTrade`), so the messages are the same, named by column. Stocks and crypto need a broker account, funds a bank account. Give the average price or the amount invested; if both, they must agree within ₹1 (or quantity × ₹0.005). A stock stores the average price rounded to paise; a fund or coin stores the amount invested (or quantity × average price) and its average works out from that. A blank date means today. A market code is checked against `market_codes` and links a holding the row creates; an existing holding's link is left alone. Two rows for the same new holding create it once. A row matching a saved opening buy (same holding, account, quantity, date and amount) is a duplicate and is skipped.

### Importing a bank or card statement (any bank)

`app/export/statement_files.py` turns the file into rows: CSV (any delimiter, UTF-8 or Windows encodings), `.xlsx`, old `.xls` (`xlrd`), the HTML some banks save with an `.xls` name, and PDF (`pdfplumber`; ruled tables, else columns lined up by word position). A locked PDF's password comes in the `X-File-Password` header, never the URL. `app/export/statements.py` finds the header row in the first 60 rows by the names banks use (Txn Date / Value Date, Narration / Particulars, Withdrawal / Debit, Deposit / Credit, or one Amount with a Dr/Cr column or suffix), reads day-first dates in every common shape, joins a narration wrapped onto the next row, and skips opening balances, totals and footers.

- `POST /api/import/statement/preview?account_id=…`: the file as the body. Saves nothing. Each line comes with the payee pulled out of the narration, a suggested type and category (the owner's payee rules, then the built-in merchant list for money out, or Salary / Interest / Dividends / Refund words for money in), a suggested transfer when the narration names another of the owner's accounts by its last 4 digits (or a card statement's "payment received"), and `duplicate` when the account already has a movement in the same direction and amount within a day. A locked PDF returns 422 with `needs_password` (and `wrong_password`).
- `POST /api/import/statement`: the lines the owner kept, as edited (JSON). Each goes through the same rules as a transaction typed in by hand, uncategorised allowed as for an SMS, with the below-₹0 check row after row; all are saved or none. `remember` on a line makes its category or transfer the payee's rule. Rows have `source = "statement"`.

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

The tables are found from the SQLAlchemy metadata (`app/export/tables.py`): every table with a `user_id` is included, a table without one is included when a foreign key ties it to a user's table, and `EXCLUDED` lists the rest with reasons (`users`: login identity; `market_codes`: shared market data). `tests/test_export_coverage.py` fails on any table that is neither, and on ids restore couldn't remap (a foreign key to an unexported table, an `_id` column that isn't a foreign key, a foreign key to something other than a primary key outside `COPIED_KEY_COLUMNS`, a JSON column without an entry in `JSON_ID_FIELDS` in `app/export/backup.py`). So a new table with `user_id` is backed up automatically; a table that shouldn't be needs a line in `EXCLUDED`. `tests/export_fixture.py` must put a row in every exported table, or the restore test fails.

### Restore procedure

Restore is an admin step, done from a machine that can reach the database:

```bash
# A backup of one user (.json.gz gives the website's gzipped file; .json plain JSON)
uv run python -m app.cli export-user me@example.com backup.json.gz

# Load it into a user (created if missing) who has no data yet
uv run python -m app.cli restore-user me@example.com pfm-backup-2026-11-13.json.gz

# Or replace that user's data: deletes it and loads the backup in one transaction
uv run python -m app.cli restore-user me@example.com backup.json --replace
```

- The database must be at the backup's schema revision (`alembic_revision`); otherwise restore refuses. Migrate an empty database to that revision (`uv run alembic upgrade <revision>`), restore, then `uv run alembic upgrade head`.
- Restore refuses a user who already has rows (categories are seeded on first sign-in) unless `--replace` is given.
- `restore-user` reads `.json` and `.json.gz` alike (it looks at the file's first bytes), and checks the shape first: `tables` an object of lists of objects, each with a whole-number `id` unique in its table.
- Every row gets a new id and every foreign key is remapped, so it works on a database with other users. Each table goes in as one batch, in the backup's id order. A row that points at another row of its own table (a loan's pay-from account, a category's parent) goes in with that link empty and gets it once every row exists, so the order holds and two rows may point at each other. The exception is a link a partial unique index depends on (a merged category frees its name): those rows wait for their target.
- Ids inside `sms_entries.candidates` are remapped too; choices pointing at rows no longer in the backup are dropped. A `market` choice carries its market kind and code, and restore finds that code in this database's `market_codes` (dropping the choice when it isn't listed).
- Any error rolls the whole restore back.
- To restore production, point `DATABASE_URL` at it for the one command, and take a Neon branch first.
