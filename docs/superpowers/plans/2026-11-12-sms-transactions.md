# SMS Transactions Implementation Plan (Builds 2 and 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bank, card and CDSL SMS fill in Gullak's transactions and stock-trade drafts by themselves. Anything the app can't be sure of waits in a "To review" list on the website and the app.

**Architecture:** The phone reads SMS from known bank senders, parses them in JavaScript and sends **only parsed fields plus a hash** to `POST /api/sms/entries`. The server (`backend/app/sms/`) decides each entry in a fixed order: duplicates, account, already-typed, transfer pairs, expected payments, category. It records the money straight away whenever the account and amount are known, and leaves a review reason on the entry for whatever is still missing. Review, payee-rule and identifier endpoints back a To review screen on the website and the app. A small local Expo module in Kotlin reads the SMS inbox; everything else is JS that ships with `eas update`.

**Tech Stack:** FastAPI, SQLAlchemy 2, Alembic, PostgreSQL (Neon) / SQLite in tests, Next.js website, Expo SDK 58 app with a local Expo module (Kotlin), `expo-crypto`.

**Spec:** `docs/superpowers/specs/2026-11-12-automation-design.md`, sections 1–6 and 8. Section 7 (prices) shipped in PRs #11–#13.

## Global Constraints

- Money is `Decimal` / `NUMERIC` end to end. The phone sends amounts as strings (`"1234.50"`); the server parses them with the existing `Money` validator. No client arithmetic on amounts.
- **The raw SMS text never leaves the phone**, except through "Send sample", after an explicit tap, masked, one message at a time. The server re-masks samples (every run of 3+ digits becomes `X`s) before storing them.
- Only messages from known bank, card and depository senders are opened. Everything else is never read past the sender check.
- SMS-created transactions go through `save_checks` like manual ones. The single exception is that an SMS expense or income may be saved **with no category** (`category = None`, `source = "sms"`). Summaries show it as `"Uncategorised"`.
- If recording would fail the existing checks (for example below ₹0), the entry is **not** recorded. It goes to review with reason `"balance"` and the checker's message.
- Matching windows (from the spec): manual duplicate ±1 day; transfer pair 3 days; recurring template amount ±10% (inclusive) and within its reminder window; CDSL draft vs. a manual trade 2 days; SIP debit within 3 days of its debit day.
- Per-user data: entries, rules, identifiers and samples always filter by `user_id`. Someone else's id is reported as "not found", the same as a missing one.
- Migration: one Alembic revision, `down_revision = "c7e2a95d1b48"`. The **owner runs it on Neon before the merge**; the PR's first line says so.
- No new Vercel environment variables.
- Website and app get their own UI in the Gullak chunky style. No copied layouts.
- The app reads SMS **only when opened or brought to the front**, never in the background. Off by default. Start date defaults to today, at most 90 days back.
- The native module is optional at runtime: with no module (an older APK getting this JS), the SMS settings say "Needs the latest app version" and nothing crashes.
- Checks before each commit: `cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy app && uv run pytest`; for the website `cd frontend && npm run lint && npm test && npx tsc --noEmit`; for the app `cd mobile && npm run lint && npm test && npm run typecheck`. (Use whichever of these the repo's root `npm run lint` / `npm test` already wires; `backend/pyproject.toml` lists the backend tools.)
- PostgreSQL run for schema work: `TEST_DATABASE_URL=postgresql+psycopg://pfm:pfm@localhost:5434/pfm_test uv run pytest` with the dev cluster started (`npm run db:start`).

## Review Focus

1. **The same SMS sent twice, including two concurrent uploads of one batch:** recorded once. The second upload gets `"duplicate"` per entry, not a 500. Pinned in Task 3 (`test_same_hash_twice_records_once`, `test_concurrent_hash_conflict_is_duplicate`).
2. **A bank debit and the card's "payment received" SMS for one card bill:** become one transfer, whichever arrives first, and the card's balance and the bank's balance both move once. Pinned in Task 4.
3. **A ₹500 debit and an unrelated ₹500 credit in two of the owner's accounts, no shared reference:** recorded separately, and the second asks "Is this a transfer?". Never merged silently. Pinned in Task 4.
4. **Deleting an SMS-created transaction, then the phone uploading the same SMS again:** not brought back. Pinned in Task 3.
5. **An SMS whose last 4 digits match two accounts (or none):** nothing recorded. Review asks which account, and the answer is remembered for the next SMS with those digits. Pinned in Tasks 3 and 7.

---

## Build 2: server and website

### Task 1: Schema

**Files:**
- Create: `backend/app/models/sms.py`, `backend/migrations/versions/2026_11_12_1800-<rev>_add_sms.py`
- Modify: `backend/app/models/transaction.py`, `backend/app/models/investment.py` (`InvestmentTrade`), `backend/app/models/__init__.py`
- Test: `backend/tests/test_sms_models.py`; extend `backend/tests/test_pg_migrations.py` the way earlier revisions are covered

**Interfaces (produces):**
- `Transaction.source: Mapped[str]` `String(10)`, `server_default "manual"`; `"manual"` or `"sms"`.
- `InvestmentTrade.estimated: Mapped[bool]` `server_default false()`. True for SIP units worked out from an SMS until the owner confirms them.
- `AccountIdentifier` (`account_identifiers`): `id`, `user_id` FK users, `account_id` FK accounts (index), `last4` `String(4)`, `created_at`. Unique `(account_id, last4)`.
- `SmsEntry` (`sms_entries`): `id`; `user_id` FK (index); `hash` `String(64)`; `sender` `String(20)`; `bank` `String(30)` (parser key, such as `"hdfc"`); `kind` `String(20)` (`"debit" | "credit" | "card_spend" | "card_payment" | "card_statement" | "demat"`); `amount` `Numeric(14,2) | None`; `occurred_on` `Date`; `last4` `String(4) | None`; `payee` `String(120) | None` (display text); `payee_key` `String(120) | None`; `ref` `String(40) | None`; `balance` `Numeric(14,2) | None`; `isin` `String(12) | None`; `quantity` `Numeric(24,8) | None`; `due_date` `Date | None` (card statements); `account_id` FK accounts nullable; `status` `String(12)` (`"recorded" | "review" | "draft" | "ignored" | "duplicate"`); `reason` `String(20) | None`; `message` `String(200) | None` (a human sentence for the review card); `candidates` `JSON | None` (list of `{"kind": str, "id": int, "label": str}`); `transaction_id` FK transactions nullable (index); `trade_id` FK investment_trades nullable; `created_at`. Unique `(user_id, hash)`. Index `(user_id, status)`. Index `(user_id, ref)`.
- `PayeeRule` (`payee_rules`): `id`, `user_id` FK, `payee_key` `String(120)`, `display` `String(120)`, `category` `String(40) | None`, `to_account_id` FK accounts nullable, `template_id` FK recurring_templates nullable, `created_at`, `updated_at`. Unique `(user_id, payee_key)`.
- `SmsSample` (`sms_samples`): `id`, `user_id` FK, `sender` `String(20)`, `text` `String(500)`, `created_at`.
- Card statements are `SmsEntry` rows with `kind="card_statement"`, `amount` = statement total and `due_date`; no extra table (my call: one table fewer, same data).

- [ ] **Step 1: Write failing tests** `test_sms_hash_unique_per_user` (same hash for one user → `IntegrityError`; same hash for two users is fine), `test_transaction_source_defaults_manual`, `test_trade_estimated_defaults_false`, `test_identifier_unique_per_account`.
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/test_sms_models.py -v`. Expected: FAIL (import error).
- [ ] **Step 3: Add the models and the migration** with a working downgrade.
- [ ] **Step 4: Run** the test file, then `tests/test_pg_migrations.py` on PostgreSQL. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add SMS entries, payee rules and account identifiers to the schema"`

### Task 2: Payee names and the built-in merchant list

**Files:**
- Create: `backend/app/sms/__init__.py`, `backend/app/sms/payees.py`, `backend/app/sms/merchants.py`
- Test: `backend/tests/test_sms_payees.py`

**Interfaces (produces):**
- `payee_key(raw: str) -> str`: casefold, trim, collapse whitespace, drop a leading `VPA `/`UPI/`/`TO `/`BY ` prefix. A UPI id is kept whole as the key (`"swiggy@icici"`).
- `display_name(raw: str) -> str`: for a UPI id, the part before `@`, with digits-only runs and `.`/`_` separators turned to spaces, title-cased (`"zomato.order@hdfcbank"` → `"Zomato Order"`); else the trimmed text title-cased, at most 60 chars.
- `builtin_category(key: str) -> str | None`: the first entry of an ordered keyword list contained in `key`. Categories must be names from `DEFAULT_CATEGORIES["expense"]`. At least: swiggy, zomato, dominos, mcdonald, starbucks → Food and dining; uber, ola, rapido, irctc, redbus, metro → Transport; amazon, flipkart, myntra, ajio, meesho, nykaa → Shopping; bigbasket, blinkit, zepto, dmart, jiomart, instamart → Groceries; petrol, fuel, hpcl, bpcl, iocl, indianoil, shell → Fuel; airtel, jio, vodafone, vi , bsnl, tatapower, adani electricity, bescom, mahavitaran, act fibernet → Utilities; netflix, spotify, hotstar, primevideo, bookmyshow → Entertainment; apollo, pharmeasy, 1mg, netmeds, practo → Health; makemytrip, goibibo, cleartrip, indigo, airindia, oyo → Travel. Word-ish match: `"ola"` must not match `"motorola"` (match on token boundaries: start, end, or one of ` @._-/`).

- [ ] **Step 1: Write failing tests:** `test_key_keeps_upi_handle` (`payee_key(" Swiggy@ICICI ") == "swiggy@icici"`), `test_display_cleans_upi` (case above), `test_builtin_matches_tokens` (`builtin_category("swiggy@icici") == "Food and dining"`, `builtin_category("motorola store") is None`, `builtin_category("ola@paytm") == "Transport"`), `test_builtin_categories_are_defaults` (every value in the list is in `DEFAULT_CATEGORIES["expense"]`).
- [ ] **Step 2: Run** `uv run pytest tests/test_sms_payees.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Normalise payee names and add the built-in merchant list"`

### Task 3: Ingest: duplicates, accounts, already-typed, categories, record straight away

**Files:**
- Create: `backend/app/sms/ingest.py` (decision logic), `backend/app/api/routes/sms.py` (endpoint), register in `backend/app/api/router.py`
- Modify: `backend/app/api/routes/transactions.py`
- Test: `backend/tests/test_sms_ingest.py`, extend `backend/tests/test_transactions.py`

**Interfaces:**
- Consumes: Task 1 models, Task 2 helpers, `lock_accounts`, `save_checks`, `validate_transaction_values` from `transactions.py`.
- Produces:
  - Request `ParsedSms` (pydantic, `extra="forbid"`): `hash: str` (64 hex chars), `sender: str` (≤20), `bank: str` (≤30), `kind` (the six kinds), `amount: Money | None`, `date: Day` (≤ today), `last4: str | None` (exactly 4 digits), `payee: str | None` (≤120), `ref: str | None` (≤40), `balance: Money | None`, `isin: str | None`, `quantity: Decimal | None`, `due_date: Day | None`. `SmsBatch = {entries: list[ParsedSms]}` with 1–100 entries.
  - `POST /api/sms/entries` → `{"results": [{"hash": str, "status": str, "reason": str | None}]}`, in input order. Each entry is decided and committed on its own, so one bad entry doesn't undo the others.
  - `ingest(db: Session, user_id: int, sms: ParsedSms) -> SmsEntry` in `app/sms/ingest.py`. Later tasks add steps to it; keep each step a small function returning `SmsEntry | None` ("decided" or "not mine, carry on").
  - `resolve_account(db, user_id, kind, last4) -> list[Account]`: active accounts whose `last4` or any `AccountIdentifier.last4` equals `last4`. `card_spend`/`card_payment`/`card_statement` only consider `credit_card` accounts; `debit`/`credit` consider `bank`, `wallet` and `credit_card` (a debit-card spend lands on the bank through an identifier).
  - `record(db, user_id, entry, values: dict) -> bool`: runs `save_checks` with `allow_uncategorised=entry.source_is_sms`, adds the `Transaction(source="sms")`, links `entry.transaction_id`. On a `RequestValidationError` it leaves the entry unrecorded with `status="review"`, `reason="balance"` and `message` = the first error's message, and returns False.
  - In `transactions.py`: `validate_transaction_values(values, accounts, allow_uncategorised: bool = False)` and `save_checks(..., allow_uncategorised: bool = False)`. `TransactionResponse` gains `from_sms: bool` and `category` may be `None` for income/expense. `expense_breakdown` names a `None` category `"Uncategorised"` (an existing `"Other"` stays `"Other"`). `update_transaction` allows a `None` category only when the stored one is already `None` and `tx.source == "sms"`. `delete_transaction` sets every `SmsEntry` with that `transaction_id` to `status="ignored"`, `transaction_id=None`, before deleting.

Decision order in this task (later tasks insert steps 4–6):
1. Hash already stored for the user → return that entry; the response says `"duplicate"`. Concurrent insert hitting the unique constraint → rollback, re-read, `"duplicate"`.
2. `kind == "card_statement"` → resolve the card; store with `status="recorded"`, no transaction (unknown card → review `"account"`).
3. Account: none or several → `status="review"`, `reason="account"`, `message="Which account is XX{last4}?"`, nothing recorded.
4. Same `ref` already on a non-ignored entry for that account → `"duplicate"`.
5. Already typed in by hand: the account's `source="manual"` transactions not linked to any entry, same amount, date within ±1 day, matching direction (a debit or card spend matches an `expense`, an `emi` paid from the account, or a `transfer` out of it; a credit matches `income` or a `transfer` into it). Exactly one → link it, `status="recorded"`. Several → `status="review"`, `reason="maybe_duplicate"`, `candidates` = those transactions (`kind: "transaction"`, label `"<date> · <category or type> · ₹<amount>"`). Nothing new recorded.
6. Category: a user `PayeeRule` for `payee_key` with a category wins, then `builtin_category` (debits and card spends only). Debit/card spend → `expense`; credit → `income`. No category → record uncategorised, `status="review"`, `reason="category"`, `message="New payee: <display>"`. With a category → `status="recorded"`, no reason.

- [ ] **Step 1: Write failing tests** (helpers in the test module create a user, a bank `last4="1234"` and a card `last4="9876"` with opening balances):
  - `test_debit_with_known_merchant_records_expense` (payee `swiggy@icici`, ₹250 → expense, Food and dining, `from_sms` true, status `"recorded"`)
  - `test_new_payee_records_uncategorised_and_asks` (status `"review"`, reason `"category"`, transaction exists with `category is None`; `GET /transactions` breakdown names it `"Uncategorised"`)
  - `test_user_rule_beats_builtin`
  - `test_same_hash_twice_records_once`, `test_concurrent_hash_conflict_is_duplicate` (insert the entry row directly mid-flight by monkeypatching, or on PostgreSQL with two sessions; mark `postgres` if it needs real concurrency)
  - `test_same_ref_same_account_is_duplicate`
  - `test_matches_single_manual_entry_within_a_day` (manual expense ₹300 yesterday → linked, no new transaction)
  - `test_two_manual_candidates_go_to_review` (nothing new recorded)
  - `test_unknown_last4_asks_for_account`, `test_last4_on_two_accounts_asks_for_account`
  - `test_debit_card_identifier_lands_on_bank` (identifier `5555` on the bank; a `debit` with `5555` records on the bank)
  - `test_below_zero_goes_to_review_unrecorded` (reason `"balance"`, message mentions below ₹0)
  - `test_card_statement_stored_without_transaction`
  - `test_deleted_sms_transaction_is_not_brought_back` (record, `DELETE /transactions/{id}`, post same hash → still no transaction, entry `"ignored"`)
  - `test_other_users_rules_and_accounts_unused`
  - In `test_transactions.py`: `test_manual_create_still_needs_category`, `test_editing_note_of_uncategorised_sms_transaction_is_allowed`.
- [ ] **Step 2: Run** `uv run pytest tests/test_sms_ingest.py tests/test_transactions.py -v`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the endpoint, `ingest` steps 1–6 and the `transactions.py` changes.
- [ ] **Step 4: Run** the full backend suite (ledger invariants included). Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Record bank SMS as transactions, with duplicate and account checks"`

### Task 4: Transfers and card bill payments

**Files:**
- Modify: `backend/app/sms/ingest.py`
- Test: `backend/tests/test_sms_transfers.py`

**Interfaces:**
- Consumes: Task 3 `ingest`, `record`.
- Produces: `pair_transfer(db, user_id, entry, account) -> SmsEntry | None`, inserted after "already typed" and before "category".

Rules (spec 4.4):
- **Same reference on both sides:** a debit in A and a credit in B (A ≠ B, both the user's) with equal `ref`, amount, and dates within 3 days → the first side's transaction becomes `type="transfer"`, `account_id=A`, `to_account_id=B`, `category=None`; the second entry links to it. Status `"recorded"` on both, review reasons cleared.
- **Payee is one of the user's own account numbers:** a debit whose payee is a masked account number (`XX650`, `X8650`, `A/c XX8650`; payee text that's only `X`s and 3–4 digits) where those digits are the end of exactly one *other* active account's `last4` or identifier → record `transfer` A → that account (the real Federal Bank SMS "via IMPS to XX650" for a transfer to the owner's BOI account …8650). The matching credit SMS in that account later links to it as below.
- **Payee rule pointing at an account:** a debit whose `PayeeRule.to_account_id` is set → record `transfer` A → that account. A later credit in that account, same amount, within 3 days, matches that transfer (link, nothing new).
- **Card "payment received" (`card_payment`):** look for an SMS-recorded debit from a bank/wallet, same amount, within 3 days before or after, not yet a transfer → convert it to `transfer` bank → card and link. None found → `status="review"`, `reason="card_payment"`, nothing recorded, `message="Which account paid ₹<amount> to <card>?"`, `candidates` = the user's active banks and wallets (`kind: "account"`).
- **A bank debit arriving after an unrecorded `card_payment` entry** of the same amount within 3 days → record `transfer` bank → card, link both, clear the card entry's review.
- **No evidence, but a matching opposite side exists** (a credit in B for a recorded debit in A, same amount, within 3 days, neither a transfer): record the new one as usual, then set `status="review"`, `reason="maybe_transfer"`, `message="Is this a transfer between your accounts?"`, `candidates=[{"kind": "transaction", ...}]` of the other side. Never merged here.

- [ ] **Step 1: Write failing tests:** `test_imps_to_own_masked_account_is_transfer` (Federal bank `last4="1244"`, BOI bank `last4="8650"`, debit ₹20,000 payee `"XX650"` → one transfer Federal → BOI; a later BOI credit ₹20,000 links to it), `test_masked_payee_matching_two_accounts_is_not_guessed`, `test_card_bill_bank_first_then_card` and `test_card_bill_card_first_then_bank` (each: one transfer, bank balance down by the amount once, card owed down once), `test_same_ref_merges_into_transfer`, `test_payee_rule_to_rd_records_transfer`, `test_unrelated_equal_amounts_not_merged` (both recorded as expense/income, the second in review `"maybe_transfer"`), `test_card_payment_without_bank_debit_asks_which_account`.
- [ ] **Step 2: Run** `uv run pytest tests/test_sms_transfers.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.** Convert transactions through `save_checks` on the new values (lock both accounts with `lock_accounts`), so the balance rules still hold.
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Turn the two sides of a transfer or card bill into one transfer"`

### Task 5: Expected payments tick themselves off

**Files:**
- Modify: `backend/app/sms/ingest.py`
- Create: `backend/app/sms/expected.py` (candidate finding, pure where it can be)
- Test: `backend/tests/test_sms_expected.py`

**Interfaces:**
- Consumes: `next_emi`/`load_book` (`app/api/loans.py`), `load_due` (`app/api/sips.py`), `status`/`occurrences` (`app/api/recurring.py`), the fund-trade checks in `app/api/routes/fund_trades.py` (`_save_checks`, `_columns`, `sync_trade_nav`; make the two private helpers importable under public names, without behaviour change).
- Produces:
  - `expected_candidates(db, user_id, account, amount, day, payee_key) -> list[Candidate]`, `Candidate = {"kind": "emi" | "sip" | "template", "id": int, "label": str}`. Only for `debit` entries.
    - **EMI:** active loans with `pay_from_id == account.id` and `emi_amount == amount`.
    - **SIP:** active SIPs on `account.id` with `amount == amount` and a due date (from `load_due`) within 3 days of `day`.
    - **Template:** active `expense` or `transfer` templates on `account.id` with amount within ±10% (inclusive) and an open occurrence (due, or coming up within `remind_days`) whose window contains `day`. A `PayeeRule.template_id` for this payee narrows to that template.
  - `apply_expected(db, user_id, entry, candidate) -> bool`: records
    - EMI: `type="emi"`, `to_account_id=loan`, `interest` from `next_emi(...).interest`. If that interest is `None`, nothing is applied (the entry goes to review as below).
    - SIP: fund buy through the fund-trade checks, `sip_id` set, `nav` = the fund's price on `day` or the latest before it (any `InstrumentPrice` row, else its `market_codes` price); `units = (amount / nav)` rounded to 3 places `ROUND_HALF_UP`; `estimated=True`; entry `status="review"`, `reason="sip_units"`, `message="Check the units against your fund statement"`. No NAV available → entry review `"expected"` with the SIP as candidate, nothing recorded.
    - Template: the template's type, category, `to_account_id` and `recurring_template_id`, with the SMS amount.
- Rules inside `ingest` (after transfers, before category):
  - Exactly one candidate and a `PayeeRule` already tying the payee to it (EMI/SIP need no rule: account + exact amount is the evidence) → apply, `"recorded"` (SIP: `"sip_units"` review).
  - Exactly one template candidate with no rule → record as an uncategorised expense, `status="review"`, `reason="expected"`, `message="Is this your <template name>?"`, `candidates=[it]`.
  - Several candidates → record uncategorised, review `"expected"` with all of them. Nothing guessed.

- [ ] **Step 1: Write failing tests:** `test_emi_debit_records_emi_with_interest`, `test_sip_debit_records_estimated_units` (NAV 50.1234 on the day, ₹5000 → units 99.754, `estimated` true, review `"sip_units"`), `test_sip_without_nav_waits_in_review`, `test_rent_first_time_asks`, `test_rent_with_rule_ticks_off_reminder` (`GET /recurring/due` no longer lists the occurrence), `test_rent_amount_outside_ten_percent_not_matched` (₹11,001 vs ₹10,000 → not a candidate; ₹11,000 is), `test_two_candidates_never_guessed`.
- [ ] **Step 2: Run** `uv run pytest tests/test_sms_expected.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Match SMS debits to EMIs, SIPs and recurring reminders"`

### Task 6: CDSL share movements become draft trades

**Files:**
- Modify: `backend/app/sms/ingest.py`
- Test: `backend/tests/test_sms_demat.py`

**Interfaces:**
- Produces: for `kind="demat"` (one entry per share line; the phone sends `hash = <sms hash>:<line index>`, `isin`, `payee` = the security name, `quantity`, `amount=None`, and `ref` = `"debit"` or `"credit"` for the direction — my call: reuse `ref` rather than add a column):
  - Stock lookup: the user's stock whose `source_code` matches the `market_codes` row with that `isin` (kind `"stock"`), else whose name contains the security name (casefold).
  - A manual trade of that stock, same side (`debit`→`sell`, `credit`→`buy`) and quantity, within 2 days → `status="duplicate"`, `trade_id` linked.
  - Else `status="draft"`, `reason="demat"`, `candidates=[{"kind": "stock", "id": <stock id>, "label": symbol}]` when found (empty when not), `message="<Bought|Sold> <qty> <name>"`. Nothing recorded.

- [ ] **Step 1: Write failing tests:** `test_cdsl_line_becomes_draft_with_stock`, `test_cdsl_line_for_new_stock_has_no_candidate`, `test_cdsl_line_matching_manual_trade_is_duplicate`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Turn CDSL share movements into draft trades"`

### Task 7: Review, payee rules, identifiers, samples and the dashboard

**Files:**
- Modify: `backend/app/api/routes/sms.py`, `backend/app/api/routes/dashboard.py`, `backend/app/api/routes/{recurring,fund_trades,trades}.py` (deleting a template clears `PayeeRule.template_id`; deleting a trade marks its entry ignored)
- Create: `backend/app/sms/review.py`
- Test: `backend/tests/test_sms_review.py`, extend `backend/tests/test_dashboard.py`

**Interfaces (produces), all under `/api/sms` unless noted:**
- `GET /review` → `{"items": [ReviewItem]}`, newest first, entries with `status in ("review", "draft")`. `ReviewItem`: `id`, `kind`, `reason`, `message`, `amount: str | None`, `date`, `payee: str | None`, `last4`, `account_id`, `account_name: str | None`, `transaction_id`, `trade_id`, `isin`, `quantity: str | None`, `candidates`.
- `POST /review/{id}` with one body shape per action (a pydantic discriminated union on `action`). Each returns the updated `ReviewItem | None` (None once it leaves the list). Wrong action for the reason → 422 with a field error:
  - `{"action": "category", "category": str, "remember": bool = true}` (reasons `category`, `expected`, `maybe_transfer` when the owner says "not a transfer"): sets the transaction's category through `save_checks`; `remember` upserts `PayeeRule(payee_key, display, category)`; the same uncategorised payee's other open `category` items are categorised too.
  - `{"action": "account", "account_id": int, "remember": bool = true}` (reasons `account`, `card_payment`): `remember` adds `AccountIdentifier(account, last4)`; then the entry is decided again through `ingest`'s steps from "account" on. `card_payment` records `transfer` from the chosen account to the card. Other open `account` items with the same `last4` are re-decided too.
  - `{"action": "same", "transaction_id": int}` (`maybe_duplicate`): link, `"recorded"`.
  - `{"action": "transfer", "transaction_id": int}` (`maybe_transfer`): delete this entry's transaction, turn the other into a transfer between the two accounts (direction from the debit side), link both entries. Balance rules apply.
  - `{"action": "expected", "kind": str, "id": int, "remember": bool = true}` (`expected`): `apply_expected` on the existing transaction (replaces it); `remember` saves `PayeeRule.template_id` for templates.
  - `{"action": "units", "units": str, "nav": str}` (`sip_units`): updates the trade through the fund-trade checks, `estimated=False`. `{"action": "units_ok"}` keeps them and clears `estimated`.
  - `{"action": "trade", "stock_id": int | None, "account_id": int, "price": str, "charges": str = "0", "symbol": str | None, "name": str | None}` (`demat`): with no `stock_id`, creates the stock (symbol + name, linked to the `market_codes` code for that ISIN when there is one), then records the trade through the stock-trade checks; links `trade_id`, `"recorded"`. The draft's suggested price is the stock's `InstrumentPrice` for that date or the latest before it, exposed as `ReviewItem.suggested_price: str | None`; `ReviewItem.broker_accounts` is not needed, the client lists broker accounts itself.
  - `{"action": "dismiss"}`: recorded entries leave the list and keep their transaction (category stays `None`); unrecorded ones become `"ignored"`.
- `GET /api/payee-rules` → `{"rules": [{id, payee_key, display, category, to_account_id, to_account_name, template_id, template_name}]}`; `PATCH /api/payee-rules/{id}` (`category` xor `to_account_id`, `template_id` may be cleared); `DELETE /api/payee-rules/{id}`.
- `GET /api/sms/identifiers` → `{"identifiers": [{id, account_id, account_name, last4}]}`; `DELETE /api/sms/identifiers/{id}`.
- `POST /api/sms/samples` `{sender, text}` (text ≤ 500, re-masked server-side) → 201; `GET /api/sms/samples` → newest 50.
- Dashboard response gains `to_review: int` and `card_bill: {account_id, name, amount: str, due_date: str} | None`: the latest `card_statement` entry per card whose `due_date ≥ today - 3 days`, minus transfers into that card dated after the statement entry's date; shown while that's > 0, earliest due first.

- [ ] **Step 1: Write failing tests**, one per action plus: `test_account_answer_remembered_for_next_sms` (Review Focus 5), `test_category_answer_categorises_same_payee_items`, `test_dismiss_unrecorded_ignores`, `test_wrong_action_for_reason_is_422`, `test_other_users_review_item_is_404`, `test_trade_action_creates_stock_when_missing`, `test_sample_is_remasked`, `test_dashboard_to_review_and_card_bill` (statement ₹12,000 due in 5 days → shown; after a ₹12,000 transfer into the card → `null`), `test_deleting_template_keeps_rule_without_link`.
- [ ] **Step 2: Run** `uv run pytest tests/test_sms_review.py tests/test_dashboard.py -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite, then the PostgreSQL run. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the To review actions, payee rules and card bill due"`

### Task 8: Website: To review, payee rules, dashboard and marks

**Files:**
- Create: `frontend/src/app/(app)/review/page.tsx`, `frontend/src/components/review/review-view.tsx`, `frontend/src/components/review/review-card.tsx`, `frontend/src/app/(app)/payee-rules/page.tsx`, `frontend/src/components/review/payee-rules-view.tsx`, `frontend/src/lib/review.ts`, `frontend/src/lib/review.test.mjs`
- Modify: `frontend/src/components/sidebar.tsx` (📥 "To review" after Dashboard, with the count), `frontend/src/components/dashboard/dashboard-view.tsx` (a To review tile linking to `/review` when `to_review > 0`; "Card bill ₹X due <date>" line), `frontend/src/components/transactions/transactions-view.tsx` ("from SMS" chip; `"Uncategorised"` for a null category), `frontend/src/components/investments/fund-view.tsx` ("estimated" chip on estimated trades — add `estimated: bool` to the `FundTrade` response in Task 7 if not already there), `frontend/package.json` test list

**Interfaces:**
- `lib/review.ts` (pure, tested): `reviewTitle(item) -> string` (by reason: `category` → "New payee", `account` → "Which account?", `maybe_duplicate` → "Already typed in?", `maybe_transfer` → "A transfer?", `expected` → "A regular payment?", `sip_units` → "Check SIP units", `demat` → "Confirm share trade", `card_payment` → "Card bill paid from?", `balance` → "Couldn't record"), `actionsFor(item) -> Action[]` (which buttons a card shows), `trimSampleText`.
- Review page: one card per item in the chunky style, each with its own inline controls (category select with "Always use this for <payee>" ticked by default; account select; candidate buttons; units/NAV fields; trade price/charges/broker fields prefilled from `suggested_price`). Optimistic removal on success; field errors shown inline like the existing dialogs.
- Payee rules page: rules list (edit category or transfer target, delete), "Account numbers" list (delete), "Samples sent from the phone" list (read-only, copy button).

- [ ] **Step 1: Write failing tests** in `review.test.mjs` for `reviewTitle` and `actionsFor` (every reason).
- [ ] **Step 2: Run** `cd frontend && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the lib, pages and changes.
- [ ] **Step 4: Run** lint, tests and `npx tsc --noEmit`. Then run the API and website locally (`npm run dev` at the root; API on 8001, site on 3001), post a few entries to `/api/sms/entries` with curl, and check each review card's action in the browser with Chrome DevTools MCP. Expected: every action clears its card and the dashboard count drops.
- [ ] **Step 5: Commit** `git commit -m "Add To review and payee rules to the website"`

---

## Build 3: the phone

### Task 9: Parsers (pure JS)

**Files:**
- Create: `mobile/src/lib/sms/senders.ts`, `mobile/src/lib/sms/parse.ts`, `mobile/src/lib/sms/mask.ts`, `mobile/src/lib/sms/fixtures.mjs` (sample messages), `mobile/src/lib/sms/parse.test.mjs`
- Modify: `mobile/package.json` (add the test file to `test`)

**Interfaces (produces):**
- `senderBank(address: string) -> string | null`: strips the `XX-` prefix and a `-S/-T/-P` suffix, then looks up the header (`HDFCBK`, `SBIINB`, `SBIUPI`, `ATMSBI`, `CBSSBI`, `ICICIB`, `ICICIT`, `AXISBK`, `KOTAKB`, `BOIIND`, `BOISMS`, `BOBTXN`, `BOBSMS`, `PNBSMS`, `CANBNK`, `UNIONB`, `IDFCFB`, `YESBNK`, `INDUSB`, `FEDBNK`/`FEDFIB` (Federal Bank), and their card senders) → bank key, and `CDSL*`/`NSDL*` → `"cdsl"`/`"nsdl"`. Plain phone numbers → `null`.
- `type Parsed = { kind, amount: string | null, date: string (YYYY-MM-DD), last4, payee, ref, balance, isin, quantity, dueDate }`.
- `parseSms(bank: string, body: string, receivedAt: Date) -> Parsed[] | "unreadable" | "ignore"`: `"ignore"` for OTPs, promotions, balance-only and failed/declined messages; `"unreadable"` for messages that mention debited/credited/spent and an amount but match nothing; CDSL gives one `Parsed` per share line. Bank-specific patterns first, then the general reader (amount after `Rs`/`INR`/`₹`; `debited`/`credited`/`spent`/`withdrawn`; `A/c`/`Acct`/`Card` `XX1234`/`*1234`/`ending 1234`; `to`/`at`/`VPA`/`Info:` payee; `UPI Ref`/`Ref No`/`RRN`; `Avl Bal`/`Avbl Bal`). Card "payment received" → `card_payment`; statement messages ("Total amount due", "Min amt due", "due by") → `card_statement` with `dueDate`. The date is the date in the message when present (formats `DD-MM-YY`, `DD-MM-YYYY`, `DD/MM/YY`, `DDMonYY`, `DD-Mon-YY`), else `receivedAt` in IST. Amounts keep paise and drop commas (`"1,23,456.70"` → `"123456.70"`).
- `maskSample(body: string) -> string`: every run of 3+ digits → `X`s of the same length, amounts included; the text after `to`/`from`/`at`/`VPA` up to the next separator → `<name>`.

**Real samples from the owner (2026-11-12)**, the first fixtures. Commit them with the reference numbers and account digits replaced by fake ones of the same length; keep everything else byte for byte:
- Bank of India, sender `BOIIND`: `Rs.243.00 debited A/cXX8650 and credited to Blinkit via UPI Ref No 631529109575 on 11Nov26. Call 18001031906, if not done by you. -BOI` → `{kind: "debit", amount: "243.00", last4: "8650", payee: "Blinkit", ref: "631529109575", date: "2026-11-11"}`.
- Federal Bank, sender `FEDBNK`: `Debited Rs 20000.00 from a/c X1244 on 11Nov26 11:09 via IMPS to XX650.Ref 631511813041. Bal Rs 38857.54. Not you?Call 18004251199 -Federal Bank` → `{kind: "debit", amount: "20000.00", last4: "1244", payee: "XX650", ref: "631511813041", balance: "38857.54", date: "2026-11-11"}`. Note `last4` comes from a single-`X` mask, and the payee is a masked account number (Task 4 treats it as a transfer to the owner's own account).
- Helpline numbers (`18001031906`) must never be read as amounts or refs.

Fixtures: also write at least two realistic messages per bank listed in the spec (UPI debit, credit, card spend, card payment received, statement where the bank issues cards), three CDSL messages (one with two share lines), three NSDL-style, and ten that must be `"ignore"` (OTP, promo, declined, balance alert, loan offer). Base them on publicly documented formats; mark them `// format from public examples, not yet checked against a real SMS`. When the owner sends masked samples, they go in as extra fixtures.

- [ ] **Step 1: Write failing tests:** `test_owner_boi_upi_debit` and `test_owner_federal_imps_debit` (the two real samples above, exact fields), a table test over every fixture (expected kind, amount, last4, payee, ref, date), `test_ignores_otp_and_promotions`, `test_unknown_format_is_unreadable`, `test_amount_keeps_paise_and_drops_commas`, `test_cdsl_two_lines`, `test_sender_prefix_and_suffix_stripped`, `test_personal_number_sender_is_null`, `test_mask_hides_digits_and_names`.
- [ ] **Step 2: Run** `cd mobile && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** tests, lint and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Parse bank, card and CDSL SMS on the phone"`

### Task 10: Native SMS reader and the sync loop

**Files:**
- Create: `mobile/modules/sms-inbox/` (local Expo module: `expo-module.config.json`, `android/build.gradle`, `android/src/main/java/expo/modules/smsinbox/SmsInboxModule.kt`, `index.ts`), `mobile/src/lib/sms/sync.ts`, `mobile/src/lib/sms/settings.ts`, `mobile/src/lib/sms/sync.test.mjs`, `mobile/src/lib/sms/use-sms-sync.ts`
- Modify: `mobile/app.json` (`android.permission.READ_SMS`), `mobile/package.json` (`expo-crypto` via `npx expo install expo-crypto`), `mobile/src/app/(tabs)/_layout.tsx` (mount `useSmsSync`)

**Interfaces (produces):**
- Native: `readInbox(sinceMillis: number, limit: number): Promise<{ id: string; address: string; body: string; date: number }[]>`, newest first, from `content://sms/inbox` with `date > sinceMillis`; rejects when `READ_SMS` isn't granted. Read the Expo SDK 58 "Expo Modules API" docs (`https://docs.expo.dev/versions/v58.0.0/` and the modules guide) before writing it; use `requireOptionalNativeModule("SmsInbox")` in `index.ts` so the JS works without it, and export `isAvailable(): boolean`.
- `settings.ts` (expo-secure-store, one JSON key `sms-settings`): `{ enabled: boolean, startDate: string, lastReadAt: number, unreadable: { id, address, body, date }[] (max 50, phone only) }` with `loadSmsSettings()`, `saveSmsSettings(patch)`.
- `sync.ts` (pure core tested with fakes): `syncSms({ read, post, hash, settings, now }) -> { sent: number, unreadable: number, banks: string[] }`. Reads since `max(lastReadAt, startDate midnight IST)`, keeps known senders only (bodies of other messages are never touched), parses, hashes `sha256(address + "\n" + date + "\n" + body)` (CDSL lines append `:<index>`), posts in batches of 50 to `/sms/entries`, and advances `lastReadAt` only past messages whose batch succeeded. Unreadable ones are added to `settings.unreadable`, deduped by id.
- `useSmsSync()`: when enabled and the module is available, runs `syncSms` on mount and whenever `AppState` turns `active`, at most once per 30 s, never two at once; failures are silent (logged in dev) and retried next time.

- [ ] **Step 1: Write failing tests** in `sync.test.mjs`: `test_only_known_senders_are_parsed` (the fake read returns a personal message; `parseSms` is never called for it), `test_last_read_advances_only_after_success` (post fails on batch 2 → `lastReadAt` stops at batch 1's newest), `test_start_date_bounds_first_run`, `test_unreadable_kept_on_phone_and_not_posted`, `test_cdsl_lines_get_indexed_hashes`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the module and the JS.
- [ ] **Step 4: Run** tests, lint and typecheck. Then `npx expo prebuild --platform android --no-install --clean` in a scratch copy (or `npx expo config --type introspect`) to check the module and permission are picked up, and delete any generated `android/` folder. Expected: `READ_SMS` in the merged manifest, module listed in autolinking (`npx expo-modules-autolinking resolve --platform android`). The Kotlin can't be compiled or run without an APK build; it goes on the pending device-check list.
- [ ] **Step 5: Commit** `git commit -m "Read bank SMS on the phone and send the parsed fields"`

### Task 11: App screens

**Files:**
- Create: `mobile/src/app/sms-settings.tsx`, `mobile/src/app/sms-unreadable.tsx`, `mobile/src/app/review.tsx`, `mobile/src/app/review-item.tsx`, `mobile/src/app/payee-rules.tsx`, `mobile/src/lib/review.ts`, `mobile/src/lib/review.test.mjs`
- Modify: `mobile/src/components/profile-view.tsx` and `mobile/src/app/(tabs)/profile.tsx` (rows "Bank SMS", "Payee rules"), `mobile/src/components/dashboard-view.tsx` (To review tile with count; card bill line), `mobile/src/components/transactions-list.tsx` ("SMS" chip; "Uncategorised"), fund screen ("estimated" chip), `mobile/package.json` test list

**Interfaces:**
- `lib/review.ts`: same reasons as the website, written for the app (`reviewTitle`, `actionsFor`), tested.
- `sms-settings.tsx`: the switch "Fill in transactions from bank SMS" with the spec's explanation (what is read, that raw text stays on the phone), Android permission request via `PermissionsAndroid.request(READ_SMS)` when switched on (denied → switch stays off with a sentence why), the start date (`DateField`, today by default, no earlier than 90 days ago), banks found, last read time, a "Read now" button, and a row to "Couldn't read (N)". Without the native module: the switch is disabled with "Needs the latest app version".
- `sms-unreadable.tsx`: list of the phone-only unreadable messages, each with Copy and "Send sample" (shows the masked text first in a confirm dialog; on confirm posts `/sms/samples` and removes it from the list).
- `review.tsx` + `review-item.tsx`: Material-style list → detail screen per item with the same actions as the website, in native controls (chips for categories, radio list for accounts and candidates, numeric fields for units/price).
- `payee-rules.tsx`: rules with delete and category change, account numbers with delete.

- [ ] **Step 1: Write failing tests** in `review.test.mjs` for every reason.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the screens.
- [ ] **Step 4: Run** tests, lint and typecheck. Expected: PASS. (Device checks wait for the deferred install; add them to the pending list.)
- [ ] **Step 5: Commit** `git commit -m "Add Bank SMS, To review and payee rules to the app"`

### Task 12: Docs and hand-off

**Files:**
- Modify: `README.md` (an "SMS" section: what's read, where the parsers are, how to add a bank from a sample), `docs/architecture/ledger-design.md` (the `source="sms"` and uncategorised rule), the spec's status line ("Builds 2 and 3 implemented")

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** every check in Global Constraints. Expected: PASS.
- [ ] **Step 3: Commit** `git commit -m "Document SMS transactions"`, push the branch and open a PR whose first line says the migration must be run on Neon before merging.
