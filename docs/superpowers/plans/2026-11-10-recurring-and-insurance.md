# Recurring Reminders and Health Insurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recurring templates (monthly and yearly expense, income or transfer) that remind and pre-fill, never post. Health insurance policies sit on top of them: a yearly premium template, atomic renewal, period history, a funding line from an RD, a card-bill warning and a per-FY premium figure. All of it on the backend, website and Android app.

**Architecture:** Four new tables, `recurring_templates`, `recurring_skips`, `insurance_policies` and `policy_periods`, plus a nullable `transactions.recurring_template_id`. Occurrence maths is pure functions in `backend/app/api/recurring.py`. Routes go in `routes/recurring.py` and `routes/policies.py`. Template validation reuses the transaction validator `_validate` in `routes/transactions.py`. The dashboard gains a `recurring` key.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, pytest (SQLite by default, PostgreSQL with `TEST_DATABASE_URL`). Next.js 16 (read `frontend/node_modules/next/dist/docs/` before writing pages). Expo SDK 58, Expo Router and react-native-paper (read `mobile/AGENTS.md` first). Client helpers are tested with `node --test` `.mjs` files.

**Spec:** [docs/superpowers/specs/2026-11-10-recurring-and-insurance-design.md](../specs/2026-11-10-recurring-and-insurance-design.md). Its "Design calls made by Claude" list is accepted and binding.

## Global Constraints

- Money crosses the API as 2-decimal strings, and dates as ISO `YYYY-MM-DD`. Use `Decimal` only, `ROUND_HALF_UP`, and no floats.
- "Today" is `today_india()`. Day clamping uses `clamped_date` from `app/api/dates.py`.
- Validation errors are `RequestValidationError([field_error(field, message)])` → 422. Conflicts are 409. Missing, other-user or wrong-kind ids are 404. Every query is scoped to `user.id`.
- **Nothing ever posts on its own.** Every transaction is created by an explicit owner request.
- No existing response shape may change except by adding keys. `TransactionResponse` gains `recurring_template_id`. The installed Android app must keep working.
- The golden tests `tests/test_pg_stock_figures.py` and `tests/test_pg_fund_figures.py` must keep passing, and their fixtures are never edited.
- Web and Android each get their own UI. Clients only display server figures.
- Subagents never start servers, emulators or browsers. **Never run `npm run build` in `frontend/`.** Verify with `npx tsc --noEmit`, `npm run lint` and `npm test`. The controller does the website browser walk.
- A full PG run takes over an hour. Per task, run on PG only the changed test files plus the two goldens: `TEST_DATABASE_URL=postgresql+psycopg://pfm:pfm@localhost:5434/pfm_test` (start the cluster with `npm run db:start` from the root if it's down).
- Run `ruff format` only on files you touch.
- Commit after each task, ending messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A monthly template on day 31 and a yearly one on 29 Feb.** Occurrences clamp (28/29 Feb, 30 Apr), and a yearly 29 Feb is 28 Feb in non-leap years (Task 2 tests).
2. **A yearly premium paid 10 days early or 20 days late.** It still settles that year's occurrence (within 45 days), and it doesn't settle the next year's (Task 2 tests).
3. **Recording the premium through the plain transaction form.** A policy's template is refused with "Renew the policy instead.", so a period can't silently stay stale (Task 3 test).
4. **Renew failing halfway.** Whether the cause is an archived card, a balance rule or a bad period, neither the transaction nor the period row is written (Task 4 test).
5. **A card whose bill for an April charge is due before the RD matures, and one where it's due after.** The warning shows only in the first case (Task 2 and Task 4 tests).

---

### Task 1: Tables and migration

**Files:**
- Create: `backend/app/models/recurring.py` (`RecurringTemplate`, `RecurringSkip`), `backend/app/models/insurance.py` (`InsurancePolicy`, `PolicyPeriod`)
- Modify: `backend/app/models/__init__.py`, `backend/app/models/transaction.py` (`recurring_template_id: int | None`, FK `recurring_templates.id`, indexed)
- Create: `backend/migrations/versions/2026_11_10_1200-<rev>_add_recurring_and_insurance.py` (down_revision `5d7e3a90c1f2`)
- Test: `backend/tests/test_pg_migrations.py` (add the new tables to `ALL_TABLES`, plus an upgrade/downgrade round trip)

**Interfaces (produces):**
- `RecurringTemplate` (`recurring_templates`): `id`, `user_id` (idx), `name String(60)`, `type String(20)`, `amount Numeric(14,2)`, `account_id` (FK accounts, idx), `to_account_id` (nullable FK), `category String(40) | None`, `note String(200) | None`, `frequency String(10)` ("monthly" | "yearly"), `day Integer`, `month Integer | None`, `start_date Date`, `end_date Date | None`, `remind_days Integer`, `active Boolean` (server default true), `created_at`, `updated_at`.
- `RecurringSkip` (`recurring_skips`): `id`, `user_id`, `template_id` (FK, idx), `occurrence Date`, `created_at`. `UniqueConstraint(template_id, occurrence)`.
- `InsurancePolicy` (`insurance_policies`): `id`, `user_id` (idx), `kind String(20)`, `insurer String(60)`, `plan String(100)`, `policy_number String(40)`, `insured String(100)`, `sum_insured Numeric(14,2)`, `period_start Date`, `period_end Date`, `premium Numeric(14,2)`, `template_id` (FK recurring_templates, unique), `funded_by_id` (nullable FK accounts), `details String(2000) | None`, `active Boolean`, `created_at`, `updated_at`.
- `PolicyPeriod` (`policy_periods`): `id`, `user_id`, `policy_id` (FK, idx), `period_start`, `period_end`, `premium Numeric(14,2)`, `sum_insured Numeric(14,2)`, `paid_on Date`, `transaction_id` (nullable FK transactions, unique), `created_at`.

- [ ] **Step 1:** Write the failing tests:
  - `ALL_TABLES` lists the four new tables.
  - `test_recurring_migration_round_trip` (PG): upgrade to head; existing transactions get `recurring_template_id` NULL; downgrade to `5d7e3a90c1f2` drops everything cleanly when the new tables are empty.
  - `test_downgrade_refuses_recurring_data`: with a template present, downgrade raises `RuntimeError("Recurring or insurance data exists; remove it before downgrading.")` and changes nothing.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Write the models and the migration by hand, with names following `NAMING_CONVENTION`.
- [ ] **Step 4:** Run `uv run pytest` and ruff, then on PG run `test_pg_migrations.py` (including `alembic check`) and the two goldens. Expected: PASS.
- [ ] **Step 5:** Commit: `Add recurring templates and insurance policy tables`.

### Task 2: Occurrence and funding maths (pure)

**Files:**
- Create: `backend/app/api/recurring.py`
- Test: `backend/tests/test_recurring_math.py`

**Interfaces (produces):**
```python
class TemplateRow(NamedTuple): id: int; frequency: str; day: int; month: int | None
    start_date: date; end_date: date | None; remind_days: int; active: bool
def occurrences(t: TemplateRow, upto: date) -> list[date]      # every occurrence from start_date to min(upto, end_date)
def is_recorded(t: TemplateRow, occurrence: date, paid: Iterable[date]) -> bool
    # monthly: a linked transaction in the same calendar month; yearly: within 45 days either side
def status(t: TemplateRow, paid: list[date], skips: set[date], today: date) -> Status
class Status(NamedTuple): due: list[date]; coming_up: date | None   # due oldest first
def card_bill_due(charge: date, statement_day: int, due_day: int) -> date
    # first statement date (statement_day, clamped) on or after `charge`, then the first due_day date strictly after it
def financial_year(day: date) -> int   # reuse app.api.deposits.financial_year
```
- An occurrence counts as due when it's dated on or before today and is neither recorded nor skipped. `coming_up` is the first unrecorded, unskipped occurrence in (today, today + remind_days]. A stopped template has `Status([], None)`.
- One payment settles at most one occurrence: match each paid date to the nearest unsettled occurrence, oldest first.

- [ ] **Step 1:** Write the failing tests:
  - A monthly template on day 31 from 2027-01-31: its occurrences are 31 Jan, 28 Feb, 31 Mar, 30 Apr (Review Focus 1).
  - A yearly template on 29 Feb from 2028-02-29: the next occurrence is 2029-02-28.
  - Yearly 6 Apr from 2027-04-06 with `remind_days` 30:
    - today 2027-03-06: nothing showing;
    - today 2027-03-07: `coming_up` is 2027-04-06;
    - today 2027-04-07 with no payment: due is `[2027-04-06]`;
    - a payment on 2027-03-27 settles it, and so does one on 2027-04-26 (Review Focus 2);
    - a payment on 2027-06-01 doesn't settle it, so it's still due;
    - 2028's occurrence is not settled by the 2027 payment.
  - Monthly rent on day 1 from 2027-01-01, today 2027-03-10, paid in January only: due is `[2027-02-01, 2027-03-01]`. After skipping 2027-02-01, due is `[2027-03-01]`.
  - `end_date` stops occurrences; a stopped template is never due.
  - `card_bill_due(date(2027,4,6), 15, 5) == date(2027,5,5)`; `card_bill_due(date(2027,4,6), 1, 25) == date(2027,5,25)`; `card_bill_due(date(2027,4,15), 15, 5) == date(2027,5,5)` (a charge on the statement day goes on that statement).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite and ruff. Expected: PASS.
- [ ] **Step 5:** Commit: `Work out recurring occurrences and card bill dates`.

### Task 3: Templates API and transaction linking

**Files:**
- Create: `backend/app/api/routes/recurring.py` (prefix `/recurring`)
- Modify: `backend/app/api/routes/transactions.py` (accept `recurring_template_id` on create and edit, and return it), `backend/app/api/router.py`
- Test: `backend/tests/test_recurring.py`

**Interfaces (produces):**
- `TemplateResponse` = `{id, name, type, amount, account_id, account_name, to_account_id, to_account_name, category, note, frequency, day, month, start_date, end_date, remind_days, active, policy_id: int|null, due: [dates], coming_up: date|null, recorded: int}`.
- `GET /recurring` → `{"templates": [...]}`, sorted by name. `POST /recurring` → 201. `PATCH /recurring/{id}`. `DELETE /recurring/{id}` → 409 "This reminder has recorded transactions. Stop it instead." when it's linked.
- `POST /recurring/{id}/skip` `{"occurrence"}`: the date must be a real occurrence that is due or coming up, otherwise 422 on `occurrence` "That isn't a due date for this reminder." `DELETE /recurring/{id}/skip/{date}` undoes a skip.
- `GET /recurring/due` → `{"items": [{template, occurrence, state: "due"|"coming_up"}]}`, due first (oldest first), then coming up (soonest first). Task 5 uses `due_items(db, user_id, today)`.
- Template validation: build the same `values` dict a transaction would have (`type`, `amount`, `account_id`, `to_account_id`, `category`, `interest: None`, `date: start_date`) and call `transactions._validate(values, accounts)`. Rename it to `validate_transaction_values` and export it. `emi` isn't a template type: "Choose expense, income or transfer." Further rules:
  - `frequency`: "Choose monthly or yearly."
  - `day` 1–31: "Choose a day from 1 to 31."
  - `month`, yearly only: "Choose a month."
  - `remind_days` 0–60, defaulting to 3 for monthly and 30 for yearly.
  - `end_date` ≥ `start_date`.
  - `name`: 1–60 characters.
- Linking a transaction: `recurring_template_id` must be the owner's template, with the same `type`, else 422 on `recurring_template_id` "Choose a reminder of this type.". A policy's template gives 422 "Renew the policy instead." (Review Focus 3). `null` unlinks.

- [ ] **Step 1:** Write the failing tests (monkeypatch `today_india`):
  - Create a monthly rent template with expense from a bank, then `due`. Recording a transaction with the template id settles it, and `recorded` goes up.
  - A template that could never be recorded is refused with the transaction validator's messages, for example an expense from an RD.
  - Skip and un-skip. Skipping a date that isn't an occurrence → 422.
  - Delete rules. A stopped template disappears from `/recurring/due`.
  - Per-user 404s.
  - Transaction linking rules, including a type mismatch, another user's template, and (once Task 4 exists) a policy's template. Leave that last case to Task 4's tests.
  - `GET /transactions` rows now include `recurring_template_id`, and nothing else changes.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite and ruff, then PG on the changed files plus the goldens. Expected: PASS.
- [ ] **Step 5:** Commit: `Add recurring reminders that remind and pre-fill`.

### Task 4: Insurance policies API

**Files:**
- Create: `backend/app/api/routes/policies.py` (prefix `/insurance`)
- Modify: `backend/app/api/router.py`, `backend/app/api/routes/transactions.py` (the policy-template refusal)
- Test: `backend/tests/test_policies.py`

**Interfaces (produces):**
- `PolicyResponse` = `{id, kind, insurer, plan, policy_number, insured, sum_insured, period_start, period_end, premium, details, active, template: TemplateResponse, paying_account_id, paying_account_name, funded_by: {account_id, name, maturity_date, maturity_estimate, covers: bool, shortfall: str|null}|null, card_bill: {due: date, before_funding: bool}|null, periods: [{period_start, period_end, premium, sum_insured, paid_on, transaction_id|null}], premium_by_fy: [{fy: "2026-27", amount}], days_to_renewal: int}`.
- `GET /insurance` → `{"policies": [...]}` (active first, then by renewal date).
- `POST /insurance`: `{kind:"health", insurer, plan, policy_number, insured, sum_insured, period_start, period_end, premium, account_id, funded_by_id?, details?, paid_on, transaction_id?}`. It creates, in one transaction:
  - the policy;
  - its yearly expense template: name "{insurer} premium", category "Insurance", day and month of `period_end`, `start_date = period_end`, `remind_days` 30;
  - the first period row, from `paid_on` with `transaction_id` if given, else none.
  Validation: `period_end` > `period_start` and ≤ `period_start` + 1 year; amounts > 0; `funded_by_id`, if given, is the owner's account.
- `PATCH /insurance/{id}`: changing `premium`, `account_id` or the period updates the template (amount, account, day and month).
- `POST /insurance/{id}/renew` `{date, amount, account_id, period_start, period_end, sum_insured}`: one DB transaction. It runs the transaction save checks (`validate_transaction_values` + balance), creates the expense linked to the template, adds the period row, and moves the policy to the new period, with premium = amount. Any failure writes nothing (Review Focus 4). `period_start` must be after the current `period_end`: "The new period must start after the current one ends."
- `POST /insurance/{id}/lapse` sets `active` false and stops the template. `DELETE /insurance/{id}` → 409 "This policy has recorded premiums. Lapse it instead." if any period has a transaction; otherwise it deletes the periods, the policy and its template.
- Funding: if `funded_by` is an active `rd`, use `rd_maturity` and `rd_maturity_value` from `app/api/deposits.py`:
  - `covers` = estimate ≥ premium;
  - `shortfall` = premium − estimate when short.
  If the account is a PPF, a bank or anything else, return `{account_id, name}` with null maturity fields.
- Card bill: when the paying account is a `credit_card` with `statement_day` and `due_day`, `due = card_bill_due(next occurrence, …)`, and `before_funding` = due < RD maturity date (false when there's no RD).

- [ ] **Step 1:** Write the failing tests (monkeypatch `today_india` to 2026-11-10). Use the owner's policy: Care Health Insurance, "Care Supreme + Care Advanced", A3859370, "Self", sum insured 1000000.00, 2026-04-07 to 2027-04-06, premium 11936.00, `paid_on` 2026-04-06 with no transaction, paid from a credit card (statement day 15, due day 5), funded by an RD opened 2026-05-19, 1500.00 on the 19th, 12 months, 6.50%.
  - Create:
    - the template is yearly, 6 Apr, `start_date` 2027-04-06, remind 30, category "Insurance";
    - `premium_by_fy` is `[{"fy": "2026-27", "amount": "11936.00"}]`;
    - `funded_by.maturity_date` is "2027-05-19", the estimate equals `rd_maturity_value(1500, 6.5, 12)` (≈ 18642.97), and `covers` is true;
    - `card_bill` is `{due: "2027-05-05", before_funding: true}` (Review Focus 5);
    - with a card on statement day 1 and due day 25, `before_funding` is false.
  - `/recurring/due` on 2027-03-07 shows the premium as coming up.
  - Renew on 2027-04-05 for 12500.00 into 2027-04-07 to 2028-04-06:
    - the card balance goes up by 12500.00;
    - the policy moves to the new period;
    - there are 2 periods;
    - `premium_by_fy` gains `2027-28: 12500.00`;
    - nothing is due.
  - Renew atomicity (Review Focus 4): with an archived paying card, a period that starts too early, or a zero amount, the result is 422 and no transaction and no period row are written.
  - Recording a transaction linked to the policy's template through `/transactions` → 422 "Renew the policy instead." (Review Focus 3).
  - Lapse and delete rules, per-user 404s, and validation messages.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the suite and ruff, then PG on the changed files plus the goldens. Expected: PASS.
- [ ] **Step 5:** Commit: `Add health insurance policies with renewal and funding checks`.

### Task 5: Dashboard and docs

**Files:**
- Modify: `backend/app/api/routes/dashboard.py` (new key `recurring: list[DueItem]`, from `due_items`), `docs/architecture/financial-calculations.md` (occurrence rules, the 45-day window, the card bill date, the funding estimate), `docs/architecture/database-design.md` (the new tables), `docs/product/roadmap.md` (Milestone 2: recurring templates built on branch `recurring-insurance`; link the spec)
- Test: `backend/tests/test_dashboard.py`

- [ ] **Step 1:** Write the failing test: the dashboard `recurring` shows a due rent and a coming-up premium, and every existing dashboard key is unchanged (compare against a run with no templates).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement, then update the docs.
- [ ] **Step 4:** Run the suite and ruff, then PG on `test_dashboard.py` plus the goldens. Expected: PASS.
- [ ] **Step 5:** Commit: `Show due and upcoming reminders on the dashboard`.

### Task 6: Website helpers

**Files:**
- Create: `frontend/src/lib/recurring.ts`, `frontend/src/lib/recurring.test.mjs`, `frontend/src/lib/insurance.ts`, `frontend/src/lib/insurance.test.mjs`
- Modify: `frontend/src/lib/transactions.ts` (`recurring_template_id` on the type, and a form pre-filled from a template), `frontend/package.json` (test script)

**Interfaces (produces):**
- Types that mirror Tasks 3–5 exactly.
- `templateFormBlank(frequency)`, `templateFormFrom(t)`, `templatePayload(form, "create"|"edit")`.
- `transactionFormFromTemplate(t, occurrence, today)`: the date is the occurrence when it's due, or today when it's only coming up, so a late payment still settles its own month; the type, amount, accounts, category and note come from the template; `recurring_template_id` is set.
- `dueText(item)`: "Rent: ₹15,000 due since 1 Mar. Record it." / "Care Health Insurance premium: ₹11,936 coming up on 6 Apr." Whole rupees drop the `.00`.
- `scheduleText(t)`: "Every month on the 1st" / "Every year on 6 Apr".
- `renewFormFrom(policy, today)`: the date is today, the amount is the premium, the account is the paying account, the period is the next year (`period_start` = old end + 1 day, `period_end` = old end + 1 year, clamped), and the sum insured is unchanged.
- `fundingText(policy)`: "Funded by Bank of India RD: matures 19 May 2027, about ₹18,643. Covers the ₹11,936 premium." / "… ₹1,200 short."
- `cardBillText(policy)`: "This premium's card bill is due 5 May 2027, before your RD matures on 19 May. Plan to pay it from the bank." It returns null unless `before_funding`.
- `renewalText(policy)`: "Renews 6 Apr 2027 (147 days)".

- [ ] **Step 1:** Write the failing tests, using the values above (the owner's policy).
- [ ] **Step 2:** Run `cd frontend && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run lint && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5:** Commit: `Add recurring and insurance helpers to the website`.

### Task 7: Website screens

**Files:**
- Create: `frontend/src/app/(app)/recurring/page.tsx`, `frontend/src/components/recurring/recurring-view.tsx` (the template list with schedule, amount, accounts, next date and state, stop/restart, edit and delete), `template-dialog.tsx`, `due-list.tsx` (a shared due/coming-up list with Record and Skip, used on three pages)
- Create: `frontend/src/app/(app)/insurance/page.tsx`, `frontend/src/components/insurance/insurance-view.tsx` (policy cards: insurer, plan, policy number, insured, sum insured, premium, renewal text, funding line, card-bill warning, periods history, premium by FY with the 80D note, details), `policy-dialog.tsx` (create and edit, including "Paid on" for the current period and the optional linked payment), `renew-dialog.tsx`
- Modify: `frontend/src/components/sidebar.tsx` (Recurring and Insurance links), `frontend/src/components/dashboard/dashboard-view.tsx` (the due list from `recurring`), `frontend/src/components/transactions/transactions-view.tsx` (the due list above transactions, and Record opening the existing transaction dialog pre-filled through `transactionFormFromTemplate`), `frontend/src/components/transactions/transaction-dialog.tsx` (carries `recurring_template_id`)
- Record on a policy's item opens `renew-dialog`, not the transaction dialog.

- [ ] **Step 1:** Read the Next 16 docs for new pages, and look at an existing page and its sidebar link.
- [ ] **Step 2:** Build the screens.
- [ ] **Step 3:** Run `npx tsc --noEmit && npm run lint && npm test`. Expected: clean.
- [ ] **Step 4:** Commit: `Add recurring reminders and insurance to the website`. (The controller does the browser walk.)

### Task 8: Android helpers

**Files:**
- Create: `mobile/src/lib/recurring.ts`, `mobile/src/lib/recurring.test.mjs`, `mobile/src/lib/insurance.ts`, `mobile/src/lib/insurance.test.mjs`
- Modify: `mobile/src/lib/transactions.ts`, `mobile/package.json`

**Interfaces (produces):** the same names and behaviour as Task 6, plus the phone-form helpers in the style of `funds.ts`:
- `templateErrors(form)` and `renewErrors(form, today)`, using the server's messages;
- `changedTemplate(form, original)`;
- `policyErrors(form)` and `changedPolicy(form, original)`.

- [ ] **Step 1:** Write the failing tests, mirroring Task 6 plus the extra helpers.
- [ ] **Step 2:** Run `cd mobile && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `Add recurring and insurance helpers to the app`.

### Task 9: Android screens

**Files:**
- Modify: `mobile/src/app/(tabs)/index.tsx` (due and coming-up cards from the dashboard's `recurring`: tap to Record, long-press to Skip), `mobile/src/app/(tabs)/profile.tsx` (entries for "Recurring" and "Insurance"; check this is where secondary screens are reached, otherwise follow the existing pattern), `mobile/src/app/_layout.tsx` (register the new screens), `mobile/src/app/transaction-form.tsx` (accept the `templateId` and `occurrence` params, pre-fill, and send `recurring_template_id`)
- Create: `mobile/src/app/recurring.tsx` (list), `mobile/src/app/template-form.tsx`, `mobile/src/app/insurance.tsx` (policy cards), `mobile/src/app/policy-form.tsx`, `mobile/src/app/renew-form.tsx`

- [ ] **Step 1:** Read the Expo SDK 58 Router docs for params and stack screens.
- [ ] **Step 2:** Build the screens, using the existing native date picker and decimal keypads.
- [ ] **Step 3:** Run `npm run typecheck && npm run lint && npm test`. Expected: PASS.
- [ ] **Step 4:** Commit: `Add recurring reminders and insurance to the Android app`. The owner tests on the phone against the deployed API.

---

## After the build (not part of these tasks)

1. The controller does the browser walk on an isolated database, then the final whole-branch review on the most capable model.
2. Before merging, the owner runs `uv run alembic upgrade head` against Neon. Then open the PR, and merge once CI is green.
3. The owner adds the policy in the app (no SQL import).

## Self-review notes

- **Spec coverage:**
  - templates, occurrences, due and coming up, skip and record (T2, T3, T6–T9);
  - shared validation (T3);
  - the policy record, its template sync, and the first period with no transaction (T4);
  - atomic renewal and history (T4);
  - the funding check and card-bill warning (T2, T4);
  - the FY figure (T4);
  - the dashboard (T5);
  - the clients (T6–T9);
  - entering the policy in the app (after the build).
- **Non-goals** have no tasks: claims, family members as data, other insurance kinds, notifications, SIP/RD conversion, and weekly or quarterly frequencies.
- **Rulings made here:**
  - Routes use `/recurring` and `/insurance`.
  - `transactions._validate` is exported as `validate_transaction_values`.
  - One payment settles at most one occurrence, nearest first.
  - Skip only accepts a due or coming-up occurrence.
  - Renew requires the new period to start after the current one ends.
  - Downgrade refuses while data exists.
