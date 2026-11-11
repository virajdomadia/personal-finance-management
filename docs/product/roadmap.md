# Roadmap

One developer. Each milestone ends with an exit check, and scope can change after each one. Every feature ships on the backend first, then on the website (tested on production), then on the Android app against the deployed API.

## Milestone 0: Stabilise the foundation

**Status: nearly done.**

- [x] Custom select on the website, replacing native dropdowns
- [x] Accounts and transactions on the backend, website and app
- [x] Lint, type checks and tests pass for all three parts (295 backend, 64 web, 42 app as of 2026-11-08)
- [x] Ledger invariant tests: transfers keep net worth, edits and deletes reverse both sides of a transfer, exact cents, randomised run against a reference model (`backend/tests/test_ledger_invariants.py`)
- [x] Money precision: `NUMERIC` and `Decimal` end to end, no client arithmetic
- [x] Calculation rules written down ([financial calculations](../architecture/financial-calculations.md))
- [ ] Manual check of the custom select: keyboard, outside click, focus, touch, light and dark mode, inside the account and transaction dialogs and the filters

**Exit:** a reliable, documented financial foundation.

## Milestone 1: Double-entry ledger

Following the [ledger design](../architecture/ledger-design.md) (revision 2). The direction is approved. The migration starts only after the first two items.

- [x] Backend tests also running on PostgreSQL: whole suite, concurrency, migrations, and the ledger prototype's constraints and triggers ([testing](../architecture/testing.md)), on branch `step0-postgres-tests`
- [ ] `check-ledger`, `backfill-ledger` (idempotent) and `reconcile-ledger` commands
- [ ] Schema: categories, ledger accounts, changes, postings, journal lines, opening dates
- [ ] Backfill, then dual-write with daily reconciliation
- [ ] Owner resolves accounts that have transactions dated before their creation
- [ ] Switch reads after 7 clean days
- [ ] Void instead of delete (with note redaction), dated balance adjustments, linked refunds, and managed categories (rename, archive, merge, nest)
- [ ] `CHECK` constraints and a `(user_id, date)` index on transactions
- [ ] Retire the old engine

**Exit:** every account movement reconciles, and any past balance can be reconstructed.

## Milestone 2: Everyday cash flow

Make daily tracking take seconds.

- Quick-add from anywhere: a global action on the website, a floating action on the app, remembered defaults and recent categories
- Search by note, and filters by date range, account and category
- Transaction detail view with its edit history
- Monthly summary: income, spending, net cash flow, spending by category
- Monthly budgets per category, with how much is used and overspending flagged
- Recurring templates (salary, rent, subscriptions, EMIs) that remind and pre-fill, never auto-post. Built on branch `recurring-insurance` ([design](../superpowers/specs/2026-11-10-recurring-and-insurance-design.md)), along with health insurance policies that renew through a template and are funded by an RD

**Exit:** complete daily money management.

## Milestone 3: Assets

Possessions such as vehicles, property, jewellery and physical gold, plus fixed and recurring deposits. Purchase details, ownership percentage and a dated valuation history.

**Status:** PPF and RD are built on branch `deposits` ([design](../superpowers/specs/2026-11-09-deposits-design.md)): deposit accounts with maturity dates, interest estimates, due instalments and Close RD, counted in net worth. Vehicles, property, jewellery, physical gold and valuation history are not built.

**Exit:** non-investment assets count towards net worth.

## Milestone 4: Investments

Instruments (stocks, mutual funds, ETFs, gold, others) and buy and sell trades with fees. Lots with cost basis allocated on sale, dividends, manual price updates, and realised and unrealised returns.

**Status:** stocks are built on branch `stocks` ([design](../superpowers/specs/2026-11-08-stocks-design.md)): trades through broker accounts, FIFO cost basis, manual prices, realised and unrealised returns, and stocks in net worth and the dashboard. Mutual funds are built on branch `mutual-funds` ([design](../superpowers/specs/2026-11-09-mutual-funds-design.md)): the general investment model, purchases and redemptions through bank accounts, NAVs (recorded automatically with each transaction), SIP reminders that never post on their own, and funds in the portfolio, net worth and dashboard. Crypto is built on branch `crypto` ([design](../superpowers/specs/2026-11-09-crypto-design.md)): coins with 8-decimal quantities, buys and sells through exchange accounts, manual prices, and crypto in the portfolio, net worth and dashboard. ETFs, gold and dividends are not built. The Android stock screens are built but still need the device test against the deployed API, which happens after the website works in production.

**Exit:** complete manual portfolio tracking.

## Milestone 5: Liabilities

Loans with principal, rate, tenure and an EMI schedule. Interest is kept apart from principal. Repayment history and outstanding balance. Credit cards already exist.

**Status:** brought forward at the owner's request. Loans and EMIs are built on the backend, website and Android app (branch `loans`, [design](../superpowers/specs/2026-11-08-loans-design.md)), on the current engine, so the ledger backfill maps each EMI to its three lines. The app still needs testing on a device against the deployed API. A full amortisation schedule is not built.

**Exit:** a complete liabilities overview.

## Milestone 6: Net worth over time

Snapshots, trend over 12 months, asset allocation and a financial health overview.

**Exit:** the owner can see how their position has changed.

## Milestone 7: Goals

Goals with a target amount and date, linked to existing accounts, with contributions and progress.

**Status:** built on branch `goals` ([design](../superpowers/specs/2026-11-11-goals-design.md)). Goals have a basket of money set aside in bank, cash and wallet accounts (earmarked, no money moves) and whole holdings (a fund, stock, coin, PPF or RD). Progress, months left and the monthly figure, an emergency fund worked out from recent expenses (6 months by default), a free balance on accounts, a monthly set-aside reminder and a goals summary on the dashboard are built. Goals never count in net worth. Folded in: archived accounts stop reminders, archiving an account is refused while money is set aside or it pays an active policy, and a SIP moved to another bank no longer shows old months as due. Phone notifications, inflation-adjusted targets and projected growth are not built. The Alembic migration must be run on Neon by hand before this merges.

## Milestone 8: Reports and data portability

Monthly and yearly reports, investment and asset and liability reports. CSV export (website) and share/export (app). PDF reports. Full backup and a tested restore.

## Milestone 9: Production hardening

Security review, rate limiting, a backup and recovery drill on Neon, structured logs and error monitoring, Android release and crash monitoring, and cross-platform regression tests.

Some of these, such as backups and rate limiting, should move earlier, before the app holds records the owner relies on. Neon's point-in-time restore covers backups until then.

## Estimate

Roughly 4 to 7 months of focused solo work for a polished version. Most of the variation comes from how deep investment tracking and reporting go. This is a planning estimate, not a schedule.
