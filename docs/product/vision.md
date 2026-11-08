# Vision

A personal finance manager that one person operates entirely by hand, on the web and on Android, and that they can trust with their real financial records.

## The central idea

Every asset, liability, transaction and valuation is recorded accurately, keeps its history, and stays its own thing. A bank account is not an investment, an investment is not a possession, and a goal is not an account.

## Questions the product must answer

- How much money do I have across all my accounts?
- What is my net worth right now, and what was it on any past date?
- How much did I earn and spend this month?
- How much have I put into investments, and what are they worth now?
- How much do I owe across credit cards and loans?
- How much can I safely spend?
- How has my position changed over the last 12 months?

All without a bank connection or an outside data provider.

## Principles

1. **Manual-first, not inconvenient.** The owner enters every record. Entering one should take seconds: a quick-add from anywhere, remembered defaults, recent categories. Nothing is ever recorded without the owner's action.
2. **The backend owns financial truth.** Balances, totals, net worth and returns are computed once, on the server. The website and the app only display them.
3. **History is never silently rewritten.** Corrections are recorded as corrections, so a past position can always be reconstructed.
4. **Platform-native clients.** The website and the Android app share one API and one set of rules, but each gets its own interface. The website suits tables, analytics, bulk entry and exports. The app suits quick entry and a quick overview.
5. **Correctness before features.** A new financial feature waits until the numbers under it are reliable and tested.

## The eight domains

These are areas of the product, not separate services. They live in one FastAPI application.

| # | Domain | Covers | Status |
|---|---|---|---|
| 1 | Financial foundation | Users, accounts, transactions, transfers, categories | Built; ledger redesign planned |
| 2 | Cash flow | Income, expenses, budgets, recurring commitments | Next |
| 3 | Assets | Cash, deposits, vehicles, jewellery, property | Planned |
| 4 | Investments | Stocks, mutual funds, ETFs, gold, lots | Planned |
| 5 | Liabilities | Credit cards, loans, EMIs | Cards built; loans built on the website, app next |
| 6 | Planning | Goals, savings targets | Planned |
| 7 | Intelligence | Net worth history, analytics, reports | Planned |
| 8 | Data | Audit history, exports, backup and restore | Planned |

## Out of scope

| Feature | Decision |
|---|---|
| Bank synchronisation or account aggregators | Not building |
| Automatic stock prices or mutual fund NAVs | Not building |
| Automatic transaction detection | Not building |
| AI financial advice | Not building |
| Automatic bill payments | Not building |

A user-initiated file import (for example, a bank statement CSV) may come later. It stays optional, and the owner reviews every record it would create.

## Stack

FastAPI, SQLAlchemy and Alembic on PostgreSQL (Neon in production). Next.js website and Expo Android app on Vercel and EAS. No Redis, queues, microservices or separate analytics database until a real need shows up.
