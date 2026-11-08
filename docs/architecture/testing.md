# Backend testing

The backend suite runs twice: on in-memory SQLite for fast feedback, and on PostgreSQL for everything SQLite can't show (locking, constraints, triggers, migrations). How to run it is in [backend/README.md](../../backend/README.md). CI runs both on every push to `main` and on every pull request.

## How the PostgreSQL run works

- `TEST_DATABASE_URL` must name a database ending in `_test`. Anything else is refused, so a test run can't wipe the development or production database.
- The schema is built by the real Alembic migrations, not `create_all`.
- Ordinary tests run inside a transaction that is rolled back afterwards. The app's own commits become savepoints inside it.
- Tests marked `postgres` use real connections and real commits, then clean up after themselves. On SQLite they're skipped.

## Migration step 0 results (2026-11-08)

| Group | File | What it proves | Result |
|---|---|---|---|
| A. Whole suite on PostgreSQL | all existing tests | Every API, balance and invariant test behaves the same on PostgreSQL. Money stays exact. | 295 of 295 pass on both databases |
| A. Migrations | `test_pg_migrations.py` | The migrations produce exactly the models' schema (`alembic check`), and downgrade to empty and upgrade again cleanly | 2 pass |
| B. Concurrency | `test_pg_concurrency.py` | Simultaneous saves on one account never overspend cash. Opposite transfers don't deadlock. A save waits for the lock and then sees the new balance. Refused saves leave nothing behind. | 7 pass, stable over repeated runs |
| C. Constraints and triggers | `test_pg_ledger_prototype.py` | The [ledger design](ledger-design.md)'s keys, checks and triggers: append-only records, balanced and complete postings, exact reversals, header and posting consistency, ownership, backing rules, categories, the planned `CHECK`s on transaction columns, and the purge exception. Each rejection has a matching accepted case. | 44 pass |
| D. Atomicity | both of the files above | A crash part-way through an operation, an unbalanced commit, or a failed edit leaves no partial records. Today's engine rolls back an edit that reached the database but never committed. | Included above |

Total: 348 tests on PostgreSQL, and 295 on SQLite (53 skipped).

### The tests can fail

Each protection was broken on purpose to confirm a test catches it:

| Broken on purpose | Caught by |
|---|---|
| Transfers not crediting the destination (earlier, in `balances.py`) | 4 ledger invariant tests |
| Account row locks removed (`with_for_update`) | 3 concurrency tests: overspending cash, overspending a transfer source, waiting for the lock |
| The posting balance check | Unbalanced posting, failed edit |
| The exact-reversal check | Reversing another transaction's lines |
| The header date check | Date drifting from its posting |
| The version-by-one guard | Version skipping |
| The closed-posting guard | Adding lines to an earlier posting |

One mutation survived: a per-line commit-time check. It turned out to be redundant, because lines can only be added to a posting in the operation that wrote it, so the posting's own check already sees every line. It was removed from the prototype, and the ledger design was updated to match.

## Known limitations

- **The ledger is a prototype.** Groups C and D run against `backend/tests/sql/ledger_prototype.sql` in a throwaway schema, with minimal stand-ins for `users`, `accounts` and `transactions`. That proves the design's enforcement, not the production migration. Step 1 turns this SQL into Alembic migrations, and these tests then run against the real tables.
- **Some races are probabilistic.** The overspending tests start 8 saves at the same moment and catch a missing lock reliably on this machine. "Two competing saves" and "simultaneous edits and deletes" didn't fail with the locks removed, because a race between two threads rarely lines up. The deterministic lock-wait test is the guarantee that doesn't depend on timing.
- **Deadlock coverage is for two accounts.** Opposite transfers between one pair of accounts are tested. Wider cycles also rely on the id-ordered locking, but aren't tested separately.
- **Single database server.** Neon's connection pooler (PgBouncer in transaction mode) isn't in the loop. Row locks and deferred triggers work within one transaction, which transaction pooling preserves, but this isn't tested against Neon itself.
- **Timing source.** The prototype ties every row an operation writes to PostgreSQL's transaction timestamp, `now()`. Two operations in the same microsecond can't be told apart by `recorded_at`. Ordering uses ids.
