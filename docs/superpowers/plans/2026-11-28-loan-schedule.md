# Loan Repayment Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each loan's repayment schedule (month-by-month EMI split, payoff date, interest still to pay), computed on the fly.

**Architecture:** A pure function in `backend/app/api/loans.py` builds the rows from what's owed, the rate, the EMI and the first month; `GET /api/accounts/{id}/schedule` feeds it today's balance and the first unpaid month. Web gets a Schedule dialog on loan rows, the phone a schedule screen. Nothing is stored.

**Tech Stack:** FastAPI + SQLAlchemy (backend/), Next.js (frontend/), Expo Router (mobile/). Tests: pytest, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-28-loan-schedule-design.md`

## Global Constraints

- Ponytail mode: smallest complete change; reuse `balance_of`, `load_book`, `clamped_date` (app/api/dates.py), `emis_paid` (app/sms/expected.py), `_round` (loans.py, half up to paise), `fmt`; no new dependencies, no migration.
- Interest = balance × rate ÷ 1200, rounded half up to the paisa — the same rule as `next_emi`.
- Messages, verbatim: `"Only a loan has a repayment schedule."` (422), `"Add the interest rate to see the schedule."`, `"Add the EMI to see the schedule."`, `"This EMI doesn't cover the monthly interest, so the loan never gets paid off."`, `"This schedule runs past 50 years. Check the EMI and the rate."`
- Row cap: 600.
- Backend tests with `ENVIRONMENT=test`; ruff check + format on touched files.
- Do NOT edit `mobile/package.json` `scripts.test`. Phone helper tests go in `mobile/src/lib/accounts.test.mjs` (already listed).

## Review Focus

- A loan whose balance is already 0 (paid off): `paid_off: true`, no rows, no problem. Test in Task 1.
- An EMI equal to the monthly interest (principal 0 forever): treated as never paying off. Test in Task 1.
- Rate 0 (interest-free loan): rows with 0 interest, ends after ceil(owed ÷ EMI) months. Test in Task 1.
- Due day 31 in a 30-day month or February: the date clamps to the month's last day. Test in Task 1.
- This month's EMI already recorded: the schedule starts next month. Test in Task 1.

---

### Task 1: Backend schedule

**Files:**
- Modify: `backend/app/api/loans.py` (pure function + models)
- Modify: `backend/app/api/routes/accounts.py` (route, after `investment-activity`)
- Test: `backend/tests/test_loan_schedule.py` (new; reuse `loan`, `make`, `auth` helpers from `tests/test_loans.py` / `tests/test_accounts.py`)

**Interfaces:**
- Produces in `loans.py`:
  - `class ScheduleRow(NamedTuple): month: dt.date; due: dt.date | None; amount: Decimal; interest: Decimal; principal: Decimal; left: Decimal` (`month` is the 1st of the month).
  - `def schedule_rows(owed: Decimal, rate: Decimal, emi: Decimal, start: dt.date, due_day: int | None, cap: int = 600) -> tuple[list[ScheduleRow], str | None]` — `start` is the 1st of the first month; returns `([], message)` when it never pays off or passes the cap.
  - `class ScheduleRowOut(BaseModel): month: str  # "YYYY-MM"; due: str | None; amount: str; interest: str; principal: str; left: str`
  - `class Schedule(BaseModel): account_id: int; owed: str; rate: str | None; emi: str | None; paid_off: bool; problem: str | None; emis_left: int; ends: str | None  # "YYYY-MM" of the last row; interest_left: str; total_left: str; rows: list[ScheduleRowOut]`
- Produces route: `GET /api/accounts/{id}/schedule -> Schedule`.

Rules: `owed = balance_of(loan, load_book(...).flows)`; `owed <= 0` → `paid_off=True`, no rows, no problem. Missing rate → rate problem; missing EMI → EMI problem (rate checked first). First month = this month (`today_india()`), moved to next month when `emis_paid(db, user.id, loan.id, <this month's due date, or today if no due day>)` is non-empty. Each row: interest = `_round(balance × rate / 1200)`; if `emi <= interest` on any row with balance left → never-pays-off message; amount = `min(emi, balance + interest)`; principal = amount − interest; due = `clamped_date(y, m, due_day)` or None.

- [ ] **Step 1: Write the failing tests** in `tests/test_loan_schedule.py`:
  - `test_small_loan_rows`: `schedule_rows(Decimal("1000"), Decimal("12"), Decimal("600"), date(2026,12,1), 5)` → 2 rows; row 1 `(date(2026,12,1), date(2026,12,5), 600.00, 10.00, 590.00, 410.00)`; row 2 `(date(2027,1,1), date(2027,1,5), 414.10, 4.10, 410.00, 0.00)`; problem None.
  - `test_home_loan_first_rows`: owed 1000000, rate 8.5, EMI 25000 → row 1 interest 7083.33, principal 17916.67, left 982083.33; row 2 interest 6956.42.
  - `test_never_pays_off`: owed 1000000, rate 12, EMI 9000 → `([], "This EMI doesn't cover the monthly interest, so the loan never gets paid off.")`; EMI exactly 10000 → same.
  - `test_interest_free`: owed 1000, rate 0, EMI 300 → 4 rows, all interest 0.00, last amount 100.00.
  - `test_runs_past_cap`: owed 1000000, rate 0, EMI 100 → `([], "This schedule runs past 50 years. Check the EMI and the rate.")`.
  - `test_due_day_clamps`: start `date(2027,2,1)`, due_day 31 → row 1 due `date(2027,2,28)`; due_day None → due None.
  - `test_schedule_route`: a loan (balance `"1000.00"`, interest_rate `"12"`, emi_amount `"600.00"`, due_day 5) → 200; `emis_left == 2`, `interest_left == "14.10"`, `total_left == "1014.10"`, `ends` is the second row's month, `rows[0]["month"]` is this month (`today_india()`), `paid_off is False`, `problem is None`.
  - `test_route_starts_next_month_after_this_months_emi`: record an EMI to the loan dated today (`emi()` helper style, `date=today_india()`), then `rows[0]["month"]` is next month.
  - `test_route_problems`: no rate → problem "Add the interest rate to see the schedule.", rows `[]`; rate but no EMI → "Add the EMI to see the schedule."; balance `"0.00"` → `paid_off is True`, problem None; a bank account → 422 "Only a loan has a repayment schedule."; another user's loan → 404.
- [ ] **Step 2: Run** `ENVIRONMENT=test .venv/Scripts/python -m pytest tests/test_loan_schedule.py -q` → FAIL (ImportError / 404).
- [ ] **Step 3: Implement** the models, `schedule_rows`, and the route per the rules.
- [ ] **Step 4: Run** `pytest tests/test_loan_schedule.py tests/test_loans.py -q` → PASS; ruff clean.
- [ ] **Step 5: Commit** `feat(loans): repayment schedule`.

### Task 2: Web schedule dialog

**Files:**
- Modify: `frontend/src/lib/accounts.ts`, `frontend/src/lib/accounts.test.mjs`
- Create: `frontend/src/components/accounts/schedule-dialog.tsx`
- Modify: `frontend/src/components/accounts/accounts-view.tsx` (a "Schedule" `ROW_ACTION` button on loan rows next to "Record EMI", opening the dialog via a new `{ kind: "schedule"; account }` dialog state)

**Interfaces:**
- Consumes: `Schedule` JSON from Task 1.
- Produces in `lib/accounts.ts`: `type LoanSchedule` (mirrors `Schedule`, rows typed `{ month; due; amount; interest; principal; left }`) and `scheduleSummary(s: LoanSchedule): string | null` → `"Ends Jan 2027 · 2 EMIs left · ₹14.10 interest still to pay"` (null when `paid_off` or `problem`; "1 EMI left" singular; amounts via `formatRupees` with a trailing ".00" dropped; month via the file's `MONTHS`).

- [ ] **Step 1: Write the failing tests** for `scheduleSummary`: the 2-row example above; a 1-row schedule says "1 EMI left"; `paid_off` → null; a `problem` → null.
- [ ] **Step 2: Run** `cd frontend && npm test` → FAIL.
- [ ] **Step 3: Implement** the helper, then `ScheduleDialog({ loan, onClose })`: loads `/accounts/{id}/schedule`; shows "Paid off" when `paid_off`, the `problem` text when set, else the summary and a table (Due — the `due` date via `formatDueDate` plus year, or the month — EMI, Interest, Principal, Left after), using the same `<dialog>` shell and classes as `split-dialog.tsx`. Wire the button.
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit`, `npx eslint` on touched files, `npx next build` → pass.
- [ ] **Step 5: Commit** `feat(web): loan repayment schedule`.

### Task 3: Phone schedule screen

**Files:**
- Modify: `mobile/src/lib/accounts.ts`, `mobile/src/lib/accounts.test.mjs` (same type, helper and tests as Task 2)
- Create: `mobile/src/app/loan-schedule.tsx` (param `id`)
- Modify: `mobile/src/app/_layout.tsx` (`<Stack.Screen name="loan-schedule" />`), `mobile/src/app/(tabs)/accounts.tsx` (a compact "Schedule" `ChunkyButton`, icon `calendar-clock`, beside "Record EMI" for loans with a balance)

**Interfaces:**
- Consumes: Task 1 endpoint; `LoanSchedule`, `scheduleSummary` (this task's phone copies).

- [ ] **Step 1: Write the failing tests** (Task 2's helper tests, in the phone file).
- [ ] **Step 2: Run** `cd mobile && npm test` → FAIL.
- [ ] **Step 3: Implement** the helper and the screen: `ScreenHeader` with the loan's name, the summary (or "Paid off" / the problem), then one row per EMI (date, EMI, then "interest ₹x · principal ₹y · left ₹z").
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit`, `npx expo lint` → pass; `npx expo-updates runtimeversion:resolve --platform android` unchanged (`cd7279c…`).
- [ ] **Step 5: Commit** `feat(mobile): loan repayment schedule`.

### Task 4: Rules doc and final check

**Files:** Modify `docs/architecture/financial-calculations.md` (a "Repayment schedule" paragraph after the loans rules; find them by searching "EMI").

- [ ] **Step 1:** Write the paragraph: the interest rule, first month, last EMI, never-pays-off and 50-year cap, and that it's computed from today's balance (prepayments and corrections show at once).
- [ ] **Step 2: Run** full backend suite, web `npm test` + `tsc`, phone `npm test` + `tsc` → pass.
- [ ] **Step 3: Commit** `docs: loan repayment schedule rules`.
