# Mutual Funds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track mutual funds paid by SIP or lump sum from bank accounts: funds, purchases, redemptions, existing units, NAVs and SIP reminders, counted in investments and net worth, on the backend, website and Android app, without changing a single stock figure.

**Architecture:** The three stock tables become general (`instruments` with a `kind`, `investment_trades`, `instrument_prices`), and a new `sips` table is added. `investment_trades.amount` becomes the money source of truth: computed for stocks, entered for funds. The FIFO replay (`app/api/portfolio.py`) works on `Decimal` quantities and `amount`, so funds reuse the stock maths, cash movements and net worth code. Stock routes and response shapes stay as they are, filtered to `kind = 'stock'`. Funds get their own routes under `/api/investments`.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, pytest (SQLite by default, PostgreSQL with `TEST_DATABASE_URL`). Next.js 16 (read `frontend/node_modules/next/dist/docs/` before writing pages). Expo SDK 58 with Expo Router and react-native-paper (read the versioned Expo docs first, as `mobile/AGENTS.md` says). Pure client helpers are tested with `node --test` `.mjs` files.

**Spec:** [docs/superpowers/specs/2026-11-09-mutual-funds-design.md](../specs/2026-11-09-mutual-funds-design.md). The "Design calls made by Claude" list is accepted and binding.

## Global Constraints

- **Production holds the owner's 9 stock holdings. Every stock row, figure and API response must stay byte-for-byte the same after the migration.** Task 1 pins this with a golden test that later tasks must never edit.
- `GET /investments/stocks`, `GET /investments/trades`, `GET /investments/stocks/{id}/prices` and the existing keys of `GET /investments/portfolio` keep their shapes and formats: stock `quantity`/`shares` are JSON integers, stock money and prices have 2 decimals.
- Money goes over the API as strings with 2 decimals (`fmt`). Fund units are strings with 3 decimals, NAVs strings with 4 decimals.
- Money inputs use the existing `Money` type. Units and NAV inputs are text only, like money: units `> 0`, at most 3 decimals, below 10^15; NAV `> 0`, at most 4 decimals, below 10^10.
- Validation errors: `RequestValidationError([field_error(field, message)])` → 422. Conflicts: `HTTPException(409, message)`. Missing or other-user ids, and ids of the other kind (a fund id on a stock route and vice versa), are 404.
- Every query is scoped to `user.id`. Ids outside `1..MAX_ID` are 404.
- "Today" is `today_india()`. Trade and NAV dates can't be in the future: "The date can't be in the future."
- Rounding is half up (`ROUND_HALF_UP`), and all sums use `Decimal` in Python, never floats or SQL `SUM`. Stamp duty = `round_paise(amount × 0.00005)`. Suggested units = `round((amount − stamp duty) ÷ NAV, 3)`.
- Funds are paid only from active `bank` accounts. Stocks still only through active `broker` accounts.
- A SIP never posts on its own.
- Web and Android get their own UI. Never port one into the other.
- P&L is always shown signed and coloured (`formatSigned`, `formatPercent`, `tone` already exist in both clients).
- Subagents never start servers, emulators or browsers in the foreground. Long-running processes run in the background with a bounded readiness check (for example, poll `http://localhost:8000/api/health` at most 30 times, 1 second apart), and are stopped at the end of the task.
- Browser checks use a throwaway test user on the local API, never the owner's data.
- Commit after each task, ending messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An existing-units entry whose average NAV can't be stored:** a tiny amount over many units rounds to `0.0000`, and a huge amount over 0.001 units overflows `Numeric(14,4)`. Both must be a 422 on `amount` or `units`, never a 500 (test in Task 5).
2. **Moving a SIP instalment to another month by editing its date.** The old month becomes due again, the new month is settled, and the auto-recorded NAV moves with it (tests in Tasks 5 and 6).
3. **Redeeming every unit after partial redemptions.** Units reach exactly `0.000`, the position closes, and no paisa of cost is left in `invested` (test in Task 3).
4. **A SIP on day 31, and a SIP whose start date is after its debit day.** February's instalment is due on the 28th/29th, and a start date of 20 May with day 5 makes June the first due month (tests in Task 3).
5. **Deleting a fund transaction whose NAV was auto-recorded.** Its NAV row goes, so a fund left with no NAV shows "at cost". A NAV entered by hand on the same date stays (test in Task 5).

---

### Task 1: Golden stock figures

Pin today's stock output before anything changes. This task changes no app code.

**Files:**
- Create: `backend/tests/test_pg_stock_figures.py` (marked `postgres`)
- Create: `backend/tests/fixtures/stock_figures.json` (written by the test, then committed)

**Interfaces:**
- Produces: `seed_stock_data(conn) -> None` and `stock_responses(engine) -> dict[str, Any]` inside the test module. Task 2 runs the same test after its migration.

- [ ] **Step 1: Write `test_stock_figures_survive_every_migration`.** It uses its own database, created like `migrations_db` in `test_pg_migrations.py` (name ending `_figures_test`). Steps inside the test:
  1. `command.upgrade(config, "65f46a0f545a")` (the stocks revision. Pin it, never `head`, for seeding).
  2. Seed with plain SQL (`seed_stock_data`), using explicit ids: user 1 (`me@example.com`, session_version 1); a broker "Zerodha" (opening 50000.00), a second broker "Groww" (opening 1000.00) and a bank "SBI"; stocks INFY, TCS and HDFCBANK. Trades: an opening buy of INFY 10 @ 1450.25 + 0.00; a buy of INFY 5 @ 1500.10 + 15.33 on Zerodha; a partial sell of INFY 7 @ 1620.40 − 21.07; a buy and full sell of TCS on Groww (a closed position); a buy of HDFCBANK 3 @ 1601.00 + 4.99. Prices: INFY 1700.00 and 1710.55 on the same date (the later id wins), TCS one price, HDFCBANK none. All dates in Oct 2026. Read the earlier migrations for each table's required columns.
  3. `command.upgrade(config, "head")`.
  4. `stock_responses(engine)`: point `get_db` at a session on this engine, sign a token for user 1 the way `tests.test_accounts.auth` does, and GET `/api/investments/stocks`, `/api/investments/trades`, `/api/investments/portfolio`, `/api/investments/stocks/{id}/prices` for each stock, `/api/accounts` and `/api/dashboard`. Return them keyed by path.
  5. If `WRITE_STOCK_FIGURES=1`, write the result to the fixture file and skip. Otherwise compare each response to the fixture. For dicts, compare only the fixture's keys, so new keys (`funds`, `overall`) are allowed and nothing else may change.
- [ ] **Step 2:** On the unchanged code, with the local PG cluster up, run `WRITE_STOCK_FIGURES=1 TEST_DATABASE_URL=postgresql+psycopg://pfm:pfm@localhost:5434/pfm_test uv run pytest tests/test_pg_stock_figures.py`. Open the fixture and check the figures are sensible (for example, INFY's FIFO cost after the partial sell).
- [ ] **Step 3:** Run it again without `WRITE_STOCK_FIGURES`. Expected: PASS.
- [ ] **Step 4:** Commit: `Pin the stock figures before generalising the investment tables`.

**Rule for every later task:** this fixture file is never edited. If the test fails, the code is wrong.

### Task 2: General investment tables, migration and stock code on top of them

**Files:**
- Rename: `backend/app/models/stock.py` → `backend/app/models/investment.py`
- Modify: `backend/app/models/__init__.py`
- Create: `backend/migrations/versions/2026_11_09_1200-<rev>_generalise_investments.py` (down_revision `65f46a0f545a`)
- Modify: `backend/app/api/portfolio.py`, `backend/app/api/balances.py`, `backend/app/api/routes/stocks.py`, `backend/app/api/routes/trades.py`, `backend/app/api/routes/portfolio.py`, `backend/app/api/routes/dashboard.py`, `backend/app/api/routes/accounts.py` (imports and renamed fields only, plus the `kind` filters below)
- Modify: `backend/tests/test_pg_migrations.py` (`ALL_TABLES`), `backend/tests/test_portfolio_math.py`, `backend/tests/test_stocks.py` (model names)
- Test: `backend/tests/test_stocks.py`, `backend/tests/test_trades.py`, `backend/tests/test_pg_migrations.py`

**Interfaces:**
- Produces (models, in `app/models/investment.py`):
  - `Instrument` (`instruments`): as `Stock`, plus `kind: String(12)` (`"stock"` or `"mutual_fund"`). `UniqueConstraint("user_id", "kind", "symbol")`.
  - `InvestmentTrade` (`investment_trades`): as `StockTrade` with `stock_id` renamed `instrument_id`, `quantity: Numeric(18,3)` (`Decimal`), `price: Numeric(14,4)`, plus `amount: Numeric(14,2)` not null and `sip_id: int | None` (FK `sips.id`, indexed).
  - `InstrumentPrice` (`instrument_prices`): as `StockPrice` with `instrument_id`, `price: Numeric(14,4)`, plus `trade_id: int | None` (FK `investment_trades.id`, indexed).
  - `Sip` (`sips`): `id`, `user_id` (indexed), `instrument_id` (FK, indexed), `account_id` (FK, indexed), `amount: Numeric(14,2)`, `day: Integer`, `start_date: Date`, `active: Boolean` (server default true), `created_at`, `updated_at`.
- Produces (`app/api/portfolio.py`):
  ```python
  class TradeRow(NamedTuple):
      id: int; instrument_id: int; account_id: int; side: str; date: date
      quantity: Decimal; price: Decimal; charges: Decimal; opening: bool; amount: Decimal
  def stock_amount(side: str, quantity: Decimal | int, price: Decimal, charges: Decimal) -> Decimal
      # round_paise(q×p + c) for a buy, round_paise(q×p − c) for a sell
  def trade_value(t: TradeRow) -> Decimal        # now simply t.amount
  @dataclass class Position: instrument_id; account_id; quantity: Decimal; invested; realised; sold_any
  def load_kinds(db, user_id) -> dict[int, str]    # instrument id → kind
  def summarise(replay, prices, only: set[int] | None = None) -> PortfolioTotals
      # `only`: count just these instrument ids
  def investments_totals(db, user_id, kind: str | None = None) -> PortfolioTotals
  ```
  Replay changes: a buy's lot cost is `t.amount`, and a sell's realised P&L is `t.amount − cost taken`. The rest of the FIFO is unchanged. Quantities are `Decimal`.

- [ ] **Step 1: Write the failing tests.**
  - In `test_pg_migrations.py`, set `ALL_TABLES` to `users, accounts, transactions, instruments, investment_trades, instrument_prices, sips`.
  - `test_migration_keeps_stock_rows` (in `test_pg_migrations.py`): upgrade to `65f46a0f545a`, insert a user, broker, stock, a buy (10 @ 1234.56 + 20.10), a sell (4 @ 1300.00 − 5.25) and a price, then upgrade to head. Expected: the same ids and values in the new tables, `kind = 'stock'`, amounts `12365.70` and `5194.75`, and `quantity` reads back as `Decimal("10.000")`. Then `downgrade` to `65f46a0f545a` gives back the original rows and types.
  - `test_downgrade_refuses_fund_data`: with a `mutual_fund` instrument present, downgrading raises, and nothing is dropped.
  - In `test_stocks.py`, `test_stock_routes_ignore_funds`: insert an `Instrument(kind="mutual_fund", symbol="INFY")` directly. Expected: `GET /investments/stocks` doesn't list it, `POST` stock `INFY` is still allowed, and `GET /investments/stocks/{fund id}/prices`, PATCH and DELETE are 404. A trade with `stock_id` = the fund's id is 422 "Choose a stock.".
- [ ] **Step 2:** Run `uv run pytest` (SQLite) and the PG run. Expected: the new tests fail.
- [ ] **Step 3: Write the migration by hand** (autogenerate can't see renames). Upgrade, in order:
  1. Rename the tables, the `stock_id` columns, the id sequences, and every pk, fk, uq and ix name to what `NAMING_CONVENTION` gives the new tables (e.g. `ix_investment_trades_instrument_id`).
  2. Add `instruments.kind` with server default `'stock'`, then drop the default. Replace the unique constraint with `(user_id, kind, symbol)` named `uq_instruments_user_id`.
  3. Change `quantity` to `Numeric(18,3)` (`USING quantity::numeric`) and both `price` columns to `Numeric(14,4)`.
  4. Add `amount` nullable, backfill `round(quantity*price + charges, 2)` for buys and `round(quantity*price - charges, 2)` for sells, then set it NOT NULL.
  5. Create `sips`, then add `investment_trades.sip_id` and `instrument_prices.trade_id`, each with its FK and index.

  Downgrade: first raise `RuntimeError("Mutual fund data exists; remove it before downgrading.")` if any instrument isn't a stock, or any quantity has a fraction. Then reverse every step exactly.
- [ ] **Step 4:** Rename the models and update every caller. Stock routes filter `Instrument.kind == "stock"` everywhere: `get_owned_stock`, the list, the symbol-taken check, the price routes (including `DELETE /prices/{id}`, which joins its instrument) and the trades list. Create sets `kind="stock"`. The stock trade save sets `amount = stock_amount(...)`. `TradeResponse.quantity` is `int(t.quantity)`. The portfolio route's existing keys and `holds_shares` count only stock instruments (`load_kinds`). The dashboard and accounts still use `investments_totals(db, user_id)`, which is all kinds (stocks only, for now).
- [ ] **Step 5:** Run `uv run pytest`, `uv run ruff check .`, then the PG run (all tests, including `test_pg_stock_figures.py` unchanged, `alembic check` and the concurrency tests). Expected: all PASS.
- [ ] **Step 6:** Commit: `Generalise the stock tables into instruments, investment trades and prices`.

### Task 3: Fund maths and SIP due months (pure)

**Files:**
- Modify: `backend/app/api/dates.py` (move `_clamped` here from `dashboard.py` as `clamped_date(year, month, day) -> date`; update `dashboard.py`)
- Modify: `backend/app/api/portfolio.py` (formatters)
- Create: `backend/app/api/sips.py`
- Test: `backend/tests/test_portfolio_math.py`, `backend/tests/test_sips_math.py`

**Interfaces:**
- Produces:
  ```python
  # portfolio.py
  def fmt_units(value: Decimal) -> str       # "253.462", quantised to 0.001, half up
  def fmt_nav(value: Decimal) -> str         # "84.3793", quantised to 0.0001, half up
  def stamp_duty(amount: Decimal) -> Decimal # round_paise(amount * Decimal("0.00005"))
  # sips.py
  class SipRow(NamedTuple): id: int; instrument_id: int; account_id: int; day: int; start_date: date; active: bool
  class BuyRow(NamedTuple): instrument_id: int; account_id: int; date: date; opening: bool; sip_id: int | None
  def due_dates(sip: SipRow, buys: Iterable[BuyRow], today: date) -> list[date]
  def load_due(db: Session, user_id: int, today: date) -> dict[int, list[date]]  # sip id → due dates
  ```
- `due_dates` algorithm: return `[]` if not active. For each calendar month from `start_date`'s month to `today`'s month, the debit date is `clamped_date(y, m, day)`. Skip it if it is before `start_date` or after `today`. The month is settled if a buy in that calendar month has `sip_id == sip.id` (opening or not), or has `sip_id is None`, the same instrument and account, and `opening` false. Return the unsettled debit dates, oldest first.

- [ ] **Step 1: Write the failing tests.**
  - In `test_portfolio_math.py` (build rows with `amount`):
    - `test_fund_buy_cost_is_amount`: buy 35.552 units @ 84.3793, charges 0.15, amount 3000.00 → invested `3000.00`, quantity `Decimal("35.552")`.
    - `test_fractional_partial_redemption`: buys 35.552 (3000.00) and 35.549 (3000.00), sell 50.000 units for amount 4300.00 → cost taken `3000.00 + round_paise(3000.00 × 14.448 ÷ 35.549) = 3000.00 + 1219.27`, realised `80.73`, quantity left `21.101`.
    - `test_redeeming_everything_closes_the_position` (Review Focus 3): then redeem the remaining 21.101 → quantity `Decimal("0.000")`, invested `0.00`.
    - `test_fund_value`: `holding_value(Decimal("253.462"), invested, Decimal("84.3793"))` → `21386.95`.
    - `test_summarise_only`: a stock and a fund position, `only={fund id}` → just the fund's figures.
    - `test_formatters_and_stamp_duty`: `stamp_duty(3000) == 0.15`, `stamp_duty(2000) == 0.10`, `fmt_units(Decimal("21.984")) == "21.984"`, `fmt_nav(Decimal("635.0943")) == "635.0943"`.
  - In `test_sips_math.py` (SIP on day 5 from 2026-05-05, today 2026-11-09, fund 1, bank 2):
    - `test_unrecorded_months_are_due`: no buys → seven dates, 5 May to 5 Nov.
    - `test_linked_opening_buys_settle_months`: opening buys with `sip_id` on 05-May…05-Jun, **06-Jul**, 05-Aug, **07-Sep**, 06-Oct, 05-Nov → `[]`.
    - `test_unlinked_buy_counts_only_when_not_opening_and_same_account`.
    - `test_not_due_before_the_debit_day`: today 2026-11-04 → November isn't due.
    - `test_stopped_sip_is_never_due`.
    - `test_day_31_clamps` (Review Focus 4): day 31, Feb 2027 → due 28 Feb 2027.
    - `test_start_after_debit_day` (Review Focus 4): start 2026-05-20, day 5 → first due date 5 Jun 2026.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. `load_due` reads the user's SIPs and their buys (`side == "buy"`) and calls `due_dates` for each.
- [ ] **Step 4:** Run `uv run pytest` and ruff. Expected: PASS.
- [ ] **Step 5:** Commit: `Work out fund holdings and due SIP months`.

### Task 4: Funds and NAVs API

**Files:**
- Create: `backend/app/api/routes/funds.py` (prefix `/investments`)
- Modify: `backend/app/api/router.py`
- Test: `backend/tests/test_funds.py`

**Interfaces:**
- Consumes: `latest_prices`, `fmt_nav`, `Day`, `clean_text`, `field_error`, `MAX_ID`, the symbol rule from `routes/stocks.py` (import `Symbol`).
- Produces:
  - `Units` and `Nav` annotated input types (defined here, used by Tasks 5 and 6). They share one `_decimal(places, upper, message)` validator: text only, regex `[0-9]+(\.[0-9]+)?`, at most `places` decimals, `0 < value < upper`. Units: 3 places, upper 10^15, "Enter units above 0, with up to 3 decimals, like 35.552." NAV: 4 places, upper 10^10, "Enter a NAV above 0, with up to 4 decimals, like 84.3793."
  - `get_owned_fund(db, user_id, id) -> Instrument` (404 "Fund not found.", stocks included).
  - `derive_symbol(name: str, taken: set[str]) -> str`: the upper-cased first letter or digit of each word, kept to `[A-Z0-9]`, at most 20 characters, `"FUND"` if empty. If it's taken, add `2`, `3`, … (still at most 20 characters). "Parag Parikh Flexi Cap – Regular Growth" → `"PPFCRG"`.
  - `GET /investments/funds` → `{"funds": [{"id", "symbol", "name", "nav": str|null, "nav_date": str|null}]}`, sorted by name.
  - `POST /investments/funds` `{"name", "symbol"?}` → 201. `PATCH /investments/funds/{id}` `{"name"?, "symbol"?}`. `DELETE /investments/funds/{id}` → `{"id"}`, or 409 "This fund has transactions, NAVs or SIPs. Delete them first."
  - `GET /investments/funds/{id}/navs` → `{"navs": [{"id", "date", "nav", "trade_id": int|null}]}`, newest first. `POST /investments/funds/{id}/navs` `{"date", "nav"}` → 201. `DELETE /investments/navs/{id}` → `{"id"}`, fund NAVs only.

- [ ] **Step 1: Write the failing tests:** create with and without a symbol (`PPFCRG`, and `PPFCRG2` for a second fund of the same initials); a duplicate symbol among funds is 422 "You already have PPFCRG." on `symbol`, but the same symbol as a stock is allowed; name rules; per-user 404s; a stock id on fund routes is 404; NAV rules (`"0"`, `"1.23456"`, `84.3793` as a JSON number, and a future date are each 422); NAV list newest first and the fund list's `nav` shows 4 decimals; `DELETE /investments/navs/{stock price id}` and `DELETE /investments/prices/{fund NAV id}` are both 404; delete is refused with a NAV and allowed without.
- [ ] **Step 2:** Run `uv run pytest tests/test_funds.py -v`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite and ruff. Expected: PASS.
- [ ] **Step 5:** Commit: `Add mutual funds and NAVs to the API`.

### Task 5: Fund transactions API

**Files:**
- Create: `backend/app/api/trade_checks.py`. Move the kind-neutral parts of `routes/trades.py` here: `NEW_ID`, `day_text` (was `_day`), `lock_trade` (was `_lock_trade`), `require_active`, and `check_cash_and_holdings(db, user_id, accounts, row, existing_id, money_field, short_messages)`, which holds the balance and shortfall checks. `routes/trades.py` keeps its messages and calls them.
- Create: `backend/app/api/routes/fund_trades.py` (prefix `/investments`)
- Modify: `backend/app/api/router.py`
- Test: `backend/tests/test_fund_trades.py`

**Interfaces:**
- Consumes: `Units`, `Nav`, `get_owned_fund` (Task 4). `TradeRow`, `replay`, `load_trade_rows`, `stamp_duty`, `fmt_units`, `fmt_nav` (Tasks 2 and 3).
- Produces:
  - `GET /investments/fund-trades?fund_id=&account_id=&sip_id=` → `{"trades": [FundTrade]}`, newest first, funds only. `FundTrade` = `{"id", "fund_id", "symbol", "account_id", "account_name", "side", "date", "units", "nav", "charges", "amount", "opening", "sip_id", "note", "realised"}`.
  - `POST /investments/fund-trades` `{"fund_id", "account_id", "side", "date", "units", "nav"?, "charges"?, "amount", "opening"?, "sip_id"?, "note"?}` → 201. `nav` is required unless `opening`, and ignored when `opening`.
  - `PATCH /investments/fund-trades/{id}` (any field except `side` and `opening`) and `DELETE /investments/fund-trades/{id}`. Stock trade ids are 404 here, and fund trade ids are 404 on `/investments/trades/{id}`.
  - `sync_trade_nav(db: Session, trade: InvestmentTrade) -> None`: for a non-opening fund trade, if another NAV row exists for (instrument, trade date), delete this trade's linked row. Otherwise create or update the linked row (`trade_id = trade.id`) with the trade's date and price. Called after create and edit. Delete removes the linked rows before the trade.

Rules, in order (messages are exact):
- `fund_id`: "Choose a fund." `account_id`: "Choose a bank account." (it must be the user's bank account; an archived one gets "{name} is archived. Restore it to use it."). `side`: "Choose purchase or redemption." `amount`: "Enter the amount." / "Amount must be greater than 0." `charges` ≥ 0, defaulting to 0, and below `amount`: "Charges can't be more than the amount."
- `opening` with a sell → "Only a purchase can be existing units." on `opening`. `sip_id` must be the user's SIP for this fund, on a buy → "Choose a SIP for this fund." on `sip_id`.
- Opening: `price = round(amount ÷ units, 4)`, half up. If that is 0, it's 422 on `amount` "That's too little for that many units." If it is 10^10 or more, it's 422 on `units` "That's too few units for that amount." No NAV row is recorded.
- Non-opening buy: if `|units × nav − (amount − charges)| > 1.00`, it's 422 on `units` "Units × NAV doesn't match the amount. Check the units and NAV." (The spec says `quantity`; the fund API calls that field `units`.) If `units × nav ≥ MAX_MONEY`, it's 422 on `nav` "This transaction is too large."
- Cash and holdings: the bank's balance check (error field `amount`). Shortfall messages: 422 on `units` "You'd be redeeming more {SYMBOL} units than you held on {D Mon YYYY}.", or 409 "This would leave the redemption of {SYMBOL} on {D Mon YYYY} redeeming more than was held."

- [ ] **Step 1: Write the failing tests** (helpers: `bank(headers)`, `fund(headers)`, `buy(headers, **fields)` with the statement's defaults: units `"35.552"`, nav `"84.3793"`, charges `"0.15"`, amount `"3000.00"`):
  - `test_purchase_debits_the_bank_and_records_its_nav`: bank 50000 → `47000.00`. The fund's NAV list has one row with `trade_id` set, and the response shows `units "35.552"`, `nav "84.3793"`.
  - `test_existing_units_leave_the_bank_alone`: opening, units `"253.462"`, amount `"21000.00"` → bank unchanged, `nav "82.8527"` (21000 ÷ 253.462, half up), no NAV row.
  - `test_units_times_nav_check`: units `"355.52"` → 422 on `units`. `"35.560"` (0.68 off) → 201.
  - `test_redemption_credits_the_bank_and_realises`: buy, then redeem 10.000 for amount `"860.00"` → bank +860.00, and `realised` = 860.00 − round_paise(3000.00 × 10 ÷ 35.552) = 860.00 − 843.83 = `16.17`.
  - `test_existing_units_out_of_range` (Review Focus 1): amount `"0.01"` with units `"1000"`, and amount `"999999999.00"` with units `"0.001"` → both 422 on the fields above.
  - `test_editing_the_date_moves_the_auto_nav` (Review Focus 2): edit 2026-11-05 → 2026-10-06, and the linked NAV row follows. Edit it onto a date with a hand-entered NAV, and the linked row is deleted while the manual one stays.
  - `test_deleting_a_trade_deletes_its_nav` (Review Focus 5): the fund's list shows `nav: null` afterwards. A manual NAV on the same date survives.
  - `test_existing_nav_on_the_date_is_kept`: with a manual NAV already on the date, no second row is added.
  - `test_field_rules`, parametrised over each message above, including a broker account, a stock as `fund_id`, `opening` with a sell, another fund's `sip_id` and a future date.
  - `test_fund_and_stock_trades_stay_apart`: each list shows only its kind, and cross-kind ids are 404 on PATCH and DELETE.
  - `test_redeem_more_than_held_is_422`, and `test_edit_leaving_a_later_redemption_short_is_409`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Do the `trade_checks.py` extraction first, with `uv run pytest tests/test_trades.py` green before and after. Then implement the fund routes.
- [ ] **Step 4:** Run `uv run pytest`, ruff, and the PG run (golden test included). Expected: PASS.
- [ ] **Step 5:** Commit: `Record fund purchases and redemptions through bank accounts`.

### Task 6: SIPs API

**Files:**
- Create: `backend/app/api/routes/sips.py` (prefix `/investments`)
- Modify: `backend/app/api/router.py`
- Test: `backend/tests/test_sips.py`

**Interfaces:**
- Consumes: `load_due`, `due_dates` (Task 3), `get_owned_fund` (Task 4), `lock_accounts`.
- Produces:
  - `SipResponse` = `{"id", "fund_id", "symbol", "fund_name", "account_id", "account_name", "amount", "day", "start_date", "active", "instalments": int, "due": [iso dates], "due_date": iso|null}`, where `due_date` is the first due date.
  - `GET /investments/sips?fund_id=` → `{"sips": [SipResponse]}`, ordered by fund name, then id.
  - `POST /investments/sips` `{"fund_id", "account_id", "amount", "day", "start_date"}` → 201. `PATCH /investments/sips/{id}` `{"amount"?, "day"?, "account_id"?, "active"?}`, with `fund_id` and `start_date` forbidden. `DELETE /investments/sips/{id}` → `{"id"}`, or 409 "This SIP has instalments. Stop it instead."
  - `due_sip_list(db, user_id) -> list[SipResponse]`: only SIPs with something due, oldest first. Task 7 uses it.
- Messages: "Choose a fund.", "Choose a bank account." (active banks only, as in Task 5), "Enter the SIP amount." / "Amount must be greater than 0.", "Choose a day from 1 to 31.", "Choose the first instalment's date."

- [ ] **Step 1: Write the failing tests** (monkeypatch `today_india` to 2026-11-09 wherever it's imported):
  - `test_new_sip_is_due_from_its_start`: start 2026-10-05, day 5 → `due ["2026-10-05", "2026-11-05"]`.
  - `test_recording_fills_the_oldest_month`: a purchase with `sip_id` dated 2026-10-05 → `due ["2026-11-05"]`, `instalments 1`.
  - `test_linked_opening_purchases_settle_months`.
  - `test_moving_an_instalment_reopens_its_month` (Review Focus 2): PATCH that purchase's date to 2026-11-05 → `due ["2026-10-05"]`.
  - `test_stopped_sip_is_not_due`, and `test_stop_and_restart`.
  - `test_delete_rules`: without instalments → deleted. With instalments → 409.
  - `test_field_rules`, parametrised, including a broker account, an archived bank, day 0 and 32, and a forbidden `start_date` in PATCH.
  - `test_sips_are_per_user`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite and ruff. Expected: PASS.
- [ ] **Step 5:** Commit: `Add SIPs that remind instead of posting`.

### Task 7: Portfolio, dashboard, archive rule and docs

**Files:**
- Modify: `backend/app/api/routes/portfolio.py`, `backend/app/api/routes/dashboard.py`, `backend/app/api/routes/accounts.py`, `backend/app/api/portfolio.py` (`holds_shares` → `holds_units(db, user_id, account_id, kind)`)
- Modify: `docs/architecture/database-design.md`, `docs/architecture/financial-calculations.md`, `docs/architecture/ledger-design.md` (if it mentions stock-only movements), `docs/product/roadmap.md`, `docs/product/vision.md`
- Test: `backend/tests/test_portfolio.py`, `backend/tests/test_dashboard.py`, `backend/tests/test_accounts.py`

**Interfaces:**
- Produces: `GET /investments/portfolio` gains two keys (the existing four are unchanged and stock-only):
  ```
  "funds": {"holdings": [FundHolding], "by_fund": [FundTotal], "closed": [FundClosed],
            "totals": Totals, "due_sips": [SipResponse]},
  "overall": Totals
  ```
  - `FundTotal`: `fund_id, symbol, name, units, invested, average_nav, nav|null, nav_date|null, value, at_cost, unrealised, unrealised_percent`. `average_nav = fmt_nav(invested ÷ units)`.
  - `FundHolding` adds `account_id, account_name`. `FundClosed`: `fund_id, symbol, name, account_id, account_name, realised`.
  - `overall` is stocks plus funds, with the percent worked out from the summed figures.
  - The dashboard's `investments` uses overall figures and is non-null when any holding of any kind is open. `total_have` and net worth add the overall value (already true through `investments_totals`).
  - Archiving a bank account: 409 "Redeem the fund units held in {name} before archiving it." when it holds units, or "Stop the SIPs paid from {name} before archiving it." when an active SIP uses it. The broker rule is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `test_fund_figures`: the owner's Parag Parikh case. An opening purchase of 253.462 units for 21000.00, then a NAV of 84.3793 on 2026-11-05 → `by_fund` units `"253.462"`, invested `"21000.00"`, value `"21386.95"`, unrealised `"386.95"`, percent `"1.84"`, `average_nav "82.8527"`.
  - `test_opening_only_fund_is_at_cost`.
  - `test_overall_adds_stocks_and_funds`, with the stock keys unchanged by the fund (compare to a stock-only portfolio).
  - `test_due_sips_in_portfolio`.
  - `test_buying_a_fund_keeps_net_worth`: bank 50000, purchase 3000 (with its NAV auto-recorded) → net worth changes only by value − cost: `round_paise(35.552 × 84.3793) − 3000.00 = 2999.85 − 3000.00 = −0.15`, so `49999.85`, and `investments.value` is `"2999.85"`.
  - `test_archive_bank_with_units_is_409`, and `test_archive_bank_with_active_sip_is_409`. After redeeming and stopping, archiving works.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Then update the docs: in the database design, investments are built as the general model; in financial calculations, add the fund rules (`amount`, stamp duty in cost, fractional FIFO, units × NAV value, the ₹1 check, SIP due months) and the stock amount backfill; in the roadmap and vision, mutual funds are built on branch `mutual-funds`, with a link to the spec.
- [ ] **Step 4:** Run `uv run pytest`, ruff, and the PG run. Expected: all PASS, golden included.
- [ ] **Step 5:** Commit: `Count funds in the portfolio, dashboard and net worth`.

### Task 8: Website fund helpers

**Files:**
- Create: `frontend/src/lib/funds.ts`, `frontend/src/lib/funds.test.mjs`
- Modify: `frontend/src/lib/investments.ts` (`Portfolio` gains `funds` and `overall`), `frontend/package.json` (`test` script)

**Interfaces:**
- Produces: types `Fund`, `Nav`, `FundTrade`, `FundTotal`, `FundHolding`, `FundClosed`, `FundsPortfolio`, `Sip`, mirroring Tasks 4 to 7 exactly. `FundTradeMode = "buy" | "sell" | "opening" | "sip"`. `FundTradeForm = { fund_id, account_id, mode, date, units, nav, charges, amount, sip_id, note: string }`, plus:
  - `stampDuty(amount: string): string | null`: `"3000"` → `"0.15"`, `"2000.00"` → `"0.10"`.
  - `suggestedUnits(amount: string, charges: string, nav: string): string | null`: `("3000.00","0.15","84.3793")` → `"35.552"`, `("2000.00","0.10","635.0943")` → `"3.149"`. Exact BigInt arithmetic: net paise `N` and NAV in 1/10000ths `V` give thousandths of a unit = `N × 10^5 ÷ V`, rounded half up. Null for invalid input or NAV 0.
  - `unitsMismatch(form: FundTradeForm): boolean`: the server's ₹1.00 rule, for an inline warning (always false for `opening`).
  - `blankFundTradeForm(mode, date)`, `sipTradeForm(sip: Sip, date: string)` (the date, account, amount and `sip_id` from the SIP; `charges = stampDuty(amount)`; units and NAV blank), `fundTradeFormFrom(trade)`, `fundTradePayload(form, mode: "create" | "edit")` (no `side`/`opening` on edit; `nav` left out for `opening`).
  - `formatUnits("1234.567")` → `"1,234.567"`, `formatNav("84.3793")` → `"₹84.3793"`, both with Indian grouping.
  - `dueText(sip: Sip): string`: "Parag Parikh Flexi Cap – Regular Growth: ₹3,000 SIP due since 5 Nov. Record it." With two due months: "… due since 5 Oct (2 months). Record it." Whole rupees drop the `.00`.
  - `blankSipForm(date)`, `sipPayload(form, mode)`.

- [ ] **Step 1:** Write the failing tests for each function, with the exact values above.
- [ ] **Step 2:** `cd frontend && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `Add mutual fund helpers to the website`.

### Task 9: Website mutual fund screens

**Files:**
- Modify: `frontend/src/components/investments/investments-view.tsx` (a "Mutual funds" section beside Stocks: its own summary of invested, value, unrealised and realised; due-SIP banners; fund rows from `by_fund`; collapsed closed funds; and an overall figure at the top)
- Create: `frontend/src/app/(app)/investments/funds/[fundId]/page.tsx`, `frontend/src/components/investments/fund-view.tsx` (units, average NAV, value, holdings per bank, transactions, NAV history with a "from a purchase" label when `trade_id` is set, and the fund's SIPs with Stop/Restart/Delete)
- Create: `frontend/src/components/investments/fund-trade-dialog.tsx` (modes Record SIP / Buy / Redeem / Add existing units, create and edit; a new fund can be added inline by name; the SIP picker shows the fund's SIPs)
- Create: `frontend/src/components/investments/nav-dialog.tsx`, `sip-dialog.tsx`, `fund-dialog.tsx` (rename/delete)
- Modify: `frontend/src/components/dashboard/dashboard-view.tsx` only if its Investments label needs to say it includes funds

**Interfaces:**
- Consumes: Task 8, plus `shared.tsx` (`Signed`, `Notice`, `ConfirmDelete`, the button and input classes) and `ui/select.tsx`.

Behaviour to pin down:
- Record SIP from a banner opens the dialog with `sipTradeForm(sip, sip.due_date)`, and the NAV field focused. Typing a NAV fills units with `suggestedUnits` until the owner edits units by hand. Saving refreshes, so the banner moves on to the next due month or disappears.
- The dialog shows "Your bank balance won't change." for Add existing units, "₹… leaves {bank}" for purchases, and the `unitsMismatch` warning inline.
- Bank choices are active bank accounts only. With none, it says "Add a bank account first" and links to `/accounts`.
- Units are shown with 3 decimals, and NAVs with 4.
- Server field errors show under their fields, as in `trade-dialog.tsx`.

- [ ] **Step 1:** Read the Next 16 docs on dynamic route params, and the existing `[stockId]` page.
- [ ] **Step 2:** Build the screens.
- [ ] **Step 3:** `npm run lint && npm run build && npm test`. Expected: no errors.
- [ ] **Step 4: Browser check, with a test user only.**
  1. Make sure the dev PG is running (`npm run db:start` from the repo root if it isn't), then `uv run alembic upgrade head` against the dev DB.
  2. Create the user: `uv run python -m app.cli create-user funds-test@example.com`. Then, in the background, start the API with `TOKEN_SECRET=<random>` set, and start the web with the same `TOKEN_SECRET`. Poll each for readiness, at most 30 tries.
  3. Mint a token with `create_token(user.id, user.session_version, <secret>)`, and set it as the `pfm_session` cookie on `localhost:3000` in the browser.
  4. Walk through it: add a bank, add a fund with a SIP from 2026-10-05, check that two months are due, Record SIP (type the NAV 84.3793 and see that units fill to 35.552), add existing units, update the NAV, redeem part, stop the SIP, and check the stock section and dashboard. Take a screenshot of the Investments page and of the fund page.
  5. Stop both background servers.
- [ ] **Step 5:** Commit: `Add mutual funds to the website`.

### Task 10: Android fund helpers

**Files:**
- Create: `mobile/src/lib/funds.ts`, `mobile/src/lib/funds.test.mjs`
- Modify: `mobile/src/lib/investments.ts` (`Portfolio` gains `funds` and `overall`), `mobile/package.json` (`test` script)

**Interfaces:**
- Produces: the same names and behaviour as Task 8, written for the app's lib, plus the phone-form helpers in the style of `investments.ts`: `fundTradeErrors(form, today): Record<string, string>` (the server's messages), `changedFundTrade(form, original): Record<string, unknown>`, `fundTradeTitle(trade)` ("Purchased 35.552 PPFCRG", "Redeemed …", "Existing 253.462 …", with "SIP" when `sip_id` is set) and `fundTradeDeleteText(trade)`.

- [ ] **Step 1:** Write the failing tests, mirroring Task 8's cases and covering the four extra helpers.
- [ ] **Step 2:** `cd mobile && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `Add mutual fund helpers to the app`.

### Task 11: Android mutual fund screens

**Files:**
- Modify: `mobile/src/app/(tabs)/investments.tsx` (a segmented control, Stocks | Mutual funds; due-SIP cards at the top of both segments; on Mutual funds, a summary card, fund rows, closed funds and a FAB with Record SIP / Buy / Redeem / Add existing units / Add SIP)
- Create: `mobile/src/app/fund.tsx` (param `id`), `mobile/src/app/fund-trade-form.tsx` (params `mode`, `fundId`, `sipId`, `date`, `id` for edit), `mobile/src/app/nav-form.tsx` (param `fundId`), `mobile/src/app/sip-form.tsx` (params `fundId`, `id`), `mobile/src/app/fund-form.tsx` (param `id`: rename and delete)
- Modify: `mobile/src/app/_layout.tsx` (register the stack screens)

**Interfaces:**
- Consumes: Task 10, `apiFetch` with the session token, react-native-paper and `lib/theme.ts`.

Behaviour: the same rules as Task 9, laid out for a phone. Tapping a due-SIP card opens `fund-trade-form` in `sip` mode with the NAV field auto-focused and a decimal keypad, so the flow is: tap the card, type the NAV, check the units, save. Pull to refresh on the list screens.

- [ ] **Step 1:** Read the Expo SDK 58 Router docs for params and stack screens.
- [ ] **Step 2:** Build the screens.
- [ ] **Step 3:** `npm run typecheck && npm run lint && npm test`. Expected: PASS.
- [ ] **Step 4:** Commit: `Add mutual funds to the Android app`. The phone test against the deployed API is the owner's, after the web works in production.

---

## After the build (not part of these tasks)

1. Final whole-branch review on the most capable model.
2. Before merging, the owner runs `uv run alembic upgrade head` against Neon. Then open the PR, and merge once CI is green.
3. After deploy, a reviewed SQL import script covers the 14 instalments (as opening purchases linked to their SIPs), both SIPs and the 05-Nov NAVs, from the owner's statements. It is tested on the dev DB inside a rolled-back transaction first.

## Self-review notes

- Spec coverage: the general tables and data-preserving migration (T1, T2), `amount` (T2, T5), funds and symbols (T4), fund transaction rules, the consistency check and existing units (T5), fractional FIFO (T3), NAVs and auto NAVs (T4, T5), SIPs and due months (T3, T6), the portfolio, dashboard, net worth and archive rule (T7), the backward-compatible API (T1, T2, T7), web (T8, T9), Android (T10, T11), and the import (after the build).
- Non-goals (automatic NAVs, CAS import, XIRR, IDCW, switches, exit-load calculation, tax, notifications, funds in demat) have no tasks, on purpose.
- Rulings made here: the fund API names the quantity field `units`, so the units × NAV error goes on `units`. A SIP's debit dates before its `start_date` aren't due. NAVs can be deleted by hand whether or not they're linked to a trade. Downgrading refuses when fund data exists.
