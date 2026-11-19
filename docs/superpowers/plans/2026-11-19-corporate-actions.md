# Corporate Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch splits, consolidations, bonuses, dividends, mergers and demergers from NSE/BSE nightly, let the owner confirm them, and apply them inside the FIFO replay so holdings, P&L and dividend income stay right.

**Architecture:** A shared `corporate_actions` table (like `market_codes`) is filled by a new last step of the nightly job. Per-user `stock_actions` rows record the owner's decision (`pending`/`applied`/`dismissed`). `replay()` in `backend/app/api/portfolio.py` takes applied actions alongside trades in one date-ordered stream and reports dividends and which actions touched a lot. Trades are never rewritten.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, Alembic, Postgres (SQLite in tests), pytest via `uv`; Next.js 16 web, Expo mobile, `node --test` for client libs.

**Spec:** `docs/superpowers/specs/2026-11-19-corporate-actions-design.md`

## Global Constraints

- Indian equities only (`Instrument.kind == "stock"`), INR, India dates via `app.api.dates.today_india`.
- Money: `round_paise` (ROUND_HALF_UP to 0.01). Quantities: exact `Decimal`.
- Never create a ledger entry or transaction for a dividend; net worth must not change.
- Nightly step runs **after** stock prices, budget `ACTIONS_BUDGET_SECONDS = 15`, own commit; any failure goes into `RefreshReport.failed["actions"]` and never raises out of `run_nightly`.
- Fetch window: ex-dates from `today - 7 days` to `today + 60 days`.
- Dividend link suggestion: Dividends-category credit within 45 days after ex-date, amount 85%–100% of that account's gross.
- Safety net: held stock close drops more than 35% day-on-day with no known share-changing action within ±3 days of that date.
- Status values: `pending`, `applied`, `dismissed`. Kinds: `split`, `consolidation`, `bonus`, `dividend`, `demerger`, `merger`, `other`.
- Every new user table is exported in backup; `corporate_actions` is excluded with reason "Shared public market data, refetched nightly".
- Backend commands run from `backend/`: `uv run pytest …`, `uv run ruff check .`. Web/mobile: `npm test` in `frontend/` / `mobile/` (add new `.test.mjs` files to the `test` script list).

## Review Focus

1. **Owner edits an old opening lot after this ships** → its `basis_date` moves to today, so past splits stop applying to it (the owner re-entered today's broker numbers). Test in Task 1.
2. **A trade dated on the ex-date itself** → it's already at the new basis and must not be multiplied. Test in Task 2.
3. **Un-applying a split after selling post-split shares** → refused with the stock and date named, never leaves a negative holding. Test in Task 4.
4. **NSE returns HTML (blocked) or empty JSON** → treated as `SourceError`, BSE fallback tried, prices and snapshots unaffected. Test in Task 6.
5. **Same event fetched again on later nights / from both NSE and BSE** → no duplicate `corporate_actions` or `stock_actions` rows, and a dismissed action is never re-opened. Test in Task 7.

---

### Task 1: Tables, `basis_date`, export

**Files:**
- Create: `backend/app/models/corporate_action.py`
- Modify: `backend/app/models/investment.py` (Instrument, InvestmentTrade), `backend/app/models/__init__.py`, `backend/app/export/tables.py` (EXCLUDED)
- Create: `backend/migrations/versions/2026_11_19_1200-<rev>_add_corporate_actions.py` (down_revision = head `b7d2e4f6a813`)
- Test: `backend/tests/test_corporate_action_models.py`, modify `backend/tests/test_export_coverage.py::test_the_decisions_so_far`

**Interfaces:**
- Produces:
  - `CorporateAction` (`corporate_actions`): `id, symbol String(20), isin String(12)|None, kind String(14), ex_date Date, record_date Date|None, ratio_new Numeric(14,6)|None, ratio_old Numeric(14,6)|None, amount_per_share Numeric(14,4)|None, purpose String(300), purpose_key String(300), source String(4), created_at`; unique (`symbol, kind, ex_date, purpose_key`).
  - `StockAction` (`stock_actions`): `id, user_id, instrument_id, corporate_action_id|None, kind, ex_date, ratio_new, ratio_old, amount_per_share, status String(10), target_instrument_id|None, cost_share_pct Numeric(7,4)|None, created_at, updated_at`; unique (`user_id, instrument_id, corporate_action_id`).
  - `DividendLink` (`dividend_links`): `id, user_id, stock_action_id, transaction_id`; unique (`stock_action_id, transaction_id`).
  - `InvestmentTrade.basis_date: Date` (not null), `Instrument.actions_backfilled_at: DateTime|None`, `Instrument.suspect_drop_on: Date|None`.
  - `normalise_purpose(text: str) -> str` in `corporate_action.py` (lower-case, collapse whitespace, strip punctuation) used for `purpose_key`.

- [ ] **Step 1: Write failing tests**

```python
def test_basis_date_set_on_create_to_today_india(db, user, stock, broker, freeze_india_today):
    t = InvestmentTrade(..., date=date(2020, 1, 1), opening=True)  # created "today" = 2026-11-19
    db.add(t); db.flush()
    assert t.basis_date == date(2026, 11, 19)

def test_basis_date_moves_when_quantity_or_price_edited(...):
    # created 2026-11-19, freeze to 2026-12-01, edit quantity -> basis 2026-12-01
    # edit only note -> basis unchanged

def test_same_event_twice_is_one_row(db):
    # two CorporateAction with same symbol/kind/ex_date/purpose_key -> IntegrityError
def test_interim_and_special_dividend_same_day_are_two_rows(db): ...
```
Export: `test_the_decisions_so_far` asserts excluded == `{"users", "market_codes", "corporate_actions"}` and `{"stock_actions", "dividend_links"} <=` exported.

- [ ] **Step 2: Run** `uv run pytest tests/test_corporate_action_models.py tests/test_export_coverage.py -v` → FAIL (import errors).
- [ ] **Step 3: Implement models, migration, export exclusion.** `basis_date` is maintained by a SQLAlchemy `before_insert` / `before_update` event listener on `InvestmentTrade` (set to `today_india()` on insert; on update only when `quantity` or `price` history `has_changes()`), so all four creation sites (`routes/trades.py`, `export/holdings_import.py`, `sms/expected.py`, `sms/review.py`) are covered without edits. Migration backfills `basis_date = (updated_at AT TIME ZONE 'Asia/Kolkata')::date`, then sets NOT NULL (SQLite-safe batch op as other migrations do). Restore must carry `basis_date` as exported (no listener overwrite during restore — check `export/backup.py` restore path and set the value explicitly after insert if the listener fires).
- [ ] **Step 4: Run** the same tests plus `uv run pytest tests/test_export_restore.py tests/test_pg_migrations.py` → PASS.
- [ ] **Step 5: Commit** `feat: corporate action tables and trade basis date`

---

### Task 2: Replay — split, consolidation, bonus, basis rule

**Files:**
- Modify: `backend/app/api/portfolio.py`
- Test: `backend/tests/test_portfolio_actions_math.py`

**Interfaces:**
- Consumes: nothing from DB.
- Produces:
  - `TradeRow` gains last field `basis_date: date | None = None` (None ⇒ treat as `date`; keeps existing positional constructors working).
  - `class ActionRow(NamedTuple): id: int; instrument_id: int; kind: str; ex_date: date; ratio_new: Decimal | None; ratio_old: Decimal | None; amount_per_share: Decimal | None; target_instrument_id: int | None; cost_share_pct: Decimal | None`
  - `replay(trades: Iterable[TradeRow], actions: Iterable[ActionRow] = ()) -> Replay`
  - `Replay` gains `dividends: dict[tuple[int, int], Decimal]` (key `(action_id, account_id)`, gross ₹) and `touched: set[int]` (action ids that changed at least one lot). Default-empty for existing callers.

Algorithm (one stream, not per group): build events = trades + actions; sort key `(date, 0 action | 1 buy | 2 sell, id)`. Lots per `(instrument, account)` are `[quantity, cost, basis_date]`. An action applies to every account's lots of `action.instrument_id`, but only to lots with `basis_date < ex_date`. Bonus/merger/demerger new lots get `basis_date = ex_date` only for bonus; merger/demerger keep the source lot's `basis_date`.

- [ ] **Step 1: Write failing tests** (helper `a(id, kind, ex, new=None, old=None, amt=None, stock=1, target=None, pct=None)`)

```python
def test_split_multiplies_quantity_keeps_cost():
    r = replay([t(1,"buy",D1,40,1500)], [a(9,"split",D2,new=5,old=1)])
    p = r.positions[(1,1)]
    assert p.quantity == 200 and p.invested == D("60000.00")
    assert r.touched == {9}

def test_consolidation_divides_quantity():  # 100 shares, 1:10 -> 10, cost same
def test_bonus_adds_zero_cost_lot_and_fifo_sells_it_last():
    # 10 @100 on D1, bonus 1:1 on D2, sell 10 on D3 -> realised from the original lot (cost 1000)
def test_bonus_floors_per_position():  # 3 shares, bonus 1:2 -> +1
def test_trade_on_ex_date_is_not_adjusted():
    r = replay([t(1,"buy",D1,10,100), t(2,"buy",D2,5,20)], [a(9,"split",D2,new=5,old=1)])
    assert r.positions[(1,1)].quantity == 55
def test_lot_with_basis_on_or_after_ex_date_is_untouched():
    opening = t(1,"buy",date(2020,1,1),200,300, opening=True)._replace(basis_date=date(2026,11,19))
    r = replay([opening], [a(9,"split",date(2023,5,1),new=5,old=1)])
    assert r.positions[(1,1)].quantity == 200 and 9 not in r.touched
def test_action_applies_in_every_account():  # account 1 and 2 both adjusted
def test_partial_sell_after_split_keeps_paise_exact(): ...
def test_existing_behaviour_without_actions_unchanged():  # all of test_portfolio_math still passes
```
- [ ] **Step 2: Run** `uv run pytest tests/test_portfolio_actions_math.py -v` → FAIL.
- [ ] **Step 3: Implement** the stream replay with split/consolidation/bonus; leave merger/demerger/dividend raising nothing yet (Task 3).
- [ ] **Step 4: Run** `uv run pytest tests/test_portfolio_actions_math.py tests/test_portfolio_math.py tests/test_portfolio.py -v` → PASS.
- [ ] **Step 5: Commit** `feat: replay applies splits and bonuses`

---

### Task 3: Replay — merger, demerger, dividends

**Files:** Modify `backend/app/api/portfolio.py`; Test `backend/tests/test_portfolio_actions_math.py`

**Interfaces:** Produces `Replay.dividends` filled; positions for `target_instrument_id` created as needed.

- [ ] **Step 1: Write failing tests**

```python
def test_merger_moves_lots_to_target_keeping_cost_and_dates():
    # 10 @100 (D1) + 5 @120 (D2) of stock 1, merger 7:5 into stock 2 on D3
    # stock 1 qty 0; stock 2 qty floor(15*7/5)=21, invested 1600.00
def test_merger_fraction_removed_from_newest_lot():
    # 3 + 3 shares, ratio 1:2 -> exact 1.5+1.5=3 -> 3 (no loss); 3+2 -> 2.5 -> 2, newest lot loses 0.5
def test_demerger_splits_cost_by_pct():
    # 10 @100 =1000, demerger 1:1 into stock 2, pct 6.5 -> child 10 shares cost 65.00, parent 935.00
def test_demerger_cost_rounding_never_loses_paise(): ...
def test_dividend_entitlement_is_eve_of_ex_date_per_account():
    # acct1 10 shares, acct2 5 shares, buy 5 more in acct1 on ex-date -> (9,1)=10*amt, (9,2)=5*amt
def test_dividend_ignores_lots_with_basis_on_or_after_ex_date(): ...
def test_dividend_not_in_touched():  # dividends never mark touched
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** all `tests/test_portfolio*` → PASS.
- [ ] **Step 5: Commit** `feat: replay handles mergers, demergers and dividends`

---

### Task 4: Wire applied actions into every replay caller

**Files:**
- Modify: `backend/app/api/portfolio.py` (add loader; `investments_totals`, `holds_units`), `backend/app/api/goals.py:295`, `backend/app/api/worth.py:51`, `backend/app/api/trade_checks.py:138`, `backend/app/api/routes/portfolio.py`, `load_trade_rows` (select `basis_date`)
- Test: `backend/tests/test_stock_actions_wiring.py`

**Interfaces:**
- Produces: `load_action_rows(db: Session, user_id: int) -> list[ActionRow]` (status `applied` only); `user_replay(db, user_id, account_id: int | None = None) -> Replay` convenience used by all callers.

- [ ] **Step 1: Write failing tests** (API level, using existing fixtures in `conftest.py`)

```python
def test_applied_split_shows_in_holdings(client, ...):  # GET /investments/portfolio shares 200
def test_pending_split_changes_nothing(...):
def test_sell_beyond_pre_split_quantity_allowed_after_split(...):  # sell 150 after 40->200 split: 201
def test_deleting_buy_that_leaves_post_split_sell_short_is_refused(...):  # 409 names symbol+date
def test_net_worth_and_goals_use_applied_actions(...):
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** loader + pass actions everywhere `replay(` is called (grep `replay(` must show only `user_replay`/tests). **Step 4: Run** `uv run pytest` (full suite) → PASS.
- [ ] **Step 5: Commit** `feat: holdings, net worth and goals use applied corporate actions`

---

### Task 5: Parse NSE/BSE corporate action data

**Files:**
- Create: `backend/app/prices/actions_parse.py`
- Create fixtures: `backend/tests/fixtures/prices/nse_actions.json`, `bse_actions.json` (real samples captured in Task 6 Step 1; until then hand-written in the documented shape)
- Test: `backend/tests/test_actions_parse.py`

**Interfaces:**
- Produces: `class ParsedAction(NamedTuple): symbol: str; isin: str | None; kind: str; ex_date: date; record_date: date | None; ratio_new: Decimal | None; ratio_old: Decimal | None; amount_per_share: Decimal | None; purpose: str; source: str`
- `parse_purpose(text: str) -> list[tuple[str, Decimal|None, Decimal|None, Decimal|None]]` — (kind, ratio_new, ratio_old, amount); one purpose can hold several (e.g. "Dividend - Rs 5 Per Share / Bonus 1:1" → two).
- `parse_nse_actions(payload) -> list[ParsedAction]`, `parse_bse_actions(payload) -> list[ParsedAction]` (BSE gives scrip code → map to NSE symbol via ISIN against `market_codes`; rows with no NSE match are dropped).

- [ ] **Step 1: Write failing tests** — table-driven `parse_purpose` cases:

| text | expected |
|---|---|
| `Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share` | `("split", 10, 1, None)` |
| `Face Value Split (Sub-Division) - From Rs 2/- Per Share To Re 1/- Per Share` | `("split", 2, 1, None)` |
| `Consolidation Of Shares From Re 1/- Per Share To Rs 10/- Per Share` | `("consolidation", 1, 10, None)` |
| `Bonus 1:1` | `("bonus", 1, 1, None)` |
| `Bonus 3:2` | `("bonus", 3, 2, None)` |
| `Interim Dividend - Rs 2.50 Per Share` | `("dividend", None, None, 2.50)` |
| `Final Dividend - Rs 10 Per Share / Special Dividend - Rs 5 Per Share` | two dividends 10 and 5 |
| `Dividend - Re 0.75 Per Share` | `("dividend", None, None, 0.75)` |
| `Scheme Of Arrangement` / `Demerger` | `("demerger", None, None, None)` (ratio entered by owner) |
| `Amalgamation` | `("merger", None, None, None)` |
| `Annual General Meeting` | `[]` (ignored) |
| `Rights 1:5 @ Premium Rs 100/-` | `[]` (out of scope) |
| anything else non-empty with a money/ratio word | `("other", None, None, None)` |

Plus: `parse_nse_actions` on fixture returns expected rows with `ex_date` parsed from `DD-Mon-YYYY`; malformed rows skipped, not raised.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (regexes; split ratio = old FV : new FV). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: parse NSE and BSE corporate actions`

---

### Task 6: Fetcher methods

**Files:** Modify `backend/app/prices/fetch.py`, `backend/tests/price_fakes.py`; Test `backend/tests/test_price_fetch.py`

**Interfaces:**
- Produces on `Fetcher`: `nse_actions(start: date, end: date, symbol: str | None = None) -> list` and `bse_actions(start: date, end: date) -> list`. `FakeFetcher` serves `nse_actions.json` / `bse_actions.json`, honours `fail`/`crash` by method name, and records calls.

- [ ] **Step 1: Verify the live endpoints** from a local shell (not Vercel): NSE `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY[&symbol=X]` after a GET to `https://www.nseindia.com` for cookies; BSE `https://api.bseindia.com/BseIndiaAPI/api/DefaultData/w` with its `Referer: https://www.bseindia.com/` header and date params. Save one real response of each as the Task 5 fixtures (trimmed to ~20 rows) and fix Task 5 parsers if the shape differs. Record the exact params in a comment in `fetch.py`.
- [ ] **Step 2: Write failing tests** with `httpx.MockTransport`: cookie request precedes API request; HTML/non-JSON body → `SourceError`; 403 → `SourceError`; timeout uses `NSE_TIMEOUT`.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** `uv run pytest tests/test_price_fetch.py -v` → PASS.
- [ ] **Step 6: Commit** `feat: fetch corporate actions from NSE with BSE fallback`

---

### Task 7: Nightly step — store, match, backfill

**Files:**
- Create: `backend/app/prices/actions_refresh.py`
- Modify: `backend/app/prices/refresh.py` (`run_nightly` calls `refresh_actions` last; `RefreshReport.updated["actions"]`), `backend/app/api/routes/stocks.py` / `routes/market.py` (`set_link` clears `actions_backfilled_at`)
- Test: `backend/tests/test_actions_refresh.py`

**Interfaces:**
- Consumes: `Fetcher.nse_actions/bse_actions`, `parse_*`, `user_replay`, `load_trade_rows`.
- Produces: `refresh_actions(db, fetcher, today: date, report: RefreshReport, clock=time.monotonic) -> None`; `match_to_users(db, actions: list[CorporateAction]) -> int` (rows created).

Matching rules (per user instrument with `kind == "stock"` and `source_code == action.symbol`):
- Skip if a `stock_actions` row exists for (user, instrument, corporate_action_id) — never re-open a dismissed one.
- Past or today ex-date: holder if replay of trades **before** ex-date holds > 0 shares of lots with `basis_date < ex_date`. Future ex-date: holder if currently holding.
- `dividend` → `applied`. `other` → `pending`. Share-changing kinds → run `replay` with this action added as applied; if `id not in touched` → `dismissed`, else `pending`. `merger`/`demerger` always `pending` (need target).
- Backfill: after the window fetch, for linked stock instruments with `actions_backfilled_at IS NULL`, ordered by id, call `nse_actions(earliest_trade_date, today, symbol)` while budget remains; store + match; set `actions_backfilled_at = now`. On `SourceError` leave null (retry next night).

- [ ] **Step 1: Write failing tests** with `FakeFetcher`:

```python
def test_split_for_held_stock_creates_pending_row(...)
def test_split_for_opening_lot_entered_after_ex_date_is_silently_dismissed(...)
def test_dividend_for_held_stock_is_applied(...)
def test_not_held_stock_gets_no_row(...)
def test_running_twice_creates_no_duplicates(...)          # Review Focus 5
def test_same_event_from_nse_and_bse_stored_once(...)       # Review Focus 5
def test_dismissed_row_not_reopened(...)
def test_nse_down_falls_back_to_bse(...)
def test_both_down_reports_failure_and_prices_still_saved(...)  # Review Focus 4
def test_backfill_respects_budget_and_resumes_next_night(...)
def test_linking_a_stock_queues_backfill(...)
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `uv run pytest tests/test_actions_refresh.py tests/test_price_refresh.py tests/test_cron.py -v` → PASS.
- [ ] **Step 5: Commit** `feat: nightly corporate actions fetch and matching`

---

### Task 8: Nightly step — ISIN renames and missed-action safety net

**Files:** Modify `backend/app/prices/actions_refresh.py`, `backend/app/prices/refresh.py`; Test `backend/tests/test_actions_refresh.py`

**Interfaces:** Produces `follow_renames(db) -> int` (run after the equity list upsert) and `flag_suspect_drops(db, today: date) -> int` (sets `Instrument.suspect_drop_on`; cleared when a share-changing `stock_actions` row is created within ±3 days of it, or when the owner dismisses the notice via Task 9 API).

- [ ] **Step 1: Write failing tests**: instrument linked to `OLDSYM` whose ISIN now appears under `NEWSYM` in `market_codes` (and `OLDSYM` gone) → `source_code == "NEWSYM"`, symbol unchanged; close 1000 → 600 (−40%) held, no action → flagged; −30% → not flagged; −40% with a split row on that date → not flagged.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: follow symbol renames and flag possible missed actions`

---

### Task 9: Corporate actions API

**Files:**
- Create: `backend/app/api/routes/corporate_actions.py` (router prefix `/investments`, registered like `stocks.py`)
- Modify: `backend/app/api/routes/portfolio.py` (dividends in `Figures`/`Totals`)
- Test: `backend/tests/test_corporate_actions_api.py`

**Interfaces (response shape `ActionResponse`):** `id, stock_id, symbol, kind, ex_date, ratio_new, ratio_old, amount_per_share, status, purpose, target_stock_id, cost_share_pct, preview: {shares_before, shares_after, average_before, average_after} | None, dividend: {gross, by_account: [{account_id, account_name, gross, links: [transaction_id]}]} | None`.

| Route | Behaviour |
|---|---|
| `GET /investments/actions?status=pending` | list + `pending_count` |
| `GET /investments/stocks/{id}/actions` | all of the stock's rows, upcoming first, plus `suspect_drop_on` and `backfilled: bool` (false → client shows "Checking past corporate actions…") |
| `POST /investments/stocks/{id}/actions` | manual row, `pending`, `corporate_action_id = null` |
| `PATCH /investments/actions/{id}` | edit fields while `pending`; `status` change to `applied`/`dismissed`/`pending`. Applying merger/demerger requires `target_stock_id`; demerger also `cost_share_pct` in (0, 100). Applying or un-applying runs `trade_checks.shortfall_check` with the action set changed → 409 naming symbol+date (Review Focus 3) |
| `GET /investments/actions/{id}/link-suggestions` | per account, rules from Global Constraints |
| `POST/DELETE /investments/actions/{id}/links/{transaction_id}` | link/unlink; transaction must be the user's credit |
| `DELETE /investments/stocks/{id}/suspect-drop` | clear the notice |

Family view (`backend/app/api/routes/family.py`): wherever it sums members' investment totals, add `dividends` the same way; test one member with a dividend.

Portfolio: `Figures` gains `dividends: str` (gross, all time, per holding/stock); `Totals` gains `dividends: str`, `dividends_fy: str` (Indian FY Apr–Mar by ex-date), `total_return: str` (= unrealised + realised + dividends).

- [ ] **Step 1: Write failing tests** for each route row above, including: preview for 40 @₹1,500 split 1:5 → `200`, `"300.00"`; un-apply refused case; other user's action → 404; link suggestions pick a ₹900 credit for ₹1,000 gross and reject ₹800 and one 50 days later.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** full `uv run pytest` and `uv run ruff check .` → PASS.
- [ ] **Step 5: Commit** `feat: corporate actions API and dividend totals`

---

### Task 10: Web UI

**Files:**
- Create: `frontend/src/lib/corporate-actions.ts` (+ `corporate-actions.test.mjs`, added to `npm test`), `frontend/src/components/investments/actions-review.tsx`, `frontend/src/components/investments/stock-actions.tsx`
- Modify: `frontend/src/components/investments/investments-view.tsx` (review card at top when `pending_count > 0`; Dividends received / total return in totals), `frontend/src/components/investments/stock-view.tsx` (Actions & dividends section, suspect-drop notice)

**Interfaces:** `corporate-actions.ts` exports `listActions(status)`, `stockActions(stockId)`, `createAction`, `updateAction`, `linkSuggestions`, `link`, `unlink`, and pure `describeAction(a): string` / `describePreview(p): string`.

- [ ] **Step 1: Failing lib tests** for the pure helpers: `describeAction` → `"Split 1:5 on 12 Mar 2026"`, `"Bonus 1:1 on …"`, `"Dividend ₹2.50/share on …"`; `describePreview` → `"40 → 200 shares · avg ₹1,500.00 → ₹300.00"` (Indian digit grouping as other libs).
- [ ] **Step 2: Run** `npm test` in `frontend/` → FAIL. **Step 3: Implement** lib and components in the existing chunky UI style (copy patterns from `price-dialog.tsx`, `link-prompt.tsx`); merger/demerger confirm opens a dialog asking target stock (and cost % for demerger).
- [ ] **Step 4: Run** `npm test`, `npm run lint`, `npm run build` → PASS. Run the app and check the review card, confirm, undo, and stock page by hand.
- [ ] **Step 5: Commit** `feat(web): review corporate actions and show dividends`

---

### Task 11: Mobile UI

**Files:** Modify `mobile/src/lib/investments.ts` (+ `investments.test.mjs`), `mobile/src/app/(tabs)/investments.tsx`, `mobile/src/components/investment-parts.tsx`; stock detail screen wherever the mobile stock page lives (find via `grep stockId mobile/src/app`).

- [ ] **Step 1: Failing lib tests** mirroring Task 10's `describeAction`/`describePreview` cases.
- [ ] **Step 2: Run** `npm test` in `mobile/` → FAIL. **Step 3: Implement** review card, confirm/dismiss, dividends on stock screen and totals.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run lint` → PASS.
- [ ] **Step 5: Commit** `feat(mobile): review corporate actions and show dividends`
