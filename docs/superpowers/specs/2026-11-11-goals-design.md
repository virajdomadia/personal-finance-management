# Goals and baskets: design

## Why

The owner wants to save toward things and see how far along each saving is, starting with an **emergency fund**. They don't have one yet. They'll build it in their current bank account rather than in a separate account or fund. In their words: "will save in current bank account, will create a basket of EF and keep the amount in the app… it will only reflect in the bank account only, just will see in the app that we have x amount as EF."

So a goal never holds money. It is a **label on money the owner already has** (vision: "a goal is not an account"; database design: "A goal points at existing accounts. It never holds money itself."). This is Milestone 7 of the roadmap.

## Decided with the owner

- **A goal has a basket.** The basket is the money set aside for it. The owner decides what goes in each basket, and the app doesn't restrict where it comes from.
- **Bank money is earmarked, not moved.** "₹50,000 of my bank is EF" creates no transaction and no account.
- **The bank shows less.** A bank with ₹80,000 and ₹50,000 earmarked shows **₹30,000** as its headline figure ("for me in the app show money less in bank account").
- **A basket can also hold whole holdings** (a fund, a stock, a coin, a PPF, an RD), each counted at its current value.
- **Goals are custom.** The owner creates each one: a name, a target and a basket. The emergency fund is the same format.
- **The emergency fund's monthly expenses come from the app**, worked out from what's recorded.
- **The number of months isn't decided yet** ("will see"), so it's a setting.
- Everything else was left to Claude ("do what's best"). Those calls are listed at the end.

## Goals

| Field | Meaning |
|---|---|
| `name` | 1–60 characters, e.g. "Emergency fund", "Bike" |
| `kind` | `custom` or `emergency`. At most one active `emergency` goal per user. |
| `target_amount` | custom goals: required, > 0, 2 decimals. Emergency fund: not stored; computed (below). |
| `target_date` | optional |
| `ef_months` | emergency fund only: 1–24, default **6** |
| `ef_monthly_override` | emergency fund only, optional: the owner's own monthly expense figure, used instead of the computed one |
| `monthly_amount` | optional: how much the owner means to set aside each month. Turns on the monthly reminder. |
| `reminder_day` | 1–31, clamped to the month's length. Required when `monthly_amount` is set. |
| `note` | optional free text |
| `archived` | archived goals keep their history but count for nothing (below) |

### The emergency fund's target

```
target = ef_months × monthly expenses
monthly expenses = ef_monthly_override, if set
                 = otherwise, the average of the last 6 full calendar months (India's date)
```

The current month is never in the window. Neither is any month before the owner's first recorded transaction, nor the month of that first transaction unless it's dated the 1st, because a part-recorded month would pull the average down. *Claude's call.* So with 2 fully recorded months, the average is over those 2. With no full month, there's no computed figure. The goal then shows "Not enough history yet: enter your monthly expenses" and has no target until an override is set.

A month's expenses are what the transactions list already counts as spending (every `expense`, on any account including cards), **plus the full amount of every EMI** (principal and interest), because an EMI still has to be paid in a bad month. Transfers, investment trades, deposits into a PPF or RD, and income (refunds included, which are recorded as income today) don't count. The goal shows the figure it used and the months it averaged ("₹32,400 a month, average of Jun–Oct").

## Baskets

A basket has two kinds of item.

### 1. Earmarked money (`goal_earmarks`)

An append-only list of entries: goal, account, signed amount (+ set aside, − released), date, optional note. A goal's earmark in an account is the sum of its entries for that account. Entries are created and deleted. They are never edited, so the history stays readable. *Claude's call.*

- **Allowed accounts:** active `bank`, `cash` and `wallet` accounts, i.e. spending money. Investment and deposit accounts go in as whole holdings instead.
- **Set aside** adds a + entry. **Release** adds a − entry, and can't take a goal's earmark in an account below zero.
- One account can have money earmarked for several goals.
- **Using the money** (e.g. spending part of the EF on a hospital bill) means two separate steps: release it from the goal, then record the expense as usual. The release form can say "Release and record an expense" to open the expense form pre-filled with the same account and amount, but the two stay separate records. *Claude's call.*

### 2. Whole holdings (`goal_holdings`)

A row linking a goal to either an **instrument** (a stock, fund or coin, all units across all accounts) or a **deposit account** (a PPF or RD). It counts at its current value: market value from the latest recorded price, or cost before a price exists, exactly as the portfolio shows it, and a PPF or RD at its balance (never the interest estimate).

- **A holding belongs to one active goal at most** (a unique constraint where the database can express it, plus a check). This is the only rule about what goes where: the same money can't count twice.
- Adding the **Bank of India RD** is allowed even though it is the Care Health policy's `funded_by`. The RD stays linked to the policy too, and the goal shows the note "Also funds the Care Health premium."
- A holding that's sold out or closed counts as ₹0, and the goal labels it "sold" or "closed" until it's removed from the basket.

### What a goal shows

- **Saved** = earmarked money + holdings' current value.
- **Progress** = saved ÷ target, shown as a bar. It can pass 100%, and at that point the goal shows "Reached".
- **With a target date:** months left (counting the current month), and **"Set aside ₹X a month to reach it"** = (target − saved) ÷ months left, rounded up to the rupee. If the date has passed and the target isn't reached, it says so.
- The basket: each earmark by account, each holding with its value, and the earmark history.

## The bank shows less

`GET /accounts` keeps `balance` as the real balance, so the bank statement still matches, balance corrections still work, and the installed app keeps working. Each account gains:

- `set_aside`: the sum of active goals' earmarks in it (`"0.00"` when none),
- `free_balance`: `balance − set_aside`.

Both clients show **`free_balance` as the account's headline figure**, with "₹80,000 in the bank · ₹50,000 set aside for goals" in small text beneath. Balance correction forms still edit the real balance.

If `set_aside` is more than `balance` (the owner spent the earmarked money), `free_balance` goes negative. The account and every goal with an earmark there show a warning: "₹X more is set aside than this account holds". The warning only informs. Nothing is released automatically.

**Net worth, `total_have` and `total_owe` are unchanged.** Goals only label money. *Claude's call:* the dashboard's totals stay as they are, and the dashboard gains a small goals summary (each active goal's saved, target and progress).

## Monthly reminder

A goal with `monthly_amount` shows in the existing due list (`GET /recurring/due`, the dashboard and transactions screens) as "Set aside ₹X for {goal}". It's due from `reminder_day` of the month until the goal's set-aside entries dated in that month add up to `monthly_amount`. It starts in the month the reminder was turned on. **Record** opens the set-aside form pre-filled.

*Claude's call:* only the current month is ever due. A missed month doesn't pile up the way SIPs and RD instalments do, because setting money aside has no fixed bill behind it. There's no Skip. Turning the reminder off (clearing `monthly_amount`) is the way to pause it. A reached goal's reminder stops showing.

## Archiving and deleting

- **Archiving a goal** releases nothing in the history. Its earmarks just stop counting toward any account's `set_aside`, and its holdings are free to join another goal. Restoring it counts them again. That can make an account over-set-aside (the warning shows), and it's refused if one of its holdings has since joined another active goal ("{holding} is in {goal} now").
- **Deleting a goal** is allowed only when it has no earmark entries. Otherwise, archive it.
- **Archiving an account** with active earmarks is refused: "₹X of this account is set aside for {goals}. Release it first." Archiving a PPF or RD that's in a goal (Close RD archives it) is allowed. The goal then labels it "closed" (above).

## API

The builder shapes these in the style of the existing routes:

- Goals: list (each with saved, target, progress, monthly figures and basket), get one (with earmark history), create, edit, archive, restore, delete.
- Earmarks: create (set aside or release) and delete an entry.
- Holdings: add to and remove from a goal.
- `GET /accounts` gains `set_aside` and `free_balance` per account, as new keys only.
- `GET /recurring/due` and the dashboard gain goal reminders under a **new key** (e.g. `goals_due`), never inside the existing `items`. The installed app reads `item.template` on every item, so a goal item there would crash it.
- The dashboard gains a `goals` key.

## Clients

Each platform gets its own UI on the shared backend.

- **Web:** a **Goals** page with a card per goal (progress bar, saved/target, months left and "₹X a month", warnings, an "Emergency fund" badge showing how its target was worked out), a goal page (basket, earmark history, Set aside / Release / Add holding), create and edit forms, and an archived section. Accounts show the free balance as the headline. Investment and deposit pages tag a holding that's in a goal ("For: Bike").
- **Android:** the same features laid out for a phone: a Goals screen reached from the dashboard's goals summary (the builder picks where it lives in navigation without crowding the tab bar), a goal screen, and bottom-sheet or full-screen forms in the app's existing style. Accounts show the free balance.

## Follow-ups folded in

1. **An archived account's reminder stays due.** The archive check above touches the same code. SIP, RD and plain recurring-template reminders whose account is archived stop showing as due. The builder confirms which reminders are affected and how the account's archive should suppress them. **A policy's premium reminder is the exception**: the owner's rule is that only lapsing a policy stops its reminder. So archiving an account that an active policy pays from is refused: "This account pays the {insurer} premium. Change the policy's paying account or lapse the policy first." *Claude's call.*
2. **Archive lock race.** Archiving a bank while a PPF is being repointed to it can race. Since account archiving gains goal and policy checks here, lock every row involved (the account, its PPFs or RDs, its goals' earmarks and the policies it pays) in ascending id order, in one place.
3. **No un-skip button.** The backend can already un-skip a recurring occurrence. Both clients gain a way to see skipped occurrences of a template and undo one.
4. **A SIP moved to another bank can show old months as due again.** Due months must count purchases for that SIP regardless of which bank paid them. The builder reproduces it with a test first.

## Importing the owner's data

Nothing to import. The owner has no emergency fund yet and creates goals in the app.

## Non-goals

Moving money (goals never create transactions); automatic setting aside; phone notifications; inflation-adjusted targets; projected growth of holdings toward a date; sharing a holding between goals by percentage; goal categories or icons; counting goals in net worth.

## Design calls made by Claude ("do what's best"), not yet confirmed by the owner

1. **The emergency fund starts at 6 months**, editable from 1 to 24.
2. **Monthly expenses are the average of the last 6 full months**, using what history exists, counting expenses plus full EMI payments. The owner can override the figure.
3. **Earmarks come from bank, cash and wallet accounts**. Investments and deposits go in as whole holdings.
4. **Earmark entries are append-only** (set aside, release, delete an entry). They are never edited.
5. **A holding belongs to one active goal at most.** It's the only placement rule.
6. **The RD can join a goal and stay the policy's funding.** The goal notes it.
7. **Using the money is release + an ordinary expense**, with an optional pre-filled shortcut.
8. **Over-set-aside only warns.** Nothing is released automatically.
9. **The monthly reminder is due only in the current month**, has no Skip, and stops once the goal is reached.
10. **`balance` stays the real balance in the API.** `free_balance` is a new field, which the clients show as the headline.
11. **Archiving an account with earmarks is refused** until they're released. A closed PPF or RD in a goal counts as ₹0 and is labelled.
12. **The dashboard gains a goals summary.** Totals and net worth are unchanged.
13. **All four open follow-ups are folded in.** They touch archiving, reminders and SIP due months, which this work already changes or sits beside.
14. **The first, part-recorded month is left out of the expense average** unless the first transaction is on the 1st.
15. **An account that pays an active policy's premium can't be archived**, so its reminder is never hidden by an archive.
16. **Goal reminders use a new key in the due list**, so the installed app doesn't crash.
