# Spend calendar — design (short)

## Why
The owner wants to see, day by day, how much they spent compared with what they can afford to spend
per day once fixed income and fixed outgoings are taken out. Example: salary 54,800 − rent 16,000 −
SIP 5,000 − PPF 3,000 = 30,800 free a month → 30,800 ÷ 31 = ₹994 a day in a 31-day month.

## Goals
- Fixed income and outgoings are entered once, with their dates, as **monthly Recurring reminders**
  (screen already exists on web and phone).
- **Daily amount** = (monthly income reminders − every other monthly reminder) ÷ days in that month.
  It stays the same for the whole month. It does not recalculate as spending happens.
- **Calendar**: a month grid where each past day and today shows what was spent that day, green if
  at or under the daily amount, red if over. Future days are blank. Tap a day to see its transactions.
- Header: free for the month, daily amount, spent so far, left for the month, and how far over or
  under the pace so far (daily amount × days elapsed − spent).
- Recurring screen gets a summary at the top: income − fixed = free, and the per-day figure.

## Non-goals
- Yearly reminders (insurance and so on) are not counted in the daily amount.
- No rollover of unspent daily amounts. Each day is judged on its own, and the month header covers the running total.
- No new way to enter fixed items. The existing reminder form is used.

## Anti-goals
- The daily amount must not jump mid-month because something got recorded. It depends only on the
  reminders, not on what actually happened.
- Rent, SIP, PPF or anything else that pays a fixed reminder must not show up as spending on the day it's paid.
  Otherwise rent day would always be red.

## Rules
- "Spent on a day" uses the same rule as Cash Flow (`cash_flow.spent`: expenses, EMI interest,
  minus refunds), **excluding** transactions that settle a monthly reminder counted as fixed. That
  covers transactions linked through `recurring_template_id` and payments matched to a reminder
  without a link (`reminder_payments` / `settle_unlinked`).
- The reminders that count for a month are the ones active in that month (start_date / end_date),
  so earlier months keep the daily amount they had.
- With no monthly income reminder, the calendar still shows daily spending, plus a prompt to add the
  salary in Recurring. There's no colouring and no daily amount.
- Negative free amount (fixed outgoings bigger than income): show it as negative, and colour every day with
  spending as over.

## Approaches considered
- **A. Work it out from the Recurring reminders (chosen).** There's one list of fixed items, already
  used for "Upcoming" and safe-to-spend, and the daily amount is steady.
- B. A separate fixed-budget list. Rejected: it duplicates the reminders, and the two would drift apart.
- C. Work it out from what actually arrived and was paid this month. Rejected: the daily amount would move
  mid-month, so a day could change from green to red after the fact.

## Shape
- Backend: one endpoint, `GET /calendar?month=YYYY-MM`, returning the monthly income, the fixed
  items (name and amount), free, daily amount, and per day {date, spent | null for future days}. Pure
  arithmetic is kept in a module like `app/api/cash_flow.py` so it's tested without a database.
- Web: a `/calendar` page in the nav, with previous and next month. Phone: a `calendar` screen reached
  from Home and Cash Flow. Tapping a day opens transactions filtered to that date.
- No database migration.

## Left to the builder
- The exact grid styling within the existing chunky UI on each platform, and how amounts are
  shortened (₹1.2k) in narrow cells.
- How to get the IDs of matched-but-unlinked reminder payments (`ReminderPayments` currently returns
  dates only).

---

## Part 2 (24 Nov): the calendar replaces the Recurring screen

**Why:** the owner wants one place for fixed money: "remove the recurring feature and add notification and CRUD of recurring with spending calendar".

**Decided by the owner:** the Recurring screen goes away on web and phone. Everything it did moves to the calendar. Yearly and stopped reminders live in an **"Other reminders"** list under "Your fixed money" (option 1). Reminders as data stay, because Upcoming, safe-to-spend, SMS matching and phone notifications all run on them.

**What the calendar gains**
- **Due now** (this month only): the existing due list with Done / Skip, as on the Recurring screen today.
- **Day markers:** every reminder occurrence in the month is marked on its day, either paid (tick), due (owed, today or earlier), coming, or skipped. Yearly ones show in their month.
- **Full CRUD** in both lists: add, edit, stop or restart, delete, and undo a skip. A policy's reminder still can't be deleted (it's changed from Insurance), exactly as today.
- **Your fixed money** = active monthly reminders, plus SIP plans (SIPs are still changed from Investments). **Other reminders** = yearly reminders and stopped ones.

**Notifications:** they stay scheduled on the phone from the reminders (no Firebase, no new native module). Due-reminder notifications now open the calendar. The old `/upcoming` link is still accepted, so notifications already scheduled keep working.

**Removed:** the web `/recurring` page (it now redirects to `/calendar`, and `?add=1` opens the add form), the sidebar entry, the Recurring view and its summary; the phone's `recurring` screen and its Profile entry (Profile now opens the calendar).

**Anti-goals:** no reminder data or behaviour changes; Upcoming and safe-to-spend are untouched.

**Approach (my call, as how-it-gets-made):** move the Recurring screen's list and its actions into a shared reminder-list component on each platform, rendered twice on the calendar with the templates split. The backend adds the month's reminder occurrences to `GET /calendar`.
