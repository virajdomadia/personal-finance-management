# ADR-002: Double-entry ledger under the transactions API

**Status:**
- **Direction accepted** (2026-11-08): double-entry, immutable journal lines, reversals instead of edits, dated adjustments, historical reconstruction.
- **Schema in review:** revision 2 of the [ledger design](../architecture/ledger-design.md).
- **Migration not approved:** it waits for the PostgreSQL integration tests and the reconciliation tooling.

## Context

Balances are computed from each account's opening balance plus single-row transactions. That is correct today, but edits and deletes overwrite history, and later features need transactions with more than two legs, such as investment purchases and loan EMIs split into principal and interest.

## Decision

- Every transaction is recorded as immutable, balanced **postings** of journal lines against **ledger accounts**.
- Each ledger account is backed by exactly one entity, through a typed foreign key: an account, a category, a system equity role, and later a holding or a possession.
- Edits and voids add reversal postings that are linked to what they reverse.
- Ownership, backing and reversal pairing are enforced by composite foreign keys and triggers, not only in application code.
- The REST API keeps its shape, and the ledger is derived from it.
- The current engine stays the source of truth until the ledger has reconciled against it.

## Consequences

- Any past balance can be reconstructed, either as known now or as known at an earlier time, and every change is audited.
- Investments, possessions and loans plug in by adding a backing column, without redesigning the schema.
- Edits write extra rows (a reversal plus a replacement), and there is a period of dual-writing.
- "Delete" becomes void in the data. Private notes can still be redacted.
