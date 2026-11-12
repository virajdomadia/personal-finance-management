# Add Investment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One "Add investment" flow on both clients that creates a new instrument and its first purchase in one atomic save, with price, NAV, link, SIP, buy and sell as actions on the holding screen, and the app's investment form screens cut from 11 to 5.

**Architecture:**
- **Backend:** three composite routes, `POST /investments/{stocks,funds,coins}/with-trade`, built from the existing create and save-check helpers (split into "add, flush" and "commit" halves). No migration.
- **Website:** `AddInvestmentDialog` (type step, then the kind's trade dialog or the account dialog); the trade dialogs' new-instrument path calls the composite route.
- **Android:** `add-investment` (type step), `trade-form?kind=` (dispatches to the three trade forms moved to `src/components/trade-forms/`), `price-form?kind=`, `holding-form?kind=` (rename, delete, link), `sip-form`.

**Tech Stack:** FastAPI, SQLAlchemy 2, pytest; Next.js 16; Expo SDK 58, Expo Router, react-native-paper; `node --test` `.mjs` helper tests.

**Spec:** [docs/superpowers/specs/2026-11-12-add-investment-design.md](../specs/2026-11-12-add-investment-design.md).

## Global Constraints

- Money is `Decimal` on the server and strings in JSON. Clients do no money arithmetic beyond what already exists.
- No existing response shape changes. No migration.
- Validation errors are `RequestValidationError([field_error(field, message)])` → 422; the composite routes reuse the existing messages and field names.
- Web and Android each get their own UI.
- Empty-state copy on investment screens doesn't change (the first-run work owns it).
- Commit after each task, ending messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A refused first trade leaves nothing behind.** An archived broker, a missing price or a units × NAV mismatch returns 422 and no instrument exists afterwards (Task 1 tests).
2. **A duplicate symbol** is reported on `symbol`, and no trade is saved.
3. **A linked new fund** gets the market NAV, and its first purchase's NAV wins on that date, as with two requests.
4. **Nothing became impossible.** Sell, redeem, record a SIP that isn't due, add a SIP for a new fund, rename, delete, link, unlink, and update price or NAV all still have a way in on both clients.

---

### Task 1: Composite routes (tests first)

**Files:**
- Test: `backend/tests/test_new_holdings.py`
- Modify: `backend/app/api/routes/stocks.py`, `funds.py`, `coins.py` (split create into `add_*` + commit)
- Modify: `backend/app/api/routes/trades.py`, `fund_trades.py`, `crypto_trades.py` (split create into `add_*_trade` + commit; add the `/with-trade` route)

- [ ] Write tests: each kind creates both (201, figures and cash as two requests would leave them); opening buys; linked creation; a refused trade (archived account, missing field, mismatch, future date) is 422 with nothing created; duplicate symbol; `side` and an instrument id are rejected; another user's account is refused.
- [ ] Run them and see them fail (404).
- [ ] Implement; run the whole suite and `ruff check`.
- [ ] Commit.

### Task 2: Website

**Files:**
- Create: `frontend/src/components/investments/add-investment-dialog.tsx`
- Modify: `trade-dialog.tsx`, `fund-trade-dialog.tsx`, `crypto-trade-dialog.tsx` (composite save, prefill from a market match, optional `onBack`/step line)
- Modify: `investments-view.tsx` (header button, section buttons removed, empty states open the dialog)
- Modify: `frontend/src/components/accounts/account-dialog.tsx` (optional initial type)
- Modify: `frontend/src/lib/investments.ts` + test (`prefillFromMatch`, `withTradePath`)

- [ ] Helpers with tests; dialog; wire up; lint, test, tsc, build. Commit.

### Task 3: Android

**Files:**
- Create: `mobile/src/app/add-investment.tsx`, `mobile/src/app/holding-form.tsx`
- Move: `trade-form.tsx`, `fund-trade-form.tsx`, `crypto-trade-form.tsx` → `mobile/src/components/trade-forms/`; new `trade-form.tsx` dispatches on `kind`
- Merge: `price-form.tsx`, `nav-form.tsx`, `coin-price-form.tsx` → `price-form.tsx?kind=`
- Merge: `stock-form.tsx`, `fund-form.tsx`, `coin-form.tsx`, `link-form.tsx` → `holding-form.tsx?kind=`
- Create: `mobile/src/components/market-search.tsx` (from `link-form`)
- Modify: `(tabs)/investments.tsx` (one FAB), `stock.tsx`, `fund.tsx`, `coin.tsx` (new routes), `account-form.tsx` (`type` param)
- Modify: `mobile/src/lib/investments.ts` + test (same helpers as the website)

- [ ] Helpers with tests; screens; routes; lint, typecheck, test. Commit.

### Task 4: Device-check list

- [ ] Add the new screens to the pending device-check list in the final report.
