# Monthly cash flow: design

## Why

Phase 2 of the [product review plan](../plans/2026-11-12-product-review-plan.md) fixes three of the owner's complaints:

| # | Complaint | Check that proves it's fixed |
|---|---|---|
| 1 | Can't answer "how much did I spend this month?" | The dashboard shows spent and earned this month, compared with last month at the same day, and the top 3 categories. Transfers, investment buys, card payments and EMI principal are not spending. |
| 3 | Categories split into "Food", "food", "Groceries", "Swiggy" | Merge "Swiggy" into Food and dining: every past transaction, template and payee rule moves, and the month report shows one bucket. Rename, archive and Food → Groceries/Dining nesting work too. |
| 4 | No search ("when did I last pay the plumber?") | Type "plumber" on Transactions: matching notes and payees, newest first, with date, account, category, type and amount filters. Also on the app. |

Everything not decided by the plan was left to Claude ("do what's best"). Those calls are marked *my call* and listed at the end.

## How the money is stored today

Before writing the rules, this is where each kind of money movement lives:

| Movement | Stored as | Cash flow |
|---|---|---|
| Salary, interest, dividends, refunds | `transactions.type = income`, with a category | Income |
| Spending (bank, cash, wallet or card) | `type = expense`, with a category | Spending, in the month it was made |
| Transfer between own accounts | `type = transfer`, no category | Neither |
| Credit card bill payment | `type = transfer` into the card | Neither (the purchases were already spending) |
| PPF/RD deposit or withdrawal | `type = transfer` to or from the deposit | Neither |
| PPF/RD interest credited | `type = income`, category "Interest" | Income |
| RD closed early, penalty | `type = expense`, category "Fees and charges" | Spending |
| Insurance premium | `type = expense`, category "Insurance" | Spending |
| EMI | `type = emi`, `amount` with `interest` part, category always "Loan interest" | Only `interest` is spending; `amount − interest` (principal) is neither |
| Stock, fund, coin buy or sell | `investment_trades`, never in `transactions` | Neither |
| SMS money not yet categorised | `income`/`expense` with `category = NULL` | Counts, as "Uncategorised" |

## Managed categories

### The table

`categories` follows the [ledger design](../../architecture/ledger-design.md#categories) so the ledger reuses it unchanged and only adds its `ledger_accounts.category_id`:

| Column | Meaning |
|---|---|
| `id`, `user_id` | as everywhere; `UNIQUE (id, user_id, kind)` for the ledger's composite keys |
| `kind` | `income` or `expense` |
| `name` | 1–40 characters, the owner's spelling |
| `name_key` | `name` case-folded, kept by the code; unique per `(user_id, kind)` among categories that aren't merged (a partial unique index) |
| `parent_id` | one level of nesting; `(parent_id, user_id, kind)` references a category of the same user and kind |
| `merged_into_id` | set when merged; same composite key |
| `icon` | a key from a fixed list (`food`, `cart`, `car`, …); each client maps it to its own icon set |
| `colour` | `#rrggbb` |
| `archived_at` | hidden from pickers, kept in history |

### Names stay on the transactions (*my call*)

Transactions, recurring templates and payee rules keep their `category` name column. The `categories` table is the **registry** of those names: every name used is a row, and rename and merge rewrite the name columns in the same database transaction.

Why not a `category_id` foreign key now:

- Every client, the SMS pipeline, policies, deposits and the review flow read and write a name. Existing API clients (the installed app) must keep working, so the API speaks names either way.
- Names are unique per user and kind among live categories, so a name identifies exactly one row. The ledger migration can add `category_id` by joining on `(user_id, kind, name_key)` with no ambiguity.
- Two other branches are being built in parallel. A foreign key would touch every place a category is read; this keeps the change to the write paths.

The cost: a rename rewrites rows instead of one. It runs under a lock on the user's category rows in one transaction, so a reader never sees half of it.

### Seeding

The migration gives each existing user the default list (income: Salary, Business, Interest, Dividends, Refund, Gift, Other; expense: the 16 current defaults plus **Loan interest**, the EMI category), then every category already used in transactions, templates and payee rules, case-insensitive duplicates collapsed with the "known spelling" rule (a default's spelling wins, then the first one found). Templates and payee rules whose spelling differs are rewritten to the kept spelling. A payee rule has no type, so its category is income only when an income category of that name exists, else expense.

A user with no rows yet (a new account) gets the defaults the first time categories are read or used.

### Which category a name means

Every write path that takes a category name (transactions, SMS recording and review, recurring templates, payee rules) resolves it the same way, for the kind the transaction type implies (`emi` is expense):

1. A live category with the same case-folded name: its spelling is used.
2. Else a merged category of that name: the category it was merged into (so an old client still sending "Swiggy" lands in Food and dining).
3. Else a new category is created. This keeps free-text clients working, as today.

An **archived** category can't be picked for something new ("Shopping is archived. Restore it to use it."). An existing transaction or template can keep its archived category when edited. An SMS whose payee rule or merchant names an archived category goes to To review instead of being recorded with it.

### Fixed categories

The code itself writes four names: **Interest** (income, PPF/RD interest), **Insurance** (policy premiums), **Fees and charges** (RD closed early) and **Loan interest** (EMIs). These are *fixed*: they can't be renamed, archived or merged into another (other categories can be merged into them, and they can be nested and recoloured). *My call*: otherwise the next premium would bring the old name back.

### Operations

- **Create** with kind, name, optional parent, icon, colour. A name already in use: "You already have Food." (or "... is archived. Restore it instead.").
- **Rename**: the new name must be free in that kind ("You already have Dining. Merge them instead."). Rewrites transactions, templates and payee rules, and leaves the old name behind as an alias (a merged-style row pointing at the category), so anything still sending it (an SMS merchant, a payee rule, an old client) lands on the renamed category.
- **"Uncategorised" is reserved** for money without a category: it can't be a category's name or be picked.
- **Merge A into B** (same kind): every transaction, template and payee rule of A moves to B; anything merged into A earlier now points at B; A's subcategories move under B; A is marked `merged_into_id = B` and disappears from lists. Refused when B is archived, merged, A itself, A's own subcategory, or when A has subcategories and B is a subcategory (that would make two levels). *My call*: merging is final in this phase, because the references move. The ledger's "unmerge" needs the lines to keep A, which comes with the ledger.
- **Archive / restore**. A parent with live subcategories can't be archived until they are moved or archived (*my call*, so nothing is hidden by surprise).
- **Nest / unnest**: set or clear `parent_id`. The parent must be a live, top-level category of the same kind, not the category itself; a category that has subcategories can't become one.
- **Payee rules** have no type: a rename or merge moves a rule's category only when no live category of the other kind has the same name.

There is no delete: archive does that job and keeps history.

## Monthly summary

`GET /cash-flow?month=YYYY-MM` (default: this month, India's date). The rules go into [financial-calculations.md](../../architecture/financial-calculations.md#cash-flow) before the code.

- **Income** = the sum of `income` amounts dated in the window.
- **Spending** = the sum of `expense` amounts plus the `interest` of each `emi`.
- **Net cash flow** = income − spending.
- Transfers (card payments and deposits included), investment trades and EMI principal count in neither.
- **The window**: the 1st of the month to the **cut-off day**: today for the current month, the month's last day for a past month. A future month is refused.
- **Previous month at the same day**: the previous month from its 1st to the same cut-off day, clamped to its length (12 November compares with 1–12 October; 30 March with 1–28 February; on its last day, and after it, a month compares whole with the whole month before). Changes are returned as signed amounts and a whole percent (no percent when the previous figure is 0), worked out on the server.
- **By category with parent rollup**: each top-level category's figure is its own plus its subcategories'. Groups are sorted biggest first, each with its subcategories, its direct amount and its share of the total as a whole percent. No category shows as "Uncategorised". An EMI's interest is under "Loan interest".
- **Top 3**: the three biggest spending groups.
- **Daily spending**: one entry per day of the month, a day after today has no figure. Each carries its height as a whole percent of the month's biggest day, so the clients draw bars without doing arithmetic on money.
- Also: the income groups, the transaction count and the earliest month with a transaction (for month navigation).

The dashboard card reads the same endpoint (`GET /cash-flow`), so the dashboard response doesn't change. *My call*: a separate request keeps the dashboard endpoint untouched while other branches change it.

## Search and filters

`GET /transactions` gains, alongside `account_id`, `type`, `month`, `limit` and `offset`:

| Parameter | Matches |
|---|---|
| `q` | text found in the note, the payee of the SMS it came from, or the category name, ignoring case |
| `date_from`, `date_to` | inclusive dates; `date_from` after `date_to` is a 422 |
| `category` | that category and, for a parent, its subcategories; `Uncategorised` finds those with none |
| `amount_min`, `amount_max` | inclusive, on the transaction's `amount` |

Results stay newest first, and `total_income`, `total_expense` and `expense_by_category` cover every match. A `(user_id, date)` index is added.

## Clients

Each platform gets its own UI on the shared backend. Clients only format server figures.

**Website**
- **Dashboard**: a month card (spent, earned, net, the change since last month at the same day, top 3 with bars), linking to the month report. One self-contained component, one line in the dashboard.
- **Month report** (`/cash-flow`, `?month=`): totals with changes, a hand-built SVG bar chart of daily spending, a category table with subcategories and share bars, income by category, previous/next month links. Each category links to the transactions page filtered by it and the month.
- **Transactions**: a search box and a filter bar (dates, account, category, type, amount range), kept in the URL.
- **Categories** page: income and expense lists with nesting, usage counts, and create, rename, recolour, change icon, nest, merge and archive/restore.
- Category pickers group subcategories under their parent and leave archived ones out.

**Android** (react-native-paper, the existing chunky style)
- **Dashboard**: a month card (spent vs last month, top 3) that opens the month screen.
- **Month screen**: totals, a daily bar strip, category groups that expand to subcategories, month arrows.
- **Transactions tab**: a search bar, filter chips and a filter sheet.
- **Categories screen** reached from the Profile/More area: lists by kind, and a sheet per category with rename, icon, colour, parent, merge and archive.

## Non-goals

Budgets (Phase 3), payee → category learning (Phase 5), unmerge and the category audit table (with the ledger), refunds as their own type, charts libraries, deleting categories.

## Design calls made by Claude ("do what's best"), not yet confirmed by the owner

1. **Names stay on transactions, templates and payee rules; the table is the registry** (above). The ledger adds `category_id` later by joining on the unique name.
2. **Merging moves the references and is final** in this phase; the merged row is kept with `merged_into_id` so an old client sending its name lands in the target.
3. **Free text still creates a category** when a client sends an unknown name, so the installed app keeps working.
4. **Four fixed categories** (Interest, Insurance, Fees and charges, Loan interest) can't be renamed, archived or merged away.
5. **A parent with live subcategories can't be archived.**
6. **Icons are keys from a fixed list**, mapped by each client to its own icon set; colours are `#rrggbb` from a palette offered by the clients.
7. **The month window ends today** for the current month, and the comparison clamps the day to the previous month's length.
8. **Refunds stay income**, as today, until refunds get their own type with the ledger.
9. **Search also matches category names**, besides notes and SMS payees.
10. **The month card has its own endpoint** instead of growing the dashboard response.
11. **Payee rules follow a rename or merge** only when the name isn't also a live category of the other kind.
