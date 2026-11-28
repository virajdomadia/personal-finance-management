# Statement Import Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Statement imports never double-count, near-duplicates are caught, Match bank compares like with like, scanned PDFs get a clear message.

**Architecture:** Backend changes in `app/export/statements.py`, `app/export/statement_files.py`, `app/export/importing.py`, `app/api/routes/statement_import.py`, `app/api/routes/accounts.py`; a preview note on web (`frontend/src/components/statement/statement-import-view.tsx`) and phone (`mobile/src/app/statement-import.tsx`).

**Tech Stack:** FastAPI, SQLAlchemy, pytest; Next.js; Expo.

**Spec:** `docs/superpowers/specs/2026-11-28-statement-import-safety-design.md`

## Global Constraints
- No migration. Run backend tests with `ENVIRONMENT=test`.
- Copy exactly as in the spec.
- mobile/package.json `test` script must not change (EAS runtime fingerprint).

## Review Focus
- A transfer line between two accounts added on different days: each side shifts only if the line is on/before *its* account's added day.
- A credit-card (liability) account: the opening shift has the opposite sign.
- Two saved movements, one exact and one ₹0.50 off: the exact one is taken first.
- A balance SMS that is the last of its day: check unchanged from today's behaviour.
- A text PDF with a logo image still reads normally.

---

### Task 1: Scanned PDF message
**Files:** Modify `backend/app/export/statement_files.py` (`_pdf`); Test `backend/tests/test_statements.py`
- [ ] Test `test_a_scanned_pdf_says_so`: FPDF page with only an image (`pdf.image` of a tiny PNG made with Pillow or bytes) → `read_grid` raises FileProblem matching "scanned image".
- [ ] In `_pdf`, if no page has `chars` and some page has `images`, raise the spec message.
- [ ] Run tests, commit.

### Task 2: Near-duplicates within ₹1
**Files:** Modify `backend/app/export/statements.py` (`_take`); Test `backend/tests/test_statements.py`
- [ ] Test `test_a_line_a_few_paise_off_a_saved_one_is_a_duplicate`: saved expense 227.00, statement line 227.05 same day → preview `duplicate` true. Plus `_take` unit test: saved [(d, 227.50,"out"), (d, 227.05,"out")], line 227.05 → removes the exact one.
- [ ] `_take`: first exact match, else first with `abs(diff) < 1`.
- [ ] Run tests, commit.

### Task 3: Opening shift for lines before the account was added
**Files:** Modify `backend/app/export/statements.py` (`save_lines`, new `added_on(account) -> date`), `backend/app/export/importing.py` (split `step_problem` into `changes_problem(accounts, flows, changes: dict[int, Decimal])`), `backend/app/api/routes/statement_import.py` (preview fields `added_on: str`, `before_start: int`); Test `backend/tests/test_statements.py`
- [ ] Tests: `test_lines_before_the_account_was_added_keep_todays_balance` (bank, balance stays 10000 after importing −649/+40000 dated before added day; opening becomes 10000 − 39351); `test_lines_after_the_account_was_added_move_the_balance` (set `created_at` 10 days back → balance moves); `test_a_card_line_before_it_was_added_keeps_what_is_owed`; `test_a_transfer_shifts_each_side_by_its_own_added_day`; `test_preview_counts_lines_before_the_account`.
- [ ] `added_on`: `created_at` (naive = UTC) to India date. In `save_lines`, per kept line: `changes = net_flows([movement])`; shifted = accounts in changes whose `added_on >= line.date`; check and apply only the rest to `flows`; collect shifts; at commit, for each shifted account: asset `opening -= change`, liability `opening += change`.
- [ ] Update existing tests that expect balances to move (give their accounts an older `created_at`).
- [ ] Run tests, commit.

### Task 4: Match bank end-of-day
**Files:** Modify `backend/app/api/routes/accounts.py` (`bank_checks`); Test `backend/tests/test_bank_check.py`
- [ ] Test `test_payments_after_the_balance_sms_that_day_count`: balance SMS (credit, B=3585.44), then later same-day debit SMS 299/170/387 without balance → check `balance` "2729.44" and gap measured against it.
- [ ] Query all debit/credit SMS for the bank accounts ordered by (occurred_on, id); track per account the latest balance SMS and the sum of later same-day movements; bank end-of-day = B − debits + credits.
- [ ] Run tests, commit.

### Task 5: Preview note on web and phone
**Files:** `frontend/src/lib/statement-import.ts`, `frontend/src/components/statement/statement-import-view.tsx`, `mobile/src/lib/statement-import.ts`, `mobile/src/app/statement-import.tsx`; tests beside existing ones.
- [ ] Add `added_on: string; before_start: number` to `StatementPreview`; pure `beforeStartNote(p): string | null` (null when 0) in each lib with a unit test; render it under the summary.
- [ ] Run web + phone tests and typecheck, commit.
