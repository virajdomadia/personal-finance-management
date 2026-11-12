# Nightly Prices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fund NAVs, stock closing prices and crypto prices fill themselves in every night (and crypto also on open), with no typing.

**Architecture:** A nightly Vercel Cron call hits a secret-protected endpoint. It fetches each public source once into a shared `market_codes` table (one row per fund, stock or coin, with its latest price). It then copies those prices into each user's `instrument_prices` for instruments the user has linked to a code. A price the user typed for the same day always wins. Parsing is pure and fixture-tested, and network access sits behind one small fetcher so tests never touch the internet.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, PostgreSQL (Neon) / SQLite in tests, httpx, Vercel Cron, Next.js website, Expo app.

**Spec:** `docs/superpowers/specs/2026-11-12-automation-design.md`, section 7 ("Prices every night") and the price lines of section 8. This plan covers prices only. SMS work is in later plans.

## Global Constraints

- Money and prices are `Decimal` / `NUMERIC` end to end. Fetched prices are rounded to 4 decimals with `ROUND_HALF_UP` to fit `instrument_prices.price` (`Numeric(14,4)`). No float ever touches a stored price; parse source text straight to `Decimal`.
- A price the user typed (`source = "manual"`) is never overwritten or deleted by the job.
- A failed or empty source never deletes or zeroes anything. The last price stays and shows its date.
- Run time: 23:30 IST = cron `30 18 * * *` (UTC).
- Crypto refresh-on-open threshold: 6 hours.
- The cron endpoint is protected by `CRON_SECRET` (Vercel sends `Authorization: Bearer <CRON_SECRET>`). If `cron_secret` is empty, the endpoint always refuses. The **owner sets** `CRON_SECRET` on the `personal-finance-api` Vercel project; Claude never sets Vercel variables.
- The migration is **run on Neon by the owner before merge** (merge auto-deploys). The PR description must say so in its first line.
- Website and app each get their own UI, following the existing Gullak chunky style. No copied layouts.
- Sources: AMFI `https://portal.amfiindia.com/spages/NAVAll.txt`; NSE equity list `https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv`; NSE bhavcopy `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{YYYYMMDD}_F_0000.csv.zip`; Yahoo fallback `https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}.NS`; CoinGecko `https://api.coingecko.com/api/v3/simple/price` and `/search`. Send a generic browser-like `User-Agent` and no personal details.
- Lint, type checks and tests for all three parts pass: `npm run lint && npm test` at the repo root.

## Review Focus

1. **AMFI lines with `N.A.`, blank NAVs, section headers or a bad date** are skipped, never stored as 0. Pinned in Task 2.
2. **A weekend or holiday has no bhavcopy (404)**: stocks keep the last price, Yahoo is tried, and funds and crypto still update. Pinned in Task 4.
3. **The user types a price the same day the job already wrote one**: the typed price is what the portfolio shows, and a later job run doesn't touch either row. Pinned in Task 4.
4. **One source raises (timeout, HTML error page, bad zip)**: the other sources still apply, and the report lists the failure. Pinned in Task 4.
5. **The cron URL is called with no secret, a wrong secret, or while `cron_secret` is unset**: 401 every time. Pinned in Task 5.

---

### Task 1: Schema for source links and market codes

**Files:**
- Create: `backend/migrations/versions/2026_11_12_1200-<rev>_add_market_prices.py`
- Create: `backend/app/models/market.py`
- Modify: `backend/app/models/investment.py` (Instrument, InstrumentPrice), `backend/app/models/__init__.py`
- Test: `backend/tests/test_market_models.py`, and extend `backend/tests/test_pg_migrations.py` the way earlier migrations are covered there

**Interfaces:**
- Produces:
  - `Instrument.source_code: Mapped[str | None]` (`String(40)`): an AMFI scheme code for a fund, an NSE symbol for a stock, or a CoinGecko id for a coin.
  - `InstrumentPrice.source: Mapped[str]` (`String(10)`, `server_default "manual"`): `"manual"` or `"auto"`. Existing rows become `"manual"`.
  - `MarketCode` table `market_codes`: `id` PK; `kind` `String(12)` (`"mutual_fund" | "stock" | "crypto"`); `code` `String(40)`; `name` `String(160)`; `isin` `String(12) | None`; `price` `Numeric(14,4) | None`; `price_date` `Date | None`; `updated_at` `DateTime(tz)`. Unique `(kind, code)`, index on `(kind, name)`. Not per user: it is shared public market data.

- [ ] **Step 1: Write the failing test** `test_market_code_unique_per_kind`: insert `MarketCode(kind="stock", code="INFY", name="Infosys")` twice, and expect `IntegrityError`. The same code under `kind="mutual_fund"` is fine. `test_price_source_defaults_manual`: a new `InstrumentPrice` without `source` reads back `"manual"`.
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_market_models.py -v`. Expected: FAIL (import error).
- [ ] **Step 3: Add the model, the two columns and the Alembic migration** (`down_revision = "a1d4f7c92b36"`), including the downgrade.
- [ ] **Step 4: Run** `uv run pytest tests/test_market_models.py -v`, then the PostgreSQL run `TEST_DATABASE_URL=postgresql+psycopg://pfm:pfm@localhost:5434/pfm_test uv run pytest tests/test_pg_migrations.py -v`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add market codes and price sources to the schema"`

### Task 2: Source parsers (pure, fixture-tested)

**Files:**
- Create: `backend/app/prices/__init__.py`, `backend/app/prices/parse.py`
- Create fixtures: `backend/tests/fixtures/prices/navall.txt` (a trimmed real-format file with 2 sections, 4 schemes, one `N.A.`, one blank NAV), `equity_l.csv` (3 rows), `bhavcopy.csv` (3 rows incl. one non-`EQ` series), `simple_price.json`, `search.json`, `yahoo_chart.json`
- Test: `backend/tests/test_price_parsers.py`

**Interfaces:**
- Produces, in `app/prices/parse.py`:
  - `@dataclass(frozen=True) class Quote: kind: str; code: str; name: str; isin: str | None; price: Decimal | None; price_date: date | None`
  - `parse_navall(text: str) -> list[Quote]`. Each line is `Scheme Code;ISIN growth;ISIN reinvest;Scheme Name;Net Asset Value;Date` (date like `11-Nov-2026`). Lines without 6 fields are skipped. A NAV that isn't a positive decimal gives `price=None` (the scheme is still listed, so it can be searched). The ISIN is the growth ISIN when not `-`.
  - `parse_equity_list(text: str) -> list[Quote]` from `EQUITY_L.csv` (`SYMBOL, NAME OF COMPANY, ..., ISIN NUMBER`), with no prices.
  - `parse_bhavcopy(text: str) -> dict[str, tuple[Decimal, date]]`: NSE symbol to (close, trade date), only series `EQ`/`BE`. Columns `TckrSymb`, `SctySrs`, `ClsPric`, `TradDt`.
  - `parse_simple_price(data: dict, today: date) -> dict[str, Decimal]`: CoinGecko id to INR price.
  - `parse_coin_search(data: dict) -> list[Quote]`: `coins[]` to `Quote(kind="crypto", code=id, name=f"{name} ({symbol.upper()})", ...)`, first 20.
  - `parse_yahoo_close(data: dict) -> tuple[Decimal, date] | None`: last non-null close and its date in IST.
  - `to_price(text: str) -> Decimal | None`: the shared helper. It gives a `Decimal` rounded to 4 places `ROUND_HALF_UP`, or `None` if the text isn't a finite value > 0.

- [ ] **Step 1: Write failing tests**, one per parser, against the fixtures:
  - `test_navall_skips_headers_and_keeps_na_as_none`: 4 quotes, and the `N.A.` scheme has `price is None`.
  - `test_navall_parses_date_and_decimal`: e.g. `Quote(kind="mutual_fund", code="119551", ..., price=Decimal("101.2345"), price_date=date(2026,11,11))`.
  - `test_bhavcopy_only_equity_series`.
  - `test_to_price_rounds_half_up`: `to_price("12.34565") == Decimal("12.3457")`, and `to_price("0")`, `to_price("-1")`, `to_price("NaN")` and `to_price("")` are `None`.
  - `test_simple_price_reads_inr`.
  - `test_coin_search_formats_name`.
  - `test_yahoo_close_takes_last_non_null`.
- [ ] **Step 2: Run** `uv run pytest tests/test_price_parsers.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement the parsers.** Use `csv` for the CSVs and `datetime.strptime(..., "%d-%b-%Y")` for AMFI dates. Prices go text to `Decimal` via `to_price`, never through `float`. Note that CoinGecko and Yahoo JSON numbers need `json.loads(..., parse_float=Decimal)` at the fetch layer, and the parsers accept `Decimal | int | str`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Parse AMFI, NSE, CoinGecko and Yahoo price data"`

### Task 3: Fetcher

**Files:**
- Create: `backend/app/prices/fetch.py`
- Modify: `backend/pyproject.toml` (move `httpx` from the `dev` group to `dependencies`), `uv.lock`
- Test: `backend/tests/test_price_fetch.py` (uses `httpx.MockTransport`)

**Interfaces:**
- Produces:
  - `class SourceError(Exception)` for any network, status or format failure, with a short message.
  - `class Fetcher` with `__init__(self, client: httpx.Client)` and methods `navall() -> str`, `equity_list() -> str`, `bhavcopy(day: date) -> str | None` (unzips the single CSV; `None` on 404), `simple_price(ids: list[str]) -> dict`, `coin_search(query: str) -> dict`, `yahoo_chart(symbol: str) -> dict`. JSON is loaded with `parse_float=Decimal`. Non-2xx (except the bhavcopy 404) and bad zip/JSON raise `SourceError`.
  - `def default_fetcher() -> Fetcher`: a 20 s timeout, the generic UA, and `x-cg-demo-api-key` only if `settings.coingecko_api_key` is set (a new optional setting in `app/core/config.py`, default `""`).

- [ ] **Step 1: Write failing tests**: `test_bhavcopy_404_is_none`, `test_bhavcopy_unzips_csv`, `test_html_error_page_raises_source_error` (a 200 with `text/html` for a JSON endpoint), `test_simple_price_keeps_decimal`, `test_no_api_key_header_when_unset`.
- [ ] **Step 2: Run** `uv sync && uv run pytest tests/test_price_fetch.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Fetch price sources through one httpx client"`

### Task 4: The refresh job

**Files:**
- Create: `backend/app/prices/refresh.py`
- Test: `backend/tests/test_price_refresh.py` (a fake `Fetcher` subclass returning fixture text, or raising `SourceError` on demand)

**Interfaces:**
- Consumes: Task 2 parsers, Task 3 `Fetcher`/`SourceError`, Task 1 models.
- Produces:
  - `@dataclass class RefreshReport: updated: dict[str, int]; failed: dict[str, str]`, where keys are `"mutual_fund"`, `"stock"` and `"crypto"`.
  - `refresh_market(db: Session, fetcher: Fetcher, today: date) -> RefreshReport`. It upserts `market_codes` per source, each source in its own `try/except SourceError`. Funds: every scheme from `navall()`. Stocks: names from `equity_list()`, prices from `bhavcopy(today)`. If that's `None` or fails, `yahoo_chart` is used for each **linked** stock code only. Crypto: `simple_price` for the distinct linked CoinGecko ids only. A quote with `price=None` updates the name but never clears an existing price.
  - `apply_to_users(db: Session, only_kind: str | None = None) -> int`. For every instrument with a `source_code` whose `market_codes` row has a price, it inserts `InstrumentPrice(source="auto", date=price_date, price=...)` **unless any row already exists for that instrument and date**. One exception: an existing `"auto"` row for the same date whose price differs is updated in place (crypto intraday). It returns the number of rows written.
  - `run_nightly(db: Session, fetcher: Fetcher, today: date) -> RefreshReport` = `refresh_market` + `apply_to_users` + commit. It logs failures with `logging.getLogger("app.prices")`.

- [ ] **Step 1: Write failing tests**:
  - `test_funds_and_stocks_and_crypto_update_linked_instruments`: two users. User A links fund `119551` and stock `INFY`, and user B links coin `bitcoin`. Each gets exactly one `"auto"` row with the fixture's price and date.
  - `test_unlinked_instruments_untouched`.
  - `test_manual_price_same_day_is_kept`: a manual row exists for 2026-11-11, the job runs, and there is still one row for that date, still manual.
  - `test_manual_typed_after_auto_wins`: the job writes auto, then the user posts a manual price for the same date through `POST /api/investments/stocks/{id}/prices`, so `latest_prices()` returns the manual price. Running the job again changes nothing.
  - `test_fund_trade_nav_counts_as_existing`: a fund trade on 2026-11-11 recorded its NAV, so the job adds no row for that date.
  - `test_holiday_bhavcopy_none_falls_back_to_yahoo`.
  - `test_one_source_failing_does_not_block_others`: the fake `navall()` raises `SourceError`. Stocks and crypto still update, `report.failed == {"mutual_fund": "<msg>"}`, and the existing fund prices are unchanged.
  - `test_na_nav_does_not_clear_previous_market_price`.
  - `test_crypto_auto_row_updated_in_place_same_day`.
- [ ] **Step 2: Run** `uv run pytest tests/test_price_refresh.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.** Upsert `market_codes` in bulk: load the existing `(kind, code)` set once, then add or update. Don't issue one query per scheme, because AMFI lists about 14k schemes.
- [ ] **Step 4: Run**, then also on PostgreSQL with `TEST_DATABASE_URL=... uv run pytest tests/test_price_refresh.py -v`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Refresh market prices and copy them to linked holdings"`

### Task 5: Cron endpoint, CLI and Vercel schedule

**Files:**
- Create: `backend/app/api/routes/cron.py`, `backend/vercel.json` (if Vercel's FastAPI detection needs other keys, keep them; add only `crons`)
- Modify: `backend/app/core/config.py` (`cron_secret: str = ""`), `backend/app/core/security.py` (add `f"{prefix}/cron/prices"` to `public_paths`, since the route checks its own secret), `backend/app/api/router.py`, `backend/app/cli.py` (a `refresh-prices` command), `backend/.env.example` (`CRON_SECRET=`)
- Test: `backend/tests/test_cron.py`

**Interfaces:**
- Consumes: `run_nightly`, `default_fetcher`, `today_india`.
- Produces: `GET /api/cron/prices` returns `{"updated": {...}, "failed": {...}}` with 200. It returns 401 `{"detail": "Not authenticated"}` unless `cron_secret` is non-empty and the header is exactly `Bearer <cron_secret>` (`hmac.compare_digest`). `vercel.json`: `{"crons": [{"path": "/api/cron/prices", "schedule": "30 18 * * *"}]}`. The CLI command is `uv run python -m app.cli refresh-prices`, which prints the report.

- [ ] **Step 1: Write failing tests**: `test_cron_no_header_401`, `test_cron_wrong_secret_401`, `test_cron_secret_unset_always_401` (even with `Authorization: Bearer `), `test_cron_runs_job` (monkeypatch `default_fetcher` with the fake from Task 4, then 200 with counts), `test_user_token_is_not_a_cron_secret` (a valid user bearer token gives 401).
- [ ] **Step 2: Run** `uv run pytest tests/test_cron.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole suite, `uv run pytest`. Expected: PASS. Then run the real thing locally once: `npm run db:start; cd backend; uv run python -m app.cli refresh-prices`. Expected: funds and crypto counts > 0, or a listed failure, and no traceback. Record in the commit message whether NSE answered from this machine.
- [ ] **Step 5: Commit** `git commit -m "Run the price refresh nightly from Vercel Cron"`

### Task 6: Linking API and auto markers

**Files:**
- Create: `backend/app/api/routes/market.py`
- Modify: `backend/app/api/routes/stocks.py`, `funds.py`, `coins.py` (the create/update bodies accept `source_code: str | None`; responses gain `source_code: str | None`; price/NAV list items gain `source: "manual" | "auto"`), `backend/app/api/router.py`
- Test: `backend/tests/test_market_api.py`, plus updates to the exact-dict assertions in `test_stocks.py`, `test_funds.py` and `test_coins.py`

**Interfaces:**
- Produces:
  - `GET /api/investments/market-codes?kind=<mutual_fund|stock|crypto>&q=<text>` returns `{"results": [{"code", "name", "isin", "price", "price_date"}]}`, at most 20. Funds and stocks: `q` (2+ characters) matched case-insensitively against `name` and `code` in `market_codes`, with exact code matches first. Crypto: a live `coin_search(q)`, with results upserted into `market_codes` (no price) before returning. If the source fails, the response is 503 `{"detail": "Couldn't search coins right now."}`.
  - Setting `source_code` checks that the code exists in `market_codes` for the instrument's kind, otherwise 422 on `source_code` with "Pick a match from the search." `null` unlinks. On link, `apply_to_users(db, only_kind=kind)` runs at once so a price appears straight away.
  - `POST /api/investments/coins/refresh` refreshes crypto if the newest `market_codes.updated_at` among the user's linked coins is older than 6 hours, then calls `apply_to_users(only_kind="crypto")`. It returns `{"refreshed": bool}`. A source failure returns `{"refreshed": false}` with 200, never an error, so opening the app never fails because of CoinGecko.
  - `GET /api/investments/unlinked` returns `{"stocks": [...], "funds": [...], "coins": [...]}` with the user's instruments that have no `source_code` (id, symbol, name), for the "Link your holdings" prompt.

- [ ] **Step 1: Write failing tests**: `test_search_funds_by_name`, `test_search_needs_two_chars`, `test_link_unknown_code_422`, `test_link_writes_price_immediately`, `test_unlink_keeps_existing_prices`, `test_price_list_shows_source`, `test_coins_refresh_skips_when_fresh` (with a fake fetcher counting calls), `test_coins_refresh_source_down_is_200_false`, `test_unlinked_lists_only_unlinked`, `test_cannot_link_other_users_instrument` (404).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement**, and update the existing tests' expected dicts for the new fields.
- [ ] **Step 4: Run** `uv run pytest && uv run ruff check .`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Link holdings to market codes and mark automatic prices"`

### Task 7: Website

**Files:**
- Create: `frontend/src/components/investments/link-dialog.tsx`, `frontend/src/components/investments/link-prompt.tsx`
- Modify: `frontend/src/lib/investments.ts`, `funds.ts`, `crypto.ts` (types gain `source_code` and the price `source`; add a `marketSearch(kind, q)` helper), `investments-view.tsx` (shows `LinkPrompt` when `/unlinked` is non-empty, and fires `POST /coins/refresh` once on load, then re-fetches coins if `refreshed`), `stock-view.tsx`, `fund-view.tsx`, `coin-view.tsx` (a "Link to live prices" / "Linked to <code>" action that opens `LinkDialog`), the price lists (an "auto" badge on `source === "auto"` rows), and the stock/fund/coin create dialogs (an optional search field that sets `source_code`)
- Test: `frontend/src/lib/investments.test.mjs` (the search helper's query building and the debounce-free `linkLabel(source_code)` text)

**Interfaces:**
- Consumes: the Task 6 endpoints.
- Copy (fixed): prompt title "Let Gullak fetch your prices"; body "Link each holding once and its price updates every night."; badge "auto"; empty search "No match. Try the fund's full name."

- [ ] **Step 1: Write failing tests** for the pure helpers in `lib/` (`marketSearchPath("mutual_fund", "parag")` gives `"/investments/market-codes?kind=mutual_fund&q=parag"`, and `linkLabel(null)` gives `"Link to live prices"`).
- [ ] **Step 2: Run** `npm --prefix frontend test`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers and components, matching the existing dialog and select patterns in `components/investments/` and `components/ui/`.
- [ ] **Step 4: Run** `npm --prefix frontend run lint && npm --prefix frontend test`. Then run `npm run dev` with the API on 8001, as in local setup: link a fund, see its NAV with the "auto" badge, see the prompt disappear once everything is linked, and check that a typed price on the same day still shows as current. Expected: all of this works in light and dark mode.
- [ ] **Step 5: Commit** `git commit -m "Link holdings to live prices on the website"`

### Task 8: Android app

**Files:**
- Create: `mobile/src/app/link-form.tsx`, `mobile/src/components/link-prompt.tsx`
- Modify: `mobile/src/lib/investments.ts`, `funds.ts`, `crypto.ts` (the same type changes and helpers as the website, written for the app), `mobile/src/app/stock.tsx`, `fund.tsx`, `coin.tsx` (a link action), the price lists (an "auto" chip), the investments tab screen (`LinkPrompt` + `POST /coins/refresh` on focus, using the existing focus-refetch pattern)
- Test: `mobile/src/lib/investments.test.mjs` (the same helper tests, in the app's style)

**Interfaces:**
- Consumes: the Task 6 endpoints, and the same copy as Task 7.

- [ ] **Step 1: Write failing helper tests.**
- [ ] **Step 2: Run** `npm --prefix mobile test`. Expected: FAIL.
- [ ] **Step 3: Implement** as a native-feeling full-screen search form (the expo-router screen pattern used by `price-form.tsx`), not a copy of the web dialog.
- [ ] **Step 4: Run** `npm --prefix mobile run lint && npm --prefix mobile run typecheck && npm --prefix mobile test`. Expected: PASS. There's no device test (the phone install is deferred), so add "link holdings + auto prices" to the pending device-check list in memory.
- [ ] **Step 5: Commit** `git commit -m "Link holdings to live prices in the app"`

### Task 9: Docs, roadmap and hand-off

**Files:**
- Modify: `docs/product/roadmap.md` (Milestone 4 status: automatic prices), `docs/architecture/database-design.md` (`market_codes`, `source_code`, `source`), `backend/README.md` (`refresh-prices`, `CRON_SECRET`)

- [ ] **Step 1: Update the docs.**
- [ ] **Step 2: Run** `npm run lint && npm test` from the repo root. Expected: PASS.
- [ ] **Step 3: Commit** `git commit -m "Document nightly prices"`
- [ ] **Step 4: Hand-off note for the owner**, to go at the top of the PR description:
  1. Run `alembic upgrade head` on Neon before merging.
  2. Set `CRON_SECRET` (any long random string) on the `personal-finance-api` Vercel project. Optionally set `COINGECKO_API_KEY`.
  3. After the deploy, link your holdings once on the website.
