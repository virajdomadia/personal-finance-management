# Product review plan

From the product review on 2026-11-12. It orders every suggestion from that review into phases. Each phase gets its own design spec and implementation plan when it starts, like earlier features. This document fixes the order, the scope and what "done" means.

## The user's complaints and where each is fixed

Every complaint from the review's normal-user section, with the test that proves it's fixed. A phase isn't done until its rows pass on the website and are on the app's device-check list.

| # | Complaint | Fixed in | Check that proves it's fixed |
|---|---|---|---|
| 1 | Can't answer "how much did I spend this month?" | Phase 2: monthly summary API, dashboard month card, month report page | Open the dashboard: spent and earned this month, compared with last month at the same day, top 3 categories. Transfers, investment buys, card payments and EMI principal are not counted as spending. |
| 2 | No budgets | Phase 3: monthly budgets per category | Set Food and dining to ₹8,000. The dashboard and the month page show spent, remaining and a progress bar, and the category turns red once over. |
| 3 | Categories split into "Food", "food", "Groceries", "Swiggy" | Phase 2: managed categories. Case is already merged today ("food" becomes "Food"); what's missing is merging different names. Phase 5 adds payee → category. | Merge "Swiggy" into Food and dining: every past transaction, template and payee rule moves, and the month report shows one bucket. Rename, archive and Food → Groceries/Dining nesting work too. |
| 4 | No search ("when did I last pay the plumber?") | Phase 2: search and filters | Type "plumber" on Transactions: matching notes and payees, newest first, with date, account, category, type and amount filters. Also on the app. |
| 5 | No chart of how I'm doing over time | Phase 4: daily snapshots, backfill, charts | The website shows a 12-month net worth line and allocation over time. The app dashboard shows a sparkline and the change since last month. |
| 6 | Too many screens; "add stock / trade / price" thinks like a developer | Phase 6: one "Add investment" flow | Adding a new holding with its first purchase is one flow. Price, NAV and link are actions on the holding screen. The app's investment form screens are at least halved. |
| 7 | The streak feels gimmicky; I want "you spent X, Y more than usual" | Phase 5: weekly digest; streak moves to the profile screen | Sunday notification on the app and a card on the website: spent this week compared with the 4-week average, budgets at risk, what's due next week. The streak no longer appears on the dashboard. |
| 8 | "To review" becomes a chore | Phase 5: auto-categorise from payee history and "Approve all confident" | A draft from a payee seen 3+ times arrives with its category filled in. One tap approves every confident draft. A normal week takes under 5 minutes to clear. |
| 9 | Can't get my data out | Phase 1: CSV export, JSON backup, tested restore | Website: download all data as CSVs and a JSON backup. App: share sheet export. A backup restored into a fresh database gives identical balances, net worth and portfolio totals (a CI test). |
| 10 | Empty first screen; setting up 10 accounts before seeing any value | Phase 7: first-run setup and empty states | A new user with no data sees a guided checklist: salary account, cards, loans, SIPs and investments, then SMS on the app. It can be skipped and resumed, the dashboard shows progress, and every screen has a written empty state. |

Phases 6 and 7 come after the cash-flow work (Phases 2 to 5). Their problems are real, but they hurt less once the app is useful every day.

## Rules while this plan runs

- **No new asset or instrument types** (ETFs, gold, vehicles, property, jewellery) until Phase 4 is done. The product already covers a lot. What it lacks is the daily loop.
- Every feature ships on the backend first, then the website (tested on production), then the Android app. This is unchanged.
- Any phase with an Alembic migration is flagged before merge, because the owner runs it on Neon by hand.
- Android work adds to the pending device-check list. Installing on a phone stays deferred until the app is done (owner's decision). The risk of that is noted in Phase 9.

## Phase 0: Make the documents true (half a day)

The vision says "not building" for automatic prices, NAVs and transaction detection. All three are built.

- Rewrite the *Out of scope* table in `docs/product/vision.md`. The principle becomes **"Nothing is recorded without the owner's action"**: SMS creates drafts the owner reviews, and prices are market data, not records. Keep bank sync, aggregators, AI advice and auto bill-pay out of scope.
- Update the domain status table and `docs/product/roadmap.md` to match `main`: SMS, nightly prices, goals, insurance, recurring.
- Replace the roadmap order with the phases below.
- Write down the audience: **the owner plus invited family members, each with separate data**. Shared household accounts are not planned (see Phase 7).

**Done when:** reading the vision and roadmap gives an accurate picture of `main`.

## Phase 1: Safety net (about 1 week)

Real financial records and SMS data are already in production. This phase comes before more features.

- **Export:** a CSV per entity (accounts, transactions, trades, fund trades, crypto trades, loans, deposits, goals, policies, templates). The website gets a download. The app gets a share sheet.
- **Backup and restore:** one versioned JSON backup of a user's data, with a restore command (`app.cli restore-user`) tested in CI against a fresh database. Restore must give the same balances, net worth and portfolio totals.
- **Restore drill on Neon:** do one point-in-time restore to a branch and write the steps in the backend README.
- **Error monitoring:** Sentry (free tier) on the API, the website and the app. Scrub amounts, notes and SMS bodies before sending.
- **Rate limiting:** on `/api/auth/google`, the SMS ingest endpoint and the cron endpoint.

**Done when:** the owner can download everything, a backup restores to identical totals in a test, and a forced error shows up in Sentry from all three clients.

## Phase 2: Monthly cash flow (about 2 weeks)

Answers "how much did I earn and spend this month?", which the dashboard can't do today.

- **Managed categories:** a `categories` table that replaces free-text strings. A migration creates rows from the defaults plus every category already used, and transactions, templates and payee rules then reference them. Rename, merge (moves every reference), archive, and one level of nesting (e.g. Food → Groceries, Dining). Each category has an icon and colour. Design it to match Milestone 1's "managed categories", so the ledger work reuses it instead of redoing it.
- **Monthly summary API:** income, spending and net cash flow for a month, spending by category, and a comparison with the previous month. Transfers, investment buys and card payments are not spending. EMI interest is spending, EMI principal is not. Write these rules into `financial-calculations.md` before coding.
- **Dashboard month card** (web and app): spent so far against last month at the same day, plus the top 3 categories.
- **Month report page** on the website: category breakdown, a daily spending bar chart, and month-to-month navigation.
- **Search and filters:** free text over notes and payees, plus date range, account, category, type and amount range. Add the `(user_id, date)` index here (taken from Milestone 1).

**Migration:** yes, for categories. Flag it before merge.
**Done when:** the dashboard answers "spent this month" on both clients, and merging two categories updates every past transaction.

## Phase 3: Budgets and what's coming (about 1.5 weeks)

- **Monthly budgets per category:** budget, spent and remaining, with a progress bar. Over-budget categories are flagged in red. Unused budget does not roll over (simple first).
- **Upcoming 30 days:** one list of everything due (EMIs, SIPs, card bills, insurance premiums, recurring templates, goal set-asides) with dates, plus a running bank balance after each item. All of this data already exists.
- **Safe to spend:** money in bank, cash and wallet accounts, minus what's due before the next salary (from the salary recurring template), minus money set aside for goals, minus the rest of the month's budgets. Shown on the dashboard with a "how is this worked out" breakdown. The formula goes in `financial-calculations.md`.

**Migration:** yes, for budgets. Flag it.
**Done when:** the dashboard shows safe to spend and the next 30 days, and the numbers can be checked by hand from the breakdown.

## Phase 4: Net worth over time (about 1 week)

- **Daily snapshot** of net worth, the have/owe totals and the asset split, written by the existing nightly cron after prices update. If a run is missed, the next run fills the gap from today's values. These are approximate, and a note in the UI says so.
- **Backfill:** a CLI command that estimates monthly points from transaction history for cash accounts. Investments only count from the day snapshots start. This limit is written down, not hidden.
- **Charts:** a 12-month net worth line and an asset allocation over time chart on the website, and a 12-month sparkline on the app dashboard.
- **Ledger decision (ADR-004):** with snapshots in place, decide whether Milestone 1's full double-entry rebuild is still worth doing, and when. Either schedule it with a start date or shelve it with the reasons. Don't leave it half-planned.

**Migration:** yes, for snapshots. Flag it.
**Done when:** the dashboard shows the trend and ADR-004 is written.

## Phase 5: Less work to keep it updated (about 1.5 weeks)

- **SMS review speed:** auto-categorise a draft from the payee's history even without a payee rule, and add "Approve all confident" for drafts that match a rule or a payee seen 3+ times. The aim is a review queue that takes under a minute a day.
- **Quick add:** a website keyboard shortcut and header button, and an app floating action button. Both remember the last account and suggest the 5 most recent categories.
- **Weekly digest:** a Sunday summary (spent vs usual, budgets at risk, what's due next week). On the app it's a notification, which needs `expo-notifications` and an Expo push token stored per device, sent by a weekly cron. On the website it's a dismissible card. This needs a new native module, so it goes on the device-check list.
- **Streak:** move it off the dashboard to the profile screen, where the weekly digest takes its place as the reason to come back. Delete it later if nobody misses it.

**Migration:** yes, for push tokens. Flag it.
**Done when:** a normal week of SMS drafts takes under 5 minutes to clear.

## Phase 6: Simpler investment entry (about 1 week, mostly app)

- One **"Add investment"** entry point that asks for the type (stock, fund, coin, deposit) and then the instrument, and records the first purchase in the same flow. No more separate "add stock" then "add trade".
- Price, NAV and link forms move inside the holding screen as actions, not top-level screens.
- Target: halve the number of investment form screens on the app. The website gets the same single entry point.

**Done when:** adding a new holding with its first purchase is one flow on both clients.

## Phase 7: Family and first run (about 1.5 weeks)

- **Invites in the app:** the owner (an `is_admin` flag) adds or removes allowed emails from a settings page, replacing `app.cli create-user` for normal use. The CLI stays for recovery.
- **Data is per user**, as it is today. Sharing between users is out of scope until someone asks for it.
- **First-run setup:** a guided checklist for a user with no accounts: salary account, cards, loans, SIPs and investments, then turning on SMS (app). It can be skipped and resumed, and the dashboard shows how far it got.
- **Empty states** written for every screen (use the ux-copy guidance).

**Migration:** yes, for `is_admin`. Flag it.
**Done when:** a family member can be invited and reach a useful dashboard without the owner running a command.

## Phase 8: India tax view (about 2 weeks)

- **80C tracker** for the financial year (April to March): PPF, ELSS funds (needs an ELSS flag on funds), life insurance premiums and EMI principal on home loans, against the ₹1.5 lakh limit.
- **Capital gains summary** for the financial year: short and long term for stocks, equity funds, debt funds and crypto, from the FIFO lots already built. Each section shows the rule and holding period it used. Shown as information for filing, not tax advice.
- CSV export of both for the ITR.

**Done when:** the FY capital gains match a hand calculation for a test portfolio.

## Phase 9: Production hardening (remaining Milestone 9)

- Security review, structured logs, Android release build with crash reporting (Sentry from Phase 1).
- **Device test session:** clear the whole pending device-check list. Phases 1 to 8 add Android code nobody has run on a phone, so the longer installing waits, the bigger this session gets. The owner can pull it earlier at any time.

## Later, not planned

- Android home-screen widget (today's spending and quick add)
- PDF monthly and yearly reports
- Split and shared expenses between family members
- The paused asset types (ETFs, gold, vehicles, property, jewellery), after Phase 4

## Order at a glance

| # | Phase | Size | Migration |
|---|---|---|---|
| 0 | Make the documents true | ½ day | No |
| 1 | Safety net | 1 wk | No |
| 2 | Monthly cash flow | 2 wk | Yes |
| 3 | Budgets and what's coming | 1.5 wk | Yes |
| 4 | Net worth over time and ledger decision | 1 wk | Yes |
| 5 | Less work to keep it updated | 1.5 wk | Yes |
| 6 | Simpler investment entry | 1 wk | No |
| 7 | Family and first run | 1.5 wk | Yes |
| 8 | India tax view | 2 wk | Small |
| 9 | Production hardening and device test | 1 wk+ | No |

About 13 weeks of solo work. Phases 0 to 4 (about 6 weeks) fix everything the review called critical.
