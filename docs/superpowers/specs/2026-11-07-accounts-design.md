# Accounts: design

## Why

The app has Google sign-in and a blank dashboard, and nothing else. Accounts come first because every later feature needs them: a transaction happens in an account, a transfer moves between two, and net worth adds them up.

The owner's main accounts are bank accounts, credit cards, and cash in hand. They also keep unused money with a stock broker, so that needs a place too.

The owner has not said whether the app leans towards daily spending or total wealth. This scope serves both, so that question stays open for later features.

## Goals

A signed-in user can, on both web and Android:

- Add an account of one of five types, with a name, a balance, and a few details for that type.
- See their accounts grouped by type, with one total for what they have and one for what they owe.
- Edit an account, including correcting its balance.
- Archive an account, see archived accounts on request, and restore one.

## Non-goals

These are deliberately left for later. Don't build them or anything that exists only to support them.

- **Transactions, transfers, and credit card bill payments.** Next feature. Until then, balances change only when edited.
- **Investments.** Shares, mutual funds, FDs, RDs, and similar get their own section with their own valuation logic. The shares in a broker account belong there. Only the broker's unused money is an account here.
- **Net worth on the Accounts page.** The Accounts page keeps no net figure. Net worth lives on the dashboard (see "Dashboard" below), where it can carry a caption that it leaves out investments and loans.
- **Loans, buy now pay later, and money lent or borrowed.**
- **Bank syncing, statement import, due date reminders, multiple currencies, manual reordering, and listing accounts on the dashboard.** The dashboard shows only the summary figures described below.

## Anti-goals

This would be a failure even if it technically worked:

- **Storing sensitive card or bank details.** Never collect full card numbers, full account numbers, CVV, PINs, or banking passwords. The last 4 digits is the most the app holds.
- **Showing a credit card's debt as money the user has.** It must never add to the "have" total.
- **Rounding errors in money.** Money is never handled as a binary float in the database, the API, or client arithmetic.
- **One user seeing or changing another user's accounts.** Someone else's account behaves as if it doesn't exist (404).
- **Identical UI on both clients.** Web and Android each get screens designed for their platform on one shared backend.

## Account types

Decided with the owner:

| API value | Label | Extra details |
|---|---|---|
| `bank` | Bank account | Bank name, kind (savings, salary, or current), last 4 digits |
| `credit_card` | Credit card | Card issuer, last 4 digits, credit limit, statement day, due day |
| `cash` | Cash in hand | None |
| `broker` | Broker balance | Broker name |
| `wallet` | Wallet or prepaid card | Provider |

Bank, cash, broker, and wallet balances are money the user has. A credit card balance is money the user owes.

## Behaviour

### Fields and validation (builder's starting point, marked as design calls below)

| Field | Applies to | Rule |
|---|---|---|
| `name` | All | Required, 1 to 60 characters after trimming. Duplicates allowed. |
| `type` | All | Required. Cannot change after creation. |
| `balance` | All | Required, up to 2 decimal places, magnitude below 1,000,000,000,000. |
| `institution` | All except cash | Optional, up to 60 characters. Holds the bank, issuer, broker, or provider name. |
| `bank_kind` | Bank | Required for a bank account: `savings`, `salary`, or `current`. |
| `last4` | Bank, credit card | Optional, exactly 4 digits. |
| `credit_limit` | Credit card | Optional, greater than 0. |
| `statement_day`, `due_day` | Credit card | Optional, 1 to 31. |

A field sent for a type it doesn't apply to is rejected with a 422, not silently dropped.

Balance sign:

- `bank` and `broker` may be negative (overdraft, broker debit).
- `credit_card` is entered as the positive amount owed. It may be negative when the card has been overpaid.
- `cash` and `wallet` cannot be negative.

### Totals

The server computes both totals so the two clients can't disagree. They cover active accounts only.

- **You have:** the sum of bank, cash, broker, and wallet balances. A negative bank balance reduces it.
- **You owe:** the sum of credit card balances. An overpaid card reduces it.

Show the two figures separately, with no net figure.

### Archiving

Archiving removes an account from the default list and from the totals. Nothing is lost, and it can be restored. There is no permanent delete in this version, because later transactions will refer to accounts.

### Display

- Accounts appear in this type order: bank, credit card, cash, broker, wallet. Within a type, sort by name, case-insensitively.
- Money is shown in rupees with Indian digit grouping: ₹1,00,000.50.
- A credit card shows the amount owed. When it has a limit, also show available credit (limit minus owed).
- `last4` is shown masked, for example `•••• 1234`.
- When adding cash in hand, prefill the name with "Cash in hand", which the user can change.

## Backend

Follow the existing FastAPI, SQLAlchemy, and Alembic setup. The new router uses `dependencies=[Depends(get_current_user)]`, as the protected auth router does, and every query is filtered by the current user's ID.

### Data

One `accounts` table, since the types differ only by a few optional details:

- `id`, `user_id` (foreign key to `users`, indexed), `type`, `name`
- `opening_balance` as `NUMERIC(14, 2)`
- `institution`, `bank_kind`, `last4`, `credit_limit` as `NUMERIC(14, 2)`, `statement_day`, `due_day`
- `archived_at` (null when active), `created_at`, `updated_at`

`type` and `bank_kind` are validated strings rather than database enums, so adding a type later doesn't require altering an enum.

**Why `opening_balance`:** in this version, the balance is just this stored value. When Transactions arrives, the balance becomes this value plus the account's transactions. Naming it this way now avoids a confusing column later. The API calls it `balance`, so the clients won't need to change when the calculation does.

### API

Money travels as decimal strings, like `"1234.50"`, in both directions.

| Method and path | Purpose |
|---|---|
| `GET /api/accounts` | Active accounts plus `total_have` and `total_owe` |
| `GET /api/accounts?archived=true` | Archived accounts only, for the archived view. The totals in this response still cover active accounts. |
| `POST /api/accounts` | Create an account. Returns 201 with the account. |
| `PATCH /api/accounts/{id}` | Partial update of editable fields. Rejects a `type` change with 422. |
| `POST /api/accounts/{id}/archive` | Archive. Repeating it is harmless. Returns the account. |
| `POST /api/accounts/{id}/restore` | Restore. Repeating it is harmless. Returns the account. |

In a PATCH, sending `null` for an optional field clears it. Archived accounts can't be edited until restored (409). Validation runs on the merged result, so a PATCH can't leave a bank account without a kind.

### Tests

Extend the existing pytest suite, which uses in-memory SQLite. Cover at least:

- Creating each type, and the per-type validation
- Rejecting a field that doesn't apply to the type
- Balance sign rules
- Exact decimal totals, including an overdraft and an overpaid card
- Archived accounts leaving the totals, and restore bringing them back
- Rejecting edits to archived accounts and `type` changes
- Requests without a valid session returning 401
- Another user's account returning 404 on every route that takes an ID

Money assertions must compare exact values. The suite stays on SQLite, which doesn't enforce `NUMERIC(14, 2)` and can store numeric values as floats. So validate limits and decimal places in the API layer, and compute totals in Python with `Decimal` rather than with SQL `SUM`.

SQLite can't prove the real column behaviour, so the local website check in step 2 of the release order must confirm exact values on PostgreSQL: save and reload a balance with paise, a balance at the maximum size, and totals across several accounts.

## Web (`frontend/`)

- Add an "Accounts" link to `src/components/sidebar.tsx`, and an `/accounts` route inside the `(app)` group.
- The page shows the two totals, then accounts grouped by type, with an "Add account" action and a way to view archived accounts.
- Add and edit happen in a dialog on the same page. Changing the type while adding swaps the type-specific fields. On edit, the type is shown but can't be changed.
- Archiving asks for confirmation. Restoring doesn't need to.
- Handle loading, empty ("Add your first account"), and failed-to-load states, and show validation errors next to their fields.
- It should feel like a desktop web tool: dense, keyboard-friendly, and matching the existing zinc Tailwind styling. Use design judgment within that.

## Android (`mobile/`)

- Add an "Accounts" tab between Dashboard and Profile in `src/app/(tabs)/_layout.tsx`.
- Use Material Design with `react-native-paper`: sectioned list, totals at the top, a floating action button to add, and pull to refresh.
- Add and edit on a full-screen form rather than a dialog. Use a numeric keyboard for money and day fields.
- Archive from the edit screen, with a confirmation dialog. Archived accounts open from an action on the Accounts screen.
- Handle the same loading, empty, and failure states. A 401 signs the user out, as the tab layout does already.
- Extend `src/lib/api.ts` to support `PATCH`.

## Build and release order

The README sets this order, and the app always talks to the deployed API:

1. Backend with tests and migration.
2. Website, verified locally against the local database.
3. Run the migration on Neon, then deploy. Production steps are run with the owner's go-ahead.
4. Android app, tested against the deployed API. No LAN IP or local backend.

Update the README if the setup changes.

## Done means

- `npm run lint` and `npm run test` pass.
- A person can add one of each type, edit it, archive it, and restore it on the website and on the Android app, seeing correct totals throughout.
- An account created on one client appears on the other.

## Design calls made by Claude, not yet confirmed by the owner

- India and rupees only, with no currency column. The owner was told this assumption and didn't object, but never explicitly confirmed it.
- Wallets are included. The owner asked for a recommendation and then approved the scope containing them.
- One user may have several accounts of any type, including cash.
- Name and bank kind are required, and all other details are optional, so adding an account stays quick.
- The balance sign rules, and the field limits above.
- Account type can't change after creation, because a credit card's balance means the opposite of a bank account's.
- There is no permanent delete, so a mistakenly created account can only be archived.
- Archived accounts can't be edited until restored.
- Available credit is shown on credit cards.
- Salary is a kind of bank account rather than its own type.
- Automated tests stay on SQLite with no PostgreSQL test setup, and exact money behaviour on PostgreSQL is checked by hand during the local website check.

## Dashboard (added 2026-11-08)

Owner-approved for now; expect it to be refactored as features arrive.

- Net worth is on the dashboard, covering accounts only, with the caption "Investments and loans not included yet". The Accounts page still has no net figure.
- `GET /api/dashboard` (protected, current user, active accounts only) returns `has_accounts`, `net_worth` (= total have - total owe, may be negative), `total_have`, `total_owe`, `next_card_due` and `credit_used`, with money as decimal strings. The totals reuse the Accounts logic.
- `next_card_due`: the credit card whose due day comes soonest on or after today (India time), with the day clamped to short months; null if no card has a due day. Ties follow the account list order.
- `credit_used.percent`: card balances over card limits, counting only cards with a limit, as a whole number rounded half up, never below 0 and possibly above 100; null if no card has a limit.
- Both clients show: net worth, "You have" minus "You owe", and a "Needs attention" section (due card, credit used) hiding any line whose data is null. Those figures and rows open the Accounts page or tab. With no active accounts they show net worth at 0.00 and "Add your first account".

## Left to the builder

File and component structure, form libraries, exact visual design within the platform notes above, and the shape of error responses, provided both clients can show field-level messages.
