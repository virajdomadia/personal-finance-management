# Spend Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A month calendar (web + phone) showing what was spent each day against a fixed daily amount = (monthly income reminders − other monthly fixed items) ÷ days in the month, plus a "free to spend" summary on the Recurring screen.

**Architecture:** Pure arithmetic in a new `app/api/spend_calendar.py` (tested without a DB), one read-only endpoint `GET /api/calendar?month=YYYY-MM`, and display helpers added to the existing `cash-flow.ts` lib on each client. No migration, no new dependency, no native module.

**Tech Stack:** FastAPI + SQLAlchemy (backend, pytest), Next.js (frontend, node:test), Expo / React Native (mobile, node:test).

**Spec:** `docs/superpowers/specs/2026-11-24-spend-calendar-design.md`

## Global Constraints

- Branch: `feat/spend-calendar` off `main`.
- No database migration. No new npm or Python dependency. No native module.
- **Do not edit the `test` script in `mobile/package.json`.** It changes the EAS runtime fingerprint and installed APKs would stop getting updates. Mobile tests go into the existing `mobile/src/lib/cash-flow.test.mjs`. Do the same on web (`frontend/src/lib/cash-flow.test.mjs`) for symmetry.
- Daily amount = free ÷ days in that calendar month, rounded half up to 2 dp. It depends only on reminders and SIP plans, never on recorded transactions.
- "Spent on a day" = `cash_flow.spent` (expense, EMI interest, minus refunds) over `cash_flow.COUNTED_TYPES`, **minus** transactions that pay a fixed monthly reminder.
- Day colour: `spent <= per_day` → under (green), `spent > per_day` → over (red); future days are blank. Days with 0 spent are under.
- Yearly reminders are never counted. Inactive reminders and SIPs are not counted.
- Run backend tests with `ENVIRONMENT=test` (backend/.env sets development and breaks auth tests): `cd backend && ENVIRONMENT=test uv run pytest`.
- Money in API responses is a string formatted with `app.api.routes.accounts.fmt`.

**Plan-time calls (not in the spec, flagged for the owner):**
- Active **SIP plans** (`sips` table, monthly by nature) count as fixed outgoings automatically, so a SIP set up under Investments needn't be entered again as a reminder. (If the owner also makes a reminder for the same SIP it would be subtracted twice; the Recurring summary lists every fixed line so that's visible.)
- A reminder or SIP counts for a month when it's active and its `start_date` ≤ the month's last day and (`end_date` is null or ≥ the month's 1st).

## Review Focus

1. **Rent paid by bank SMS, not through the reminder** (unlinked, same account + amount) must not count as that day's spending. Test in Task 2.
2. **No monthly income reminder** → `per_day` null, days have `over: null`, clients show a prompt to add the salary in Recurring. Tests in Tasks 1 and 3; UI copy in Tasks 4–5.
3. **February and 30-day months** divide by 28/29/30, not 31. Test in Task 1.
4. **Fixed outgoings bigger than income** → negative free and per_day, every day with spending > 0 is over, and a day with 0 spent is under. Test in Task 1.
5. **A reminder starting mid-month or ended last month** → included for the whole month it overlaps, excluded from months it doesn't. Test in Task 1.

---

### Task 1: Pure calendar arithmetic

**Files:**
- Create: `backend/app/api/spend_calendar.py`
- Test: `backend/tests/test_spend_calendar_math.py`

**Interfaces:**
- Consumes: `app.api.cash_flow.Row`, `spent`, `last_day`, `ZERO`.
- Produces:
  - `class Fixed(NamedTuple): name: str; kind: str  # "income" | "out"; amount: Decimal; day: int; start_date: date; end_date: date | None; active: bool`
  - `def counts_in(item: Fixed, first: date) -> bool`
  - `class Allowance(NamedTuple): income: Decimal; fixed_out: Decimal; free: Decimal; per_day: Decimal | None` (`per_day` None when no income item counts)
  - `def allowance(items: Iterable[Fixed], first: date) -> Allowance`
  - `class CalendarDay(NamedTuple): date: date; spent: Decimal | None; over: bool | None`
  - `def calendar_days(rows: Iterable[Row], first: date, through: date, per_day: Decimal | None) -> list[CalendarDay]`
  - `def pace(per_day: Decimal | None, through: date, first: date, spent: Decimal) -> Decimal | None`: `per_day × (through.day − first.day + 1) − spent`, positive = under pace, None when per_day is None.

- [ ] **Step 1: Write the failing tests** in `test_spend_calendar_math.py`:
  - `test_the_owners_month`: salary 54800 income; rent 16000, SIP 5000, PPF 3000 out; `first=date(2026,12,1)` → `Allowance(Decimal("54800"), Decimal("24000"), Decimal("30800"), Decimal("993.55"))`.
  - `test_thirty_day_and_february`: same items, Nov 2026 → per_day `1026.67`; Feb 2026 → `1100.00`; Feb 2028 → `1062.07`.
  - `test_no_income_means_no_per_day`: only out items → `per_day is None`, `free == -24000`.
  - `test_fixed_more_than_income`: income 10000, out 16000, Nov → `free == Decimal("-6000")`, `per_day == Decimal("-200.00")`.
  - `test_counts_in_by_dates`: start 2026-11-20 counts in Nov 2026, not Oct; end_date 2026-10-31 counts in Oct, not Nov; `active=False` never counts.
  - `test_days_colour_and_future`: rows: expense 500 on Nov 3, expense 1500 on Nov 5, refund 200 on Nov 5, income 54800 on Nov 1; per_day 1000; through Nov 12 → 30 days; Nov 3 `(500, over=False)`, Nov 5 `(1300, True)`, Nov 1 `(0, False)`, Nov 13 `(None, None)`.
  - `test_days_without_per_day`: same rows, per_day None → every past day `over is None`, spent still filled.
  - `test_negative_per_day_any_spend_is_over`: per_day `-200`, a 0 day is `over=False`, a 50 day is `over=True`.
  - `test_pace`: per_day 1000, first Nov 1, through Nov 12, spent 10000 → `Decimal("2000.00")`; per_day None → None.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && ENVIRONMENT=test uv run pytest tests/test_spend_calendar_math.py -q`
Expected: FAIL, `ModuleNotFoundError: app.api.spend_calendar`

- [ ] **Step 3: Implement `app/api/spend_calendar.py`** with the signatures above. per_day uses `quantize(Decimal("0.01"), ROUND_HALF_UP)`. The 0-spent rule for a negative per_day: `over = spent > 0 if per_day < 0 else spent > per_day`.

- [ ] **Step 4: Run to verify they pass** (same command, expect all PASS), then `uv run ruff check app tests && uv run ruff format --check app tests`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/spend_calendar.py backend/tests/test_spend_calendar_math.py
git commit -m "feat(calendar): daily amount and per-day spend arithmetic"
```

### Task 2: Which transactions pay a fixed reminder

**Files:**
- Modify: `backend/app/api/reminder_payments.py` (extract the unlinked-candidates query out of `load_reminder_payments` into `_unlinked(db, user_id, templates) -> list[Transaction]`, reused by both)
- Test: `backend/tests/test_spend_calendar.py` (new; this task adds the first tests, Task 3 adds more)

**Interfaces:**
- Consumes: `settle_unlinked`, `pays_for`, `Money` from `app.api.recurring`.
- Produces: `def fixed_payment_ids(db: Session, user_id: int, template_ids: set[int]) -> set[int]`: ids of transactions that pay one of those reminders, both linked (`recurring_template_id` in the set) and matched unlinked ones. Map each matched (reminder, date) from `settle_unlinked` back to one unlinked transaction on that date for which `pays_for(reminder_money, tx_money)` holds, taking each transaction at most once (oldest id first).

- [ ] **Step 1: Write failing tests** (DB tests; reuse helpers `auth`, `make` from `tests.test_accounts` and `post` from `tests.test_transactions` like `tests/test_cash_flow.py`; create reminders with `POST /api/recurring`):
  - `test_linked_payment_is_fixed`: rent reminder (expense 16000, monthly, day 5); record it through the reminder (`recurring_template_id` set) → its id is returned.
  - `test_matched_unlinked_payment_is_fixed`: rent reminder; a plain expense 16000 from the same bank on Nov 5 → its id returned; a second, unrelated expense 16000 from another account → not returned.
  - `test_two_same_day_payments_one_reminder`: two identical unlinked 16000 expenses on Nov 5 → exactly one id returned.
  - `test_existing_reminder_payments_unchanged`: run the existing `tests/test_recurring.py` and `tests/test_sms_expected.py` (the refactor must not change matching).

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && ENVIRONMENT=test uv run pytest tests/test_spend_calendar.py -q`
Expected: FAIL, `ImportError: cannot import name 'fixed_payment_ids'`

- [ ] **Step 3: Implement** `_unlinked` (pure extraction, same query) and `fixed_payment_ids`.

- [ ] **Step 4: Run** `ENVIRONMENT=test uv run pytest tests/test_spend_calendar.py tests/test_recurring.py tests/test_sms_expected.py tests/test_upcoming.py -q`. Expected: all PASS.

- [ ] **Step 5: Commit** `feat(calendar): find transactions that pay fixed reminders`

### Task 3: `GET /api/calendar`

**Files:**
- Create: `backend/app/api/routes/calendar.py`
- Modify: `backend/app/api/router.py` (import and `include_router(calendar.router)`)
- Modify: `docs/architecture/financial-calculations.md` (add a "Spend calendar" section stating the rules in Global Constraints)
- Test: `backend/tests/test_spend_calendar.py`

**Interfaces:**
- Consumes: Task 1 functions; `fixed_payment_ids` (Task 2); `today_india`; `cf.COUNTED_TYPES`, `cf.Row`, `cf.previous_month`, `cf.next_month`; `fmt`.
- Produces (response JSON, used by Tasks 4–5):

```python
class FixedLine(BaseModel):
    name: str
    kind: str  # "income" | "out"
    source: str  # "reminder" | "sip"
    amount: str
    day: int

class CalendarDayOut(BaseModel):
    date: str
    spent: str | None  # None after today
    over: bool | None  # None after today, or when there's no daily amount

class SpendCalendar(BaseModel):
    month: str  # "YYYY-MM"
    is_current: bool
    through: str
    income: str
    fixed_out: str
    free: str
    per_day: str | None
    spent: str  # month to date, fixed payments excluded
    left: str  # free − spent
    pace: str | None  # see spend_calendar.pace
    fixed: list[FixedLine]  # income first, then out, each by day
    days: list[CalendarDayOut]
    previous_month: str | None  # same rule as /cash-flow
    next_month: str | None
```

Router: `APIRouter(prefix="/calendar", tags=["calendar"], dependencies=[Depends(get_current_user)])`, `GET ""` with `month` query using the same pattern and the same "That month hasn't started yet." 422 as `routes/cash_flow.py` (import `_future`/`_month` from there rather than copying). Fixed items: the user's `RecurringTemplate` rows with `frequency == "monthly"` (`type == "income"` → kind income, others → out), plus `Sip` rows (name = the fund instrument's name, kind out). SIP purchases are investment trades, not transactions, so they need no exclusion. Exclude `fixed_payment_ids(...)` for the monthly non-income template ids that count in the month.

- [ ] **Step 1: Write failing tests** in `tests/test_spend_calendar.py` (monkeypatch `calendar.today_india` to `date(2026, 11, 12)`):
  - `test_owners_month`: reminders salary 54800 (income, day 1), rent 16000 (expense, day 5), PPF 3000 (transfer to a PPF account, day 10), and an active SIP 5000 → `free == "30800.00"`, `per_day == "1026.67"`, `len(fixed) == 4`, `[f["source"] for f in fixed]` contains `"sip"`.
  - `test_rent_day_not_red`: also record rent as a plain expense 16000 on Nov 5 and groceries 600 on Nov 5 → Nov 5 `spent == "600.00"`, `over is False`; month `spent == "600.00"`.
  - `test_no_income_reminder`: only rent → `per_day is None`, every past day `over is None`.
  - `test_yearly_reminder_ignored`: a yearly 12000 insurance reminder doesn't change `fixed_out`.
  - `test_future_month_refused`: `?month=2026-12` → 422 with "That month hasn't started yet."
  - `test_past_month_full`: `?month=2026-10` → 31 days, none with `spent is None`, `is_current is False`.
  - `test_other_users_data_hidden`: a second user's reminders and spending don't appear.

- [ ] **Step 2: Run** `ENVIRONMENT=test uv run pytest tests/test_spend_calendar.py -q`. Expected: FAIL, 404 on `/api/calendar`.

- [ ] **Step 3: Implement** the route and register it; write the docs section.

- [ ] **Step 4: Run the full backend suite** `ENVIRONMENT=test uv run pytest -q` plus ruff check/format. Expected: all PASS.

- [ ] **Step 5: Commit** `feat(calendar): GET /api/calendar`

### Task 4: Web calendar page and Recurring summary

**Files:**
- Modify: `frontend/src/lib/cash-flow.ts`, `frontend/src/lib/cash-flow.test.mjs`
- Create: `frontend/src/app/(app)/calendar/page.tsx`, `frontend/src/components/cash-flow/spend-calendar-view.tsx`, `frontend/src/components/recurring/free-to-spend.tsx`
- Modify: `frontend/src/components/sidebar.tsx` (entry `{ href: "/calendar", emoji: "📅", label: "Calendar" }` after Cash flow), `frontend/src/app/(app)/recurring/page.tsx` or its view (render `FreeToSpend` at the top), `frontend/src/components/cash-flow/cash-flow-view.tsx` (link to the calendar for the same month)

**Interfaces:**
- Consumes: `SpendCalendar` JSON (Task 3).
- Produces, in `frontend/src/lib/cash-flow.ts`:
  - `type SpendCalendar`, `type CalendarDay` (mirroring Task 3)
  - `calendarPath(month: string | null): string` → `"/calendar"` or `"/calendar?month=YYYY-MM"`
  - `calendarWeeks(days: CalendarDay[]): (CalendarDay | null)[][]`: Monday-first rows of 7, padded with null
  - `shortRupees(amount: string): string` → `"0.00"`→`"₹0"`, `"420.00"`→`"₹420"`, `"1234.00"`→`"₹1.2k"`, `"125000.00"`→`"₹1.3L"`, negatives keep `−`
  - `dayTone(day: CalendarDay): "over" | "under" | "plain" | "future"`
  - `dayTransactionsHref(date: string): string` → `"/transactions?from=D&to=D"`
  - `paceText(pace: string | null): string | null` → `"₹2,000 under pace"` / `"₹500 over pace"` / null

- [ ] **Step 1: Failing tests** in `frontend/src/lib/cash-flow.test.mjs` for each helper above with the exact values listed; `calendarWeeks` on November 2026 (starts Sunday) → first row is six nulls then Nov 1; 6 rows in total.
- [ ] **Step 2: Run** `cd frontend && npm test`. Expected: FAIL on missing exports.
- [ ] **Step 3: Implement the helpers**, then the page and view using the existing chunky UI components the cash-flow view uses (`@/components/ui/chunky`): header with Free / Per day / Spent / Left / pace; month arrows from `previous_month`/`next_month`; 7-column grid, each cell a link to `dayTransactionsHref`; tone classes green/red; empty-income prompt with the copy "Add your salary as a monthly reminder in Recurring to see a daily amount." linking to `/recurring`. `FreeToSpend` fetches `/calendar` and shows `Income ₹54,800 − Fixed ₹24,000 = Free ₹30,800 · ₹994/day` from the response (current month), listing `fixed` lines.
- [ ] **Step 4: Verify** `npm test && npm run lint && npx tsc --noEmit` pass, then run the app (`run` skill) and check /calendar and /recurring in the browser at desktop and phone widths, in both themes.
- [ ] **Step 5: Commit** `feat(calendar): web calendar page and free-to-spend summary`

### Task 5: Phone calendar screen and Recurring summary

**Files:**
- Modify: `mobile/src/lib/cash-flow.ts`, `mobile/src/lib/cash-flow.test.mjs` (NOT `mobile/package.json`)
- Create: `mobile/src/app/calendar.tsx`
- Modify: `mobile/src/app/_layout.tsx` (`<Stack.Screen name="calendar" />`), `mobile/src/app/recurring.tsx` (summary at top), `mobile/src/app/cash-flow.tsx` (button to the calendar for the same month), `mobile/src/app/(tabs)/index.tsx` (a Calendar entry where Cash flow is reached from)

**Interfaces:**
- Consumes: `SpendCalendar` JSON (Task 3); `filterHandoff`, `blankFilters` from `mobile/src/lib/search.ts`.
- Produces in `mobile/src/lib/cash-flow.ts`: the same `SpendCalendar`, `CalendarDay`, `calendarPath` (returns the API path `"/calendar?month=…"`), `calendarWeeks`, `shortRupees`, `dayTone`, `paceText` as Task 4 (no `dayTransactionsHref`; a tap sets `filterHandoff.next = { ...blankFilters(month), dateFrom: date, dateTo: date }` and calls `router.navigate("/transactions")`, the same way `openSlice` does in `cash-flow.tsx`).

- [ ] **Step 1: Failing tests** in `mobile/src/lib/cash-flow.test.mjs`: the same cases as Task 4 Step 1.
- [ ] **Step 2: Run** `cd mobile && npm test`. Expected: FAIL on missing exports.
- [ ] **Step 3: Implement** the helpers, then the screen with plain `View`/`Text` and the chunky components (`ChunkyBox`, `ScreenHeader`) — no new package. Cells are pressable with `accessibilityLabel` like "5 November, spent ₹600, under the daily amount". Pull to refresh, as on the cash-flow screen. Same empty-income prompt copy as web.
- [ ] **Step 4: Verify** `npm test`, `npx tsc --noEmit` and `npm run lint` pass; `git diff main -- mobile/package.json` is empty; `npx expo-updates runtimeversion:resolve --platform android` prints the same runtime as on `main`.
- [ ] **Step 5: Commit** `feat(calendar): phone calendar screen and free-to-spend summary`

### Task 6: Ship

- [ ] Whole-branch review, then push `feat/spend-calendar` and open a PR (ask the owner first).
- [ ] After merge: API + web deploy via the GitHub Actions `vercel.yml` (no Vercel build minutes), then `eas update --branch production --environment production` after confirming the runtime is unchanged.

---

## Part 2: calendar replaces Recurring (spec "Part 2")

### Task 7: Reminder occurrences in `GET /api/calendar`

**Files:** Modify `backend/app/api/spend_calendar.py`, `backend/app/api/routes/calendar.py`. Test `backend/tests/test_spend_calendar_math.py`, `backend/tests/test_spend_calendar.py`.

**Interfaces:** Produces `def month_marks(row: TemplateRow, paid: list[date], skips: set[date], first: date, today: date) -> list[tuple[date, str]]` (state ∈ "paid" | "due" | "coming" | "skipped") in `spend_calendar.py`, built on `recurring.occurrences` and `recurring.open_occurrences`. Response gains `marks: list[Mark]` with `Mark = {date, template_id, name, amount, kind: "income"|"out", state}` for every **active** reminder (monthly and yearly) with an occurrence in the month, sorted by date then name, using `load_reminder_payments`.

- [ ] Failing tests: math: an occurrence settled by a payment is "paid", an open one on or before today is "due", after today is "coming", a skipped one is "skipped", and a yearly reminder outside its month gives no mark. API: rent paid on the 5th shows `{"date": "2026-11-05", "state": "paid"}`; salary not recorded shows "due"; a yearly premium due in March is absent from November.
- [ ] Implement, run `ENVIRONMENT=test uv run pytest tests/test_spend_calendar.py tests/test_spend_calendar_math.py -q`, and run the full suite. Commit.

### Task 8: Web: the calendar takes over Recurring

**Files:** Create `frontend/src/components/recurring/reminder-list.tsx` (the table, row and actions moved out of `recurring-view.tsx`: edit, stop/restart, delete with ConfirmDelete, undo skip). Modify `spend-calendar-view.tsx` (due section via `DueSection` for the current month; "Your fixed money" = active monthly templates in a `ReminderList` plus SIP rows; "Other reminders" = the rest in a `ReminderList`; day markers; `?add=1` opens Add fixed expense). Replace `frontend/src/app/(app)/recurring/page.tsx` with a redirect to `/calendar` (keeping `?add=1`). Delete `recurring-view.tsx` and `free-to-spend.tsx`. Remove the sidebar entry; `setup.ts` href → `/calendar?add=1`. Lib helpers in `cash-flow.ts` with tests in `cash-flow.test.mjs`: `type Mark`, `marksByDate(marks) -> Map<string, Mark[]>`, `markText(mark) -> "Rent ₹16,000 paid"`, `splitTemplates(templates) -> { fixed, other }` (fixed = active && monthly).

- [ ] Failing lib tests, then implement, `npm test && npm run lint && npx tsc --noEmit`, and check it in the browser (add, edit, stop, delete, record a due one, undo a skip, markers). Commit.

### Task 9: Phone: the calendar takes over Recurring, and notifications open it

**Files:** Create `mobile/src/components/reminder-list.tsx` (rows and actions moved out of `recurring.tsx`, delete dialog included). Modify `mobile/src/app/calendar.tsx` (DueList for the current month, the two lists, markers), `mobile/src/lib/cash-flow.ts` and its tests (same helpers as web), `mobile/src/lib/reminders.ts` (due notifications use `CALENDAR_URL = "/calendar"`; `reminderTarget` accepts `/calendar`, `/upcoming` and `/budgets`) and `reminders.test.mjs`, `mobile/src/app/(tabs)/profile.tsx` (entry opens the calendar). Delete `mobile/src/app/recurring.tsx` and its `Stack.Screen`. **Do not touch `mobile/package.json`.**

- [ ] Failing tests (helpers; `reminderTarget("/calendar")` → "/calendar", `"/upcoming"` still accepted; due reminders built with url "/calendar"), implement, `npm test`, `npx tsc --noEmit`, `npm run lint`, and `git diff main -- mobile/package.json` empty. Commit.
