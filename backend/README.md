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

Vercel Cron calls `GET /api/cron/prices` every day at 18:00 UTC (23:30 IST), set in `vercel.json`. It sends `Authorization: Bearer <CRON_SECRET>`. Set `CRON_SECRET` (any long random string) on the Vercel project; while it is empty the endpoint stays closed.

The job reads AMFI `NAVAll.txt`, the NSE equity list and bhavcopy (today, then up to 3 earlier weekdays, then Yahoo for linked stocks) and CoinGecko for linked coins. It writes the shared `market_codes` table and copies prices to linked holdings. Coins are also refreshed when opened if last refreshed over 6 hours ago, or not priced yet. `COINGECKO_API_KEY` is optional.

To run it by hand:

```bash
uv run python -m app.cli refresh-prices
```

A local run takes about 6 seconds for around 14,000 fund NAVs and 2,600 stocks.
