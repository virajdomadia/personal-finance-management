# Ledger design

**Status (2026-11-08, revision 2):** the direction is approved. This revision answers the first design review: how assets and holdings map to ledger accounts, posting versions and reversals, ownership enforced by the database, category merges, the opening-date rule, and the invariants. **The migration is not approved yet.** It waits for the PostgreSQL integration tests and the reconciliation tooling. Decision record: [ADR-002](../decisions/ADR-002-double-entry-ledger.md).

## Why change what works

Today's engine (`backend/app/api/balances.py`) is correct for what it covers. The invariant tests in `backend/tests/test_ledger_invariants.py` confirm it. It has four limits:

1. **History is rewritten.** Edits overwrite the row, deletes remove it, and a balance correction moves the opening balance. Nothing records what changed.
2. **Only two sides.** Investment purchases, loan EMIs (principal and interest) and refunds linked to a purchase need more legs or a link.
3. **Categories are loose text.** They can't be renamed, merged, nested or budgeted reliably.
4. **No opening date.** A balance on a past date isn't defined.

The existing engine stays the source of truth until the ledger has reconciled against it (see [migration](#migration)).

## Decisions taken

| Question | Decision |
|---|---|
| Delete | **Void.** The transaction is reversed and hidden, and its history is kept. Private text can be redacted. Physical purge happens only as part of deleting the user's whole data. |
| Balance correction | **A dated adjustment transaction.** The opening balance is never rewritten to make a figure come out. |
| Refunds | **Linked to the original expense** where possible, reducing that category's spending. An unlinked refund names an expense category explicitly. |
| Categories | **Managed**: rename, archive, merge, one level of nesting. A historical line always keeps its original category. |
| Investment acquisition fees | **Proposed: included in cost basis.** This is a reporting choice, based on our understanding of how Indian capital gains are computed. It needs confirming against current tax rules by a qualified professional before the investments domain is built, and the app makes no tax-compliance claim from it. |

## Concepts

- **Transaction:** the business event the owner sees, such as "Groceries ₹2,000 on 3 Nov". It has a header (type, date, note, status, version) that can change.
- **Posting:** one immutable, balanced set of journal lines that records a transaction's financial effect at one version. It is either an `original` posting or a `reversal` of exactly one earlier original posting.
- **Journal line:** one amount on one ledger account. It never changes.
- **Ledger account:** something money can sit in, come from or go to. Each one is backed by exactly one entity through a typed foreign key.
- **Change:** one audited operation on a transaction, such as create, edit, void, redact or migrate. Every posting is written by exactly one change, and all postings in one change share its timestamp.

## Sign convention

`amount_paise` is a `BIGINT`, positive for a debit and negative for a credit. Rupees and paise are converted only in `app/shared/money.py` ([ADR-003](../decisions/ADR-003-money-representation.md)).

| Ledger account kind | Shown balance |
|---|---|
| Asset | Σ lines |
| Liability (amount owed) | −Σ lines |
| Expense (spending) | Σ lines |
| Income | −Σ lines |
| Equity | −Σ lines |

## Ledger accounts and what backs them

Each ledger account has exactly one backing entity, referenced by its own nullable, typed foreign key. There is no `entity_type`/`entity_id` pair.

| Backed by | Kind | Exists |
|---|---|---|
| `accounts` row: bank, cash, wallet, broker cash, deposit | asset | Now (deposit later) |
| `accounts` row: credit card, loan | liability | Now (loan later) |
| `categories` row | income or expense, matching the category | With the ledger |
| System role: `opening_balances`, `adjustments` | equity | With the ledger |
| `holdings` row (one broker account × one instrument) | asset | Investments milestone |
| `assets` row (a possession: vehicle, property, jewellery) | asset | Assets milestone |
| System role: `realised_gains` | income | Investments milestone |

A later domain adds its backing column, its foreign key and a new term in the "exactly one" check, in its own migration. **No future domain tables are created now.**

How the later domains post. These are designs, not built:

| Event | Lines |
|---|---|
| Buy 10 MF units at ₹1,000 + ₹100 fee, from bank | Holding +10,100 · Bank −10,100 |
| Sell lots that cost ₹5,050, for ₹6,000 net | Bank +6,000 · Holding −5,050 · Income:Realised gains −950 |
| Dividend ₹200 | Bank +200 · Income:Dividends −200 |
| Buy a car for ₹8,00,000 (100% owned) | Asset:Car +8,00,000 · Bank −8,00,000 |
| EMI ₹12,000 = ₹9,000 principal + ₹3,000 interest | Loan +9,000 · Expense:Loan interest +3,000 · Bank −12,000 |

The ledger carries holdings and possessions at **cost**. Market value is never posted. It lives in append-only valuation tables (`instrument_prices`, `asset_valuations`), and net worth reads it from there. So the investments domain's cost basis is the holding's ledger balance. `check-ledger` verifies that each holding's ledger balance equals the cost basis of its open lots.

**Stocks and mutual funds (built before the ledger):** holdings still map to ledger accounts at cost when the ledger arrives. Whether realised gains become an income account is settled then. Until then they are not income. See the [stocks design](../superpowers/specs/2026-11-08-stocks-design.md) and the [mutual funds design](../superpowers/specs/2026-11-09-mutual-funds-design.md). A fund purchase or redemption moves a bank account by its `amount`, like a stock trade through a broker.

## Schema

PostgreSQL. Only the ledger and the categories are created in the migration. The `accounts` changes are additive.

```sql
-- accounts: additive changes
ALTER TABLE accounts ADD UNIQUE (id, user_id);
ALTER TABLE accounts ADD COLUMN ledger_kind text GENERATED ALWAYS AS
  (CASE WHEN type IN ('credit_card', 'loan') THEN 'liability' ELSE 'asset' END) STORED;
ALTER TABLE accounts ADD UNIQUE (id, user_id, ledger_kind);   -- type never changes after creation
ALTER TABLE accounts ADD COLUMN opening_date date;            -- see "Opening balances"
ALTER TABLE accounts ADD COLUMN opening_date_source text CHECK (opening_date_source IN ('entered', 'migrated'));
ALTER TABLE accounts ADD COLUMN currency char(3) NOT NULL DEFAULT 'INR';

CREATE TABLE categories (
  id             bigint PRIMARY KEY,
  user_id        bigint NOT NULL REFERENCES users,
  kind           text NOT NULL CHECK (kind IN ('income', 'expense')),
  name           text NOT NULL,
  parent_id      bigint,
  merged_into_id bigint,
  archived_at    timestamptz,
  UNIQUE (id, user_id, kind),
  FOREIGN KEY (parent_id, user_id, kind)      REFERENCES categories (id, user_id, kind),
  FOREIGN KEY (merged_into_id, user_id, kind) REFERENCES categories (id, user_id, kind),
  CHECK (merged_into_id <> id), CHECK (parent_id <> id)
);
CREATE UNIQUE INDEX ON categories (user_id, kind, lower(name)) WHERE merged_into_id IS NULL;

CREATE TABLE ledger_accounts (
  id          bigint PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users,
  kind        text NOT NULL CHECK (kind IN ('asset', 'liability', 'income', 'expense', 'equity')),
  account_id  bigint UNIQUE,
  category_id bigint UNIQUE,
  system_role text CHECK (system_role IN ('opening_balances', 'adjustments')),
  UNIQUE (id, user_id),
  UNIQUE (user_id, system_role),
  FOREIGN KEY (account_id, user_id, kind)  REFERENCES accounts (id, user_id, ledger_kind),
  FOREIGN KEY (category_id, user_id, kind) REFERENCES categories (id, user_id, kind),
  CHECK (num_nonnulls(account_id, category_id, system_role) = 1),
  CHECK (system_role IS NULL OR kind = 'equity')
);

-- transactions: the existing table becomes the header
--   + version int NOT NULL, status ('posted' | 'voided'), refund_of_id, category_id
--   + UNIQUE (id, user_id)
--   account_id, to_account_id, amount and category stay until the old engine is retired

CREATE TABLE transaction_changes (
  id             bigint PRIMARY KEY,
  user_id        bigint NOT NULL,
  transaction_id bigint NOT NULL,
  version        int NOT NULL,                     -- the transaction's version after this change
  action         text NOT NULL CHECK (action IN ('create', 'edit', 'void', 'redact', 'migrate')),
  actor_user_id  bigint NOT NULL REFERENCES users,  -- the owner today; an admin or a script later
  at             timestamptz NOT NULL DEFAULT now(),
  fields_changed text[] NOT NULL,                  -- e.g. {amount, account_id}; {note} carries no text
  before         jsonb,                            -- financial fields only, never the note's text
  after          jsonb,
  UNIQUE (transaction_id, version),
  UNIQUE (id, user_id, transaction_id),
  FOREIGN KEY (transaction_id, user_id) REFERENCES transactions (id, user_id)
);

CREATE TABLE postings (
  id             bigint PRIMARY KEY,
  user_id        bigint NOT NULL,
  transaction_id bigint NOT NULL,
  change_id      bigint NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('original', 'reversal')),
  reverses_id    bigint UNIQUE,                    -- a posting is reversed at most once
  effective_date date NOT NULL,
  recorded_at    timestamptz NOT NULL,             -- = the change's `at`
  UNIQUE (id, user_id),
  UNIQUE (id, transaction_id, effective_date, kind),
  FOREIGN KEY (transaction_id, user_id) REFERENCES transactions (id, user_id),
  FOREIGN KEY (change_id, user_id, transaction_id) REFERENCES transaction_changes (id, user_id, transaction_id),
  -- a reversal belongs to the same transaction, keeps the original's date, and reverses an original
  reversed_kind  text GENERATED ALWAYS AS (CASE WHEN reverses_id IS NULL THEN NULL ELSE 'original' END) STORED,
  FOREIGN KEY (reverses_id, transaction_id, effective_date, reversed_kind)
    REFERENCES postings (id, transaction_id, effective_date, kind),
  CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL))
);

CREATE TABLE journal_lines (
  id                bigint PRIMARY KEY,
  user_id           bigint NOT NULL,
  posting_id        bigint NOT NULL,
  ledger_account_id bigint NOT NULL,
  amount_paise      bigint NOT NULL CHECK (amount_paise <> 0),
  reverses_line_id  bigint UNIQUE,                 -- a line is reversed at most once
  negated_paise     bigint GENERATED ALWAYS AS (-amount_paise) STORED,
  UNIQUE (id, ledger_account_id, amount_paise),
  FOREIGN KEY (posting_id, user_id)        REFERENCES postings (id, user_id),
  FOREIGN KEY (ledger_account_id, user_id) REFERENCES ledger_accounts (id, user_id),
  -- a reversal line hits the same ledger account with the opposite amount
  FOREIGN KEY (reverses_line_id, ledger_account_id, negated_paise)
    REFERENCES journal_lines (id, ledger_account_id, amount_paise)
);
CREATE INDEX ON journal_lines (ledger_account_id);
CREATE INDEX ON postings (user_id, effective_date);
```

The tables, keys and checks above were tried on PostgreSQL 18 in a throwaway database on 2026-11-08, but not the triggers yet. Each of these was rejected:

- a card backing an asset ledger account
- an income category backing an expense ledger account
- a ledger account backed by another user's account
- a ledger account with two backings
- a journal line on another user's ledger account
- a posting reversed twice
- a reversal with a different date
- a reversal of a reversal
- a reversal of another transaction's posting
- a reversal line with the wrong amount, or on the wrong ledger account
- a line reversed twice
- a duplicate active category name in different case
- a merge across income and expense

A correct reversal, a valid merge, and reusing a merged category's name were accepted. The triggers are specified below and get their own tests with the PostgreSQL suite.

What the database enforces on its own:

- **Ownership.** Every journal line, posting and change carries `user_id`, and composite foreign keys tie it to a transaction and a ledger account of the same user. A ledger account can only be backed by the same user's account or category. Cross-user references are impossible, not just unchecked.
- **Backing.** Each ledger account has exactly one backing entity, of the right kind. An income category can't back an expense ledger account, and a card can't back an asset ledger account.
- **Reversals.**
  - A posting is reversed at most once.
  - A reversal reverses an original, never another reversal.
  - A reversal belongs to the same transaction and keeps the original's effective date.
  - Each reversal line hits the same ledger account as the line it reverses, with the opposite amount, and a line is reversed at most once.
- **Immutability.** `BEFORE UPDATE OR DELETE` triggers on `postings` and `journal_lines` raise an error. They are triggers rather than grants because Neon's application role owns its tables, and an owner bypasses grants. The only exception is the whole-user data deletion procedure, which sets `app.purging_user = <id>` for its own transaction.
- **One operation, one timestamp.** A posting must be written by a change made in the same database transaction. Lines can only be added to a posting in the operation that wrote it.
- **The header.** A transaction's owner and type never change, and every update raises its version by exactly one.
- **Balance and completeness, checked at commit.** `DEFERRABLE INITIALLY DEFERRED` constraint triggers on new postings and on header inserts and updates check:
  - Its lines sum to 0 and there is at least one line.
  - A reversal has exactly as many lines as its original, each reversing a line of that original.
  - The transaction is consistent: `posted` with exactly one unreversed original posting, or `voided` with none.
  - A posted transaction's date matches its active posting's date, and its amount matches what that posting moves.
  - There is a change record for the transaction's current version.

## Operations

Each operation runs in one database transaction. It locks the affected accounts in id order (as today), writes one `transaction_changes` row, and writes its postings with `recorded_at` set to that change's `at`. PostgreSQL's `now()` is fixed for the whole database transaction, so every line written by one operation shares one timestamp.

| Operation | Change | Postings |
|---|---|---|
| Create | `create`, version 1 | One original |
| Edit amount, account, category or date | `edit`, version + 1 | The reversal of the active original, then a new original |
| Edit only the note | `edit`, version + 1, `fields_changed = {note}` | None |
| Void ("delete" in the UI) | `void`, version + 1, status → `voided` | The reversal of the active original |
| Redact | `redact`, version + 1 | None. The header's note is set to null |
| Backfill | `migrate`, version 1 | One original |

**Redaction.** Personal free text, which today is just the note, lives only on the transaction header. The audit trail records *that* a note changed, never its text. Redacting a note removes it everywhere it exists. The amounts, accounts, dates and categories needed for audit stay.

### Transaction types and their lines

| Type | Lines |
|---|---|
| `opening` | Account ±balance · Equity:Opening balances ∓balance. Dated `opening_date`. One per account. |
| `income` | Account +x · Income:category −x |
| `expense` | Expense:category +x · Account −x |
| `transfer` | To-account +x · From-account −x |
| `refund` | Account +x · Expense:category −x. Linked through `refund_of_id` to an expense, whose category it uses. The linked refunds' total can't exceed the expense. |
| `adjustment` | Account ±d · Equity:Adjustments ∓d, where d = entered balance − ledger balance. Dated the day it's entered. |

For a liability, "Account +x" lowers what's owed, following the sign convention. Lines are built in one function, `postings_for(header) -> list[Line]`. The REST API keeps its current shape, and `refund` and `adjustment` are additions.

## Categories

- **Rename** changes `name`. The identity, and every historical line, stay.
- **Archive** hides the category from the pickers for new transactions. History and reports still show it. An existing transaction can keep its archived category when edited, but can't be moved to one.
- **Merge A into B** sets `A.merged_into_id = B`. Merge chains are not allowed: B must not be merged itself, and anything already merged into A is re-pointed to B in the same operation. Journal lines keep A's ledger account.
  - **Reports** group by each line's canonical category: follow `merged_into_id` one step. So A's history counts under B, and the report can still show "includes merged: A".
  - A merged category can't be picked for new transactions.
  - **Unmerge** is an explicit operation that clears `merged_into_id`.
  - Merges and unmerges are recorded in a `category_changes` audit table (actor, at, action, from, to).
- **Nesting.** One level: a parent and its children. Parent totals include the children's.
- **Seeding.** Each user gets the current default list as rows. Free-text categories already in use are backfilled as rows, with case-insensitive duplicates collapsed using the existing "known spelling" rule.

**Built before the ledger (Phase 2, branch `cash-flow`).** The `categories` table exists with this shape plus `name_key` (the case-folded name the partial unique index uses, because a functional index can't be compared by `alembic check`), `icon`, `colour`, `created_at` and `updated_at`. Until the ledger, transactions, templates and payee rules keep their `category` **name**, and the table is the registry of those names. Because the merge can't leave history on the old category without journal lines, a merge today **moves** every reference to the target and marks the old row merged; unmerge and the `category_changes` audit table come with the ledger. The ledger migration adds `category_id` by joining on `(user_id, kind, name_key)` among live categories, which is unique. See the [cash flow design](../superpowers/specs/2026-11-12-cash-flow-design.md).

## Transactions from SMS

Transactions the phone reads from bank SMS have `source="sms"`. They are ordinary transactions with the same lines as any other.

- **The one exception to "income and expenses have a category".** An SMS expense or income may have no category yet. Summaries show it as "Uncategorised". Nothing else may omit a category, and the transaction gets one when the owner answers in To review (editing it while it is still uncategorised is allowed too).
- **Record straight away, ask only for the missing piece.** When the account and amount are known the transaction is recorded at once, so balances match the bank. To review asks only for what is missing: a category, an account for an unknown last 4, or a confirmation. If the account is unknown nothing is recorded yet.
- **Never counting twice.** Checked in this order:
  1. The same SMS hash for the same user is ignored.
  2. The same reference number already recorded for that account is ignored.
  3. A manual transaction in the same account with the same amount and type within one day, not already linked to an SMS: if exactly one, the SMS links to it and nothing new is created; if several, To review asks "Is this one of these?".
  4. The two sides of a transfer (a debit in one account and a credit of the same amount in another within 3 days) merge into one transfer only with evidence: a card "payment received" SMS, the same reference on both sides, or a payee rule pointing at the other account. Otherwise both are recorded and To review asks.
- Deleting a transaction that came from an SMS marks that SMS ignored, so it is not brought back.

## Opening balances

An account's opening balance is the balance the owner entered when creating it, valid at `opening_date`.

**New accounts.** The form asks for "Balance on" with today as the default, and stores `opening_date_source = 'entered'`. A transaction dated before an account's opening date is refused with the message "This is before {account}'s opening date of {date}." Changing the opening balance or date in the account form is an `edit` of the `opening` transaction, so it is reversed and reposted with an audit row. It is never an in-place change.

**Existing accounts (migration).** The entered balance was the balance when the account was created. So the migration sets `opening_date` to the account's creation date in India, with `opening_date_source = 'migrated'`. The original values (opening balance, creation timestamp, earliest transaction date) go into the `migrate` change record. Today's balances are unaffected because the opening posting and every transaction are still all counted.

**Pre-opening transactions** are those dated before an account's creation date. The migration does not resolve them silently. The reconciliation report lists them per account, because they are genuinely ambiguous. Take ₹20,000 entered on 1 Nov and an expense dated 25 Oct. Either the ₹20,000 already reflected that expense, which would make the current balance wrong, or it didn't, and the opening date should be 25 Oct. The owner picks one per account:

- **(a) Opening was before them:** move `opening_date` back to the earliest transaction's date. Balances don't change.
- **(b) Opening already included them:** keep the date and void, or adjust for, the duplicates. The current balance changes, and is shown before it is confirmed.

Until an account is resolved, its balances before `opening_date` are reported as unknown rather than computed.

## Reading balances

```
balance(a, on D)                = Σ lines of a, in postings with effective_date ≤ D
balance(a, on D, as known at T) = Σ lines of a, in postings with effective_date ≤ D and recorded_at ≤ T
```

Both are kept. The first answers "what was my balance on 1 March?" with everything known now. The second reproduces what the app showed at time T. Net worth snapshots record that view, so a correction made today never rewrites a past snapshot.

## Net worth

Net worth is computed only from asset and liability ledger accounts. Income, expense and equity accounts are never added in. They explain *changes* in net worth, but they are not part of it.

```
net worth (on D) = Σ value(asset accounts, D) − Σ owed(liability accounts, D)

value(money account)   = its ledger balance
value(holding)         = units held on D × latest recorded price on or before D
                         (cost basis only if no price has ever been recorded on or before D)
value(possession)      = latest valuation on or before D × ownership share
                         (cost only if no valuation has ever been recorded on or before D)
owed(liability)        = −Σ its lines
```

**A recorded valuation always wins over cost.** The ledger records acquisitions and disposals at cost. The valuation layer supplies the balance-sheet value. For example, a holding with a cost basis of ₹1,00,000 and a latest valuation of ₹1,20,000 contributes ₹1,20,000 to net worth, never ₹1,00,000. Cost is used only as a placeholder before the first valuation, and the UI labels that figure "at cost". The investments and assets designs must include tests for both cases.

**Book net worth** uses ledger balances only, with holdings and possessions at cost. The accounting identity requires it to equal minus the sum of the equity, income and expense lines. `check-ledger` uses that identity as an independent reconciliation. Until the investments and assets milestones, market and book net worth are the same.

## Invariants and `check-ledger`

The database constraints above prevent most corruption. `uv run python -m app.cli check-ledger [--user ID]` re-verifies everything independently and exits non-zero on any finding. It runs after every migration, daily in production during dual-write, and in the PostgreSQL test suite.

| # | Check |
|---|---|
| 1 | Every posting's lines sum to 0, and every posting has at least one line. |
| 2 | Every reversal reverses an existing original of the same transaction, line for line: same ledger accounts, opposite amounts, same line count. No posting or line is reversed twice. |
| 3 | Every `posted` transaction has exactly one unreversed original posting. Every `voided` one has none. There are no postings without a change, and no changes that should have written postings but didn't. |
| 4 | Every transaction's active posting equals `postings_for(header)`. This catches a header and its lines drifting apart. |
| 5 | Every row's `user_id` matches across transaction, change, posting, line and ledger account. This is a backstop for the composite keys. |
| 6 | Each account's balance from the ledger equals its balance from the current engine (during migration), and equals the balance shown by the API. |
| 7 | Book net worth from asset and liability accounts equals minus the sum of equity, income and expense lines. |
| 8 | Every `recorded_at` equals its change's `at`. Every reversal's effective date equals its original's. |
| 9 | Later: every holding's ledger balance equals its open lots' cost basis. |

## Migration

Each step is its own commit and deploy, and the migration can stop at any step. Nothing is dropped until the last step.

0. **Prerequisite: PostgreSQL integration tests.** Run the backend suite against a disposable PostgreSQL database as well as SQLite. Cover row locking under concurrent writes, constraint and trigger behaviour, and the existing invariant tests. *Done on branch `step0-postgres-tests`; results and limitations are in [testing](testing.md). The schema and triggers in `backend/tests/sql/ledger_prototype.sql` are the tested form of this design.*
1. **Schema.** Add the `accounts` columns and the new tables, constraints and triggers. Behaviour doesn't change.
2. **Backfill** with `backfill-ledger`, which is **idempotent**. It writes per user in one transaction, and skips any user, account or transaction that already has its rows, keyed on the unique constraints. Then run `reconcile-ledger`, which reports per account the old and new balances, net worth, transaction counts, pre-opening transactions and any `check-ledger` findings.
3. **Dual-write.** Every write updates both the old columns and the ledger, in the same database transaction. The test suite runs every scenario through both engines and asserts that all balances and net worth agree. `reconcile-ledger` runs daily in production.
4. **The owner resolves** each account's pre-opening transactions, choosing (a) or (b).
5. **Switch reads** to the ledger once `reconcile-ledger` has been clean for 7 consecutive days of real use. The old engine keeps being written and compared.
6. **New behaviour:** void, adjustments, linked refunds, managed categories and the edit history view.
7. **Retire** the old columns and `balances.py`.
