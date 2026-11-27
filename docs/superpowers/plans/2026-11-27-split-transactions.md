# Split Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one expense be split across several of the owner's own categories, as linked ordinary transactions.

**Architecture:** A nullable `transactions.split_of_id` points each extra part at the original transaction, which stays part 1. One endpoint (`GET`/`PUT /transactions/{id}/split`) reads and replaces a split; PATCH/DELETE refuse changes that would break a split's total. Nothing that counts by category changes: each part is a normal expense row. Web and phone get a parts editor and a "Split 1 of 2" tag.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic (backend), Next.js (frontend/), Expo Router (mobile/). Tests: pytest, `node --test` .mjs files.

**Spec:** `docs/superpowers/specs/2026-11-27-split-transactions-design.md`

## Global Constraints

- Ponytail mode: smallest complete change; reuse existing helpers (`resolve` for categories, `subtractMoney` for money text, `_lock_transaction`, `_require_active`); no new dependencies.
- Only `type == "expense"` can be split. At least 2 parts to split; 1 part (the whole amount) undoes a split. At most 20 parts.
- Each part: a category and an amount > 0 with at most 2 decimals; parts add up exactly to the bill (the original plus its current parts).
- Every part has the original's date, account, note and source.
- Refused edits/deletes use exactly: `"Change the split instead."`
- Run backend tests with `ENVIRONMENT=test` (`cd backend && ENVIRONMENT=test .venv/Scripts/python -m pytest ...`). Lint: `.venv/Scripts/python -m ruff check app tests` and `ruff format` on touched files.
- Do NOT edit `mobile/package.json` `scripts.test` (changes the Expo runtime fingerprint). New phone helpers go in an existing test file that's already listed (`src/lib/transactions.test.mjs`).
- Migration revises `b4e8c2a6d9f1`; must be run on Neon before the API deploy.

## Review Focus

- Splitting an expense that already has linked refunds: the refunds stay linked to the original (part 1) and keep its category. Test in Task 2.
- Re-splitting with fewer parts: removed parts are deleted, and any refund linked to a removed part is re-linked to the original. Test in Task 2.
- A split on an archived account: refused with the existing "Restore … before changing this transaction." 409. Test in Task 2.
- Editing a part's category through normal PATCH still works (only amount/date/account/type are blocked). Test in Task 3.
- The SMS for a hand-typed bill arrives after it was split: linked to the original, not recorded again. Test in Task 4.

---

### Task 1: Column, migration and the `split` tag on responses

**Files:**
- Modify: `backend/app/models/transaction.py` (after `refund_of_id`)
- Create: `backend/migrations/versions/2026_11_27_1000-c5f1a8d3e2b7_add_split_of_id.py`
- Modify: `backend/app/api/routes/transactions.py` (`TransactionResponse`, `_to_response`, its callers in `list_transactions`, `get_transaction`, `create_transaction`, `update_transaction`)
- Test: `backend/tests/test_splits.py` (new)

**Interfaces:**
- Produces: `Transaction.split_of_id: Mapped[int | None]` (FK `transactions.id`, `ondelete="CASCADE"`, indexed).
- Produces: `class SplitTag(BaseModel): id: int; part: int; parts: int` (id = the original's id; part is 1-based, original = 1, others by id).
- Produces: `TransactionResponse.split: SplitTag | None` (None when not split).
- Produces: `def split_tags(db: Session, user_id: int, txs: Iterable[Transaction]) -> dict[int, SplitTag]` in `transactions.py`, used by every response builder (pass `split=tags.get(tx.id)` into `_to_response`).

- [ ] **Step 1: Write the failing test** `test_unsplit_has_no_tag`: create an expense via `POST /api/transactions`; assert `response.json()["split"] is None` and the list row has `"split": None`. (Helpers: `auth`, `make` from `tests/test_accounts.py`; `spend` from `tests/test_adjustments.py`.) Add `"split": None` to any exact-shape transaction response assertions that now fail (grep tests for `"refunded": None`).
- [ ] **Step 2: Run** `pytest tests/test_splits.py -q` → FAIL (`KeyError: 'split'`).
- [ ] **Step 3: Implement** the column, migration (`op.add_column("transactions", sa.Column("split_of_id", sa.Integer(), sa.ForeignKey("transactions.id", ondelete="CASCADE"), nullable=True))` + `op.create_index("ix_transactions_split_of_id", ...)`; downgrade drops both), `SplitTag`, `split_tags` (one query: rows whose `split_of_id` is in the given ids or whose id is a `split_of_id` of a given row), and `split` on responses.
- [ ] **Step 4: Run** `pytest tests/test_splits.py tests/test_transactions*.py -q` → PASS.
- [ ] **Step 5: Commit** `feat(transactions): split_of_id column and split tag`.

### Task 2: `GET` and `PUT /transactions/{id}/split`

**Files:**
- Modify: `backend/app/api/routes/transactions.py` (new models + two routes, placed before `@router.get("/{id}")`)
- Test: `backend/tests/test_splits.py`

**Interfaces:**
- Consumes: `split_tags`, `SplitTag` (Task 1); `_lock_transaction`, `_require_active`, `resolve` (existing).
- Produces: `class SplitPartIn(BaseModel): category: Category; amount: Money` (reuse the module's existing money/category annotated types; category required).
- Produces: `class SplitIn(BaseModel): parts: list[SplitPartIn]` (1–20 items).
- Produces: `class SplitPart(BaseModel): id: int; category: str; amount: str` and `class SplitOut(BaseModel): id: int; total: str; parts: list[SplitPart]` (id = original).
- Produces: `GET /api/transactions/{id}/split -> SplitOut` (id may be the original or any part; resolves to the original). `PUT /api/transactions/{id}/split` body `SplitIn` -> `SplitOut` (id must be the original or a part; resolves to the original).

Rules for PUT (one 422 `field_error("parts", message)` each, messages as given):
- original not `expense` → `"Only an expense can be split."`
- parts don't add up to the total → `f"The parts add up to {rupees(sum)}; the bill is {rupees(total)}."`
- an amount ≤ 0 → `"Each part needs an amount above 0."`
- 0 or more than 20 parts → `"Split into 2 to 20 parts."` (1 part is allowed and undoes the split)
- Then: part 1 updates the original's `amount` and `category`; parts 2..n reuse existing part rows in id order (update amount/category) and create the rest with the original's `type, date, account_id, note, source, user_id` and `split_of_id = original.id`; leftover part rows are deleted after re-linking their refunds (`refund_of_id`) to the original. Categories via `resolve(db, user_id, "expense", name)`. Linked refunds of any part keep `refund_of_id`; when a part's category changes, its linked refunds take the new category (as PATCH does today).

- [ ] **Step 1: Write the failing tests** in `tests/test_splits.py`:
  - `test_split_into_two`: expense ₹3,000 "Groceries"; PUT `{"parts":[{"category":"Groceries","amount":"2200.00"},{"category":"Household","amount":"800.00"}]}` → 200; `parts` amounts `["2200.00","800.00"]`; first part id == original id; list shows two rows tagged `{"id": orig, "part": 1, "parts": 2}` and `{..."part": 2, "parts": 2}`; account balance unchanged.
  - `test_cash_flow_counts_each_category`: after the split, `GET /api/cash-flow` spending has Groceries 2200 and Household 800.
  - `test_resplit_and_undo`: split into 3, then PUT with 2 parts → only 2 rows remain; PUT with 1 part `3000.00` → one row, `split` None.
  - `test_parts_must_add_up`: parts 2000+800 → 422, message contains "The parts add up to ₹2,800; the bill is ₹3,000."
  - `test_only_expenses`: an income → 422 "Only an expense can be split."
  - `test_zero_part_refused`: a part `"0.00"` → 422.
  - `test_refund_follows_removed_part`: split into 2, link a refund (`type="refund"`, `refund_of_id=<part 2 id>`), re-split into 1 part → the refund's `refund_of_id` is the original.
  - `test_archived_account_refused`: archive needs zero balance, so set the account's `archived_at` directly in `db_session`; PUT → 409.
  - `test_get_split_from_a_part`: GET with part 2's id returns the original's `SplitOut`.
- [ ] **Step 2: Run** `pytest tests/test_splits.py -q` → the new tests FAIL (404/405).
- [ ] **Step 3: Implement** the models and the two routes per the rules above.
- [ ] **Step 4: Run** `pytest tests/test_splits.py -q` → PASS.
- [ ] **Step 5: Commit** `feat(transactions): split an expense into parts`.

### Task 3: PATCH and DELETE keep splits whole

**Files:**
- Modify: `backend/app/api/routes/transactions.py` (`update_transaction`, `delete_transaction`)
- Test: `backend/tests/test_splits.py`

**Interfaces:**
- Consumes: `Transaction.split_of_id` (Task 1).

- [ ] **Step 1: Write the failing tests**:
  - `test_part_category_and_note_editable`: PATCH part 2 `{"category":"Personal care","note":"soap"}` → 200.
  - `test_part_amount_date_account_type_refused`: for each of `{"amount":"500.00"}`, `{"date": <yesterday>}`, `{"account_id": <other bank>}`, `{"type":"income","category":"Salary"}` on part 2 and on the original → 422 containing "Change the split instead."
  - `test_delete_part_refused`: DELETE part 2 → 409 "Change the split instead."
  - `test_delete_original_deletes_parts`: DELETE original → 200; list has neither row; balance back to opening.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: in `update_transaction`, if the tx is a part or has parts and `changes` touches `amount`, `date`, `account_id`, `to_account_id` or `type` with a different value, raise `RequestValidationError([field_error(<that field>, "Change the split instead.")])`. In `delete_transaction`, refuse a part (409) and, for an original, include its parts in the `balance_problem` "after" list and unlink their refunds (the FK cascade removes the rows).
- [ ] **Step 4: Run** `pytest tests/test_splits.py tests/test_transactions*.py -q` → PASS.
- [ ] **Step 5: Commit** `feat(transactions): edits and deletes keep a split whole`.

### Task 4: The SMS for a split bill links to it

**Files:**
- Modify: `backend/app/sms/ingest.py` (`_typed_by_hand`, ~line 371)
- Test: `backend/tests/test_splits.py`

**Interfaces:**
- Consumes: `Transaction.split_of_id`.

- [ ] **Step 1: Write the failing test** `test_sms_after_split_links_original`: type a ₹3,000 expense on a bank with `last4`, split it 2200/800, then ingest a debit SMS for ₹3,000 that day (use the ingest helpers in `tests/test_sms_ingest.py`); assert the entry's `transaction_id` is the original id, its status `"recorded"`, and the account has still only the two part rows.
- [ ] **Step 2: Run** → FAIL (a third transaction gets recorded).
- [ ] **Step 3: Implement**: in `_typed_by_hand`, replace `Transaction.amount == entry.amount` with `or_(Transaction.amount == entry.amount, Transaction.id.in_(<originals whose amount + parts' amounts == entry.amount>))`, and exclude parts themselves (`Transaction.split_of_id.is_(None)`). The originals subquery: `select(func.coalesce(T.split_of_id, T.id)).group_by(func.coalesce(T.split_of_id, T.id)).having(func.count() > 1, func.sum(T.amount) == entry.amount)` limited to the user.
- [ ] **Step 4: Run** `pytest tests/test_splits.py tests/test_sms_ingest.py -q` → PASS, then the full backend suite → PASS.
- [ ] **Step 5: Commit** `fix(sms): a split bill's SMS links to the split`.

### Task 5: Web: split editor and tag

**Files:**
- Modify: `frontend/src/lib/transactions.ts` (types + helpers), `frontend/src/lib/transactions.test.mjs`
- Create: `frontend/src/components/transactions/split-dialog.tsx`
- Modify: `frontend/src/components/transactions/transaction-dialog.tsx` (a "Split" button in edit mode for an editable expense, opening `SplitDialog`), `frontend/src/components/transactions/transactions-view.tsx` (the row's category line gains ` · Split 1 of 2`)

**Interfaces:**
- Consumes: `GET/PUT /transactions/{id}/split` (`SplitOut`), `Transaction.split` (Tasks 1–2).
- Produces in `lib/transactions.ts`: `type SplitTag = { id: number; part: number; parts: number }`; `split?: SplitTag | null` on `Transaction`; `type SplitPart = { category: string; amount: string }`; `splitLabel(tag: SplitTag | null | undefined): string | null` → `"Split 1 of 2"`; `splitLeft(total: string, parts: SplitPart[]): string` → total minus the sum of parts via `subtractMoney` (treat a blank amount as `"0.00"`; return `""` if any amount is malformed).

- [ ] **Step 1: Write the failing tests**: `splitLabel(null) === null`, `splitLabel({id:1,part:2,parts:3}) === "Split 2 of 3"`; `splitLeft("3000.00", [{category:"a",amount:"2200.00"},{category:"b",amount:""}]) === "800.00"`, `splitLeft("3000.00", [{category:"a",amount:"3100.00"}]) === "-100.00"`, malformed `"12.5"` → `""`.
- [ ] **Step 2: Run** `cd frontend && npm test` → FAIL.
- [ ] **Step 3: Implement** the helpers, then `SplitDialog({ transactionId, onClose, onSaved })`: loads `GET /transactions/{id}/split`, one row per part (category input using the dialog's existing category field pattern, amount input), "Add part", a live "Left to assign ₹X" from `splitLeft`, Save disabled unless left is `"0.00"`, PUT on save; server errors shown with the dialog's existing error pattern. Wire the button and the row tag.
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit`, `npx eslint` on touched files, `npx next build` → all pass.
- [ ] **Step 5: Commit** `feat(web): split a transaction across categories`.

### Task 6: Phone: split screen and tag

**Files:**
- Modify: `mobile/src/lib/transactions.ts`, `mobile/src/lib/transactions.test.mjs` (same types/helpers and tests as Task 5)
- Create: `mobile/src/app/split-form.tsx` (screen, param `id`)
- Modify: `mobile/src/app/_layout.tsx` (`<Stack.Screen name="split-form" />` after `transaction-form`), `mobile/src/app/transaction-form.tsx` (a "Split" `ChunkyButton` in edit mode for an editable expense → `router.push({ pathname: "/split-form", params: { id } })`), `mobile/src/components/transactions-list.tsx` (meta line gains `splitLabel`)

**Interfaces:**
- Consumes: same endpoints as Task 5; `splitLabel`, `splitLeft` (this task's copies in `mobile/src/lib/transactions.ts`).

- [ ] **Step 1: Write the failing tests** (copy of Task 5's helper tests into `mobile/src/lib/transactions.test.mjs`).
- [ ] **Step 2: Run** `cd mobile && npm test` → FAIL.
- [ ] **Step 3: Implement** the helpers and the screen with the same behaviour as Task 5's dialog (ScreenHeader "Split", rows, "Add part", "Left to assign", Save → PUT then `router.back()`), using the transaction form's existing category picker and amount field components.
- [ ] **Step 4: Run** `npm test`, `npx tsc --noEmit`, `npx expo lint` → pass; `npx expo-updates runtimeversion:resolve --platform android` unchanged from before the task (`cd7279c…` with the current scripts line).
- [ ] **Step 5: Commit** `feat(mobile): split a transaction across categories`.

### Task 7: Rules doc and final check

**Files:**
- Modify: `docs/architecture/financial-calculations.md` (a "Split transactions" paragraph under "Cash flow")

- [ ] **Step 1:** Write the paragraph: what can be split, the add-up rule, that each part counts as its own expense in cash flow/budgets/digest/calendar, that the SMS link stays on part 1 and its duplicate check matches the split total, and the "Change the split instead." rules.
- [ ] **Step 2: Run** the full backend suite, web `npm test` + `tsc`, phone `npm test` + `tsc` → all pass.
- [ ] **Step 3: Commit** `docs: split transactions rules`.
