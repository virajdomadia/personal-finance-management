# ADR-003: Money representation

**Status:** Proposed (2026-11-08).

## Context

Money is `NUMERIC(14, 2)` in PostgreSQL and `Decimal` in Python. That is exact. But the backend tests run on SQLite, which stores numerics as floats, so the code sums in Python and SQL-side sums go untested.

## Decision

- Ledger journal lines store **integer paise** in a `BIGINT`. Integer sums are exact in every database, so totals and balances can move into SQL.
- Existing user-entered fields (`opening_balance`, `credit_limit`, and transaction amounts until they're dropped) stay `NUMERIC(14, 2)`.
- The API keeps sending money as two-decimal strings. Conversion between rupees and paise happens only in `app/shared/money.py`.
- Floats are never used for money, in any layer.
- Every money record is INR for now, and a currency column is added with the ledger so that this assumption is explicit.

## Consequences

Converting at a single point keeps the risk of mixing up rupees and paise small. Amounts below ₹10^12 fit comfortably in a `BIGINT` of paise.
