# Net Worth History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Daily net worth snapshots (nightly cron plus a lazy first point), an estimated 12-month backfill, a history API with change figures, a net worth and allocation chart page on the website, and a sparkline plus history screen on the Android app.

**Architecture:**
- **Table:** `net_worth_snapshots`, one row per user per India date, unique `(user_id, date)`.
- **Maths:** the dashboard's figures move into `backend/app/api/worth.py` (`worth_of`), shared by the dashboard and the snapshot writer. Snapshot writing, backfill and history live in `backend/app/api/snapshots.py`.
- **Routes:** `routes/net_worth.py` (`GET /net-worth`); `routes/cron.py` writes snapshots after prices.
- **CLI:** `backfill-net-worth` in `app/cli.py`.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, pytest; Next.js 16; Expo SDK 58 with react-native-paper and react-native-svg; `node --test` for client helpers.

**Spec:** [docs/superpowers/specs/2026-11-13-net-worth-history-design.md](../specs/2026-11-13-net-worth-history-design.md). Its "my call" list is binding.

## Global Constraints

- Money is `Decimal`, crosses the API as two-decimal strings, and is never added or subtracted on a client. Clients convert to numbers only to place points on a chart.
- "Today" is `today_india()`, patched in tests; no test computes a date at import time.
- The migration's down_revision is `e3b81f46a0d7` and it depends on no other branch's tables. Its schema matches the model exactly (`alembic check`).
- The dashboard response does not change. Dashboard edits on both clients are self-contained components plus one-line insertions, to merge cleanly with the cash-flow branch.
- New `*.test.mjs` files are added to each client's `test` script.
- Commit after each task with a plain-sentence message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A snapshot equals the dashboard.** The same function produces both (Task 2 test compares them).
2. **Re-running a night.** The second cron run on the same date overwrites, never duplicates (Task 3).
3. **A missed night.** A run after a gap writes only today (Task 3).
4. **Backfill never overwrites a real snapshot** and writes nothing after the first one (Task 4).
5. **"Last month" with no nearby snapshot** is `null`, not ₹0 (Task 5).

---

### Task 1: Table and migration

**Files:** create `backend/app/models/snapshot.py`; modify `backend/app/models/__init__.py`; create `backend/migrations/versions/2026_11_13_1200-<rev>_add_net_worth_snapshots.py`; modify `backend/tests/test_pg_migrations.py` (`ALL_TABLES`).

- [ ] Add `net_worth_snapshots` to `ALL_TABLES`, and a model test that a second row for the same user and date raises `IntegrityError`.
- [ ] Write the model and the hand-written migration (unique constraint `uq_net_worth_snapshots_user_id` on `user_id, date`; downgrade drops the table).
- [ ] `uv run pytest`, `uv run ruff check .`; commit.

### Task 2: Shared worth maths

**Files:** create `backend/app/api/worth.py`; modify `backend/app/api/routes/dashboard.py`.

- [ ] Test: `worth_of` for a user with a bank, a card, a PPF, a stock and a fund gives the same net worth, have, owe and split as `GET /dashboard`.
- [ ] Move the have/owe/split code from `get_dashboard` into `worth_of`; the dashboard calls it. Existing dashboard tests pass unchanged.
- [ ] Commit.

### Task 3: Snapshot writer and the cron

**Files:** create `backend/app/api/snapshots.py`; modify `backend/app/api/routes/cron.py`; tests `backend/tests/test_snapshots.py`, `backend/tests/test_cron.py`.

- [ ] Tests: `write_snapshot` stores the dashboard's figures; writing the same date twice leaves one row with the newer figures; `snapshot_all` skips users with nothing and returns the count; a run after a missed day writes only today; the cron response has `snapshots`, and the snapshot is taken after prices are applied (a linked holding's new price shows in the stored `stocks`).
- [ ] Implement with dialect upserts (`INSERT … ON CONFLICT`), as `app/prices/refresh.py` does.
- [ ] Commit.

### Task 4: Backfill

**Files:** `backend/app/api/snapshots.py`, `backend/app/cli.py`; tests in `test_snapshots.py` and `test_cli.py`.

- [ ] Tests: month-ends for 12 months before the current month; balances replayed to each month-end (expense, income, transfer, card, EMI, PPF deposit, broker trade cash); investments zero; accounts counted from their first transaction or creation; archived accounts counted before their archive date; month-ends on or after the first real snapshot skipped; real snapshot never overwritten; a re-run replaces earlier estimates; CLI by email and for all users, with an unknown email an error.
- [ ] Implement `backfill(db, user_id, today, months=12)` and the `backfill-net-worth` command.
- [ ] Commit.

### Task 5: History API

**Files:** create `backend/app/api/routes/net_worth.py`; modify `backend/app/api/router.py`; test `backend/tests/test_net_worth.py`.

- [ ] Tests: empty user → no points, nulls, no row written; first load writes today's row once; points are filtered by range (3m, 6m, 1y, all) and end with today's live figures; `since_last_month` picks the nearest within 16 days, ties earlier, `null` when none; `since_start` against the first point in range; `tracked_since`; a bad range is 422; other users' snapshots never show; 401 without a token.
- [ ] Implement. Commit.

### Task 6: Website helpers

**Files:** create `frontend/src/lib/net-worth.ts` and `net-worth.test.mjs`; add to the `test` script.

- [ ] Tests then code: `changeText` ("▲ ₹22,000 since last month", "▼ …", "No change since last month", null handling), `shortRupees` axis labels (₹5L, ₹1.2Cr, ₹40K), `lineGeometry` (x by date, y scaled, segments split on gaps over 45 days and on estimated/real), `stackGeometry` (negatives as zero), `nearestIndex` for the tooltip, `RANGES`.
- [ ] Commit.

### Task 7: Website screens

**Files:** create `frontend/src/components/net-worth/*.tsx`, `frontend/src/app/(app)/net-worth/page.tsx`; modify the dashboard view (tile link plus one child line) and the sidebar (one link).

- [ ] Build the page and the dashboard trend. `npm run lint`, `npm test`, `npx tsc --noEmit`, `npm run build`. Commit.

### Task 8: Android helpers and screens

**Files:** create `mobile/src/lib/net-worth.ts` and `.test.mjs`; `mobile/src/components/net-worth-chart.tsx`; `mobile/src/app/net-worth.tsx`; modify `mobile/src/app/_layout.tsx` (one screen line), `mobile/src/components/dashboard-view.tsx` (tile press plus one child line).

- [ ] Tests then helpers (change text, sparkline path, month-end list). Screens. `npm run lint`, `npm run typecheck`, `npm test`. Commit.

## After the build

- **Migration:** flag before merge; the owner runs `alembic upgrade head` on Neon by hand. The cash-flow branch's migration also follows `e3b81f46a0d7`, so whichever merges second is re-parented.
- **Backfill on production:** after the migration and the first deploy, the owner runs `python -m app.cli backfill-net-worth` against Neon once, if wanted.
- **Device check:** add the Android items to the pending list.
- **ADR-004:** still to be written by the owner.
