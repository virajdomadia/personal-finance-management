# Recurring reminders and health insurance: design

## Why

The owner pays a yearly health insurance premium and wants the app to remember it: when it's due, how much, what it covers, and that the money for it is being saved in an RD. Today nothing in the app knows about it, and nothing reminds the owner about any regular payment except SIPs and RD instalments.

The roadmap already plans the general tool for this: **recurring templates** (Milestone 2: "salary, rent, subscriptions, EMIs that remind and pre-fill, never auto-post"). This design builds that tool, and health insurance as its first real user. Insurance is **not an investment** and has no value in net worth.

### The owner's policy (policy certificate, issued 6 Apr 2026)

| | |
|---|---|
| Insurer | Care Health Insurance |
| Plan | Care Supreme, with add-on Care Advanced (Claim Shield) |
| Policy no. | A3859370 |
| Cover | Individual: the owner. Nominee: mother. |
| Sum insured | ₹10,00,000 |
| Bonus | Cumulative bonus 50% of SI a year, up to 100%; Cumulative Bonus Super, up to 500% |
| Optional covers | Annual health check-up, wellness benefit, air ambulance (up to ₹5 lakh) |
| Period | 07 Apr 2026 to 06 Apr 2027 (midnight) |
| Premium | ₹11,936.00 a year (GST ₹0), single premium, paid 6 Apr 2026 by online payment |

### How the owner pays it (their words)

"I pay premium from CC and pay CC through RD, extra money keep for myself."

1. At renewal the premium goes on the **Federal Signet** credit card: an expense on the card.
2. The **Bank of India RD** (₹1,500 a month on the 19th, 12 months, 6.5%, opened 19 May 2026) is the money set aside for it. It matures on **19 May 2027**, about **₹18,643** (estimate).
3. The RD pays out to the bank (Close RD, already built), and the card bill is paid from the bank (a transfer, already works).
4. What's left over stays with the owner.

Note the gap: the premium is charged around 6 April, while the RD matures on 19 May.

## Decided with the owner

- Health insurance is a yearly premium plus a renewal date and cover details. It is not an investment.
- It's built on recurring templates that **remind and pre-fill, never post on their own**.
- The premium goes on the Federal Signet card; the RD funds it; the card is paid from the bank.
- Everything else was left to Claude ("do what's best"). Those calls are listed at the end.

## Recurring templates

A template is a standing description of a regular money movement that the owner records by hand when it happens.

| Field | Meaning |
|---|---|
| `name` | e.g. "Health insurance premium", "Rent". 1–60 characters. |
| `type` | `expense`, `income` or `transfer` |
| `amount` | expected amount, > 0, 2 decimals. Pre-filled, editable when recording. |
| `account_id` | the account it's paid from (expense, transfer) or into (income). Active, the owner's. |
| `to_account_id` | transfers only: the account it goes to |
| `category` | expense and income only, from the same categories as transactions |
| `note` | optional, pre-filled into the transaction |
| `frequency` | `monthly` or `yearly` |
| `day` | 1–31, clamped to the month's length |
| `month` | yearly only: 1–12 |
| `start_date` | first occurrence on or after this date |
| `end_date` | optional; no occurrences after it |
| `remind_days` | how many days before an occurrence it starts showing as "coming up": default 3 for monthly, 30 for yearly, 0–60 |
| `active` | the owner can pause or stop a template; past records stay |

Transactions gain a nullable `recurring_template_id`. A transaction recorded from a template carries it.

A template is checked with **the same rules as a transaction** (one shared validator): account types, deposit rules (for example, a transfer into an RD only from a bank), categories and amounts. A template that could never be recorded is refused when it's saved, not when it's recorded. *Claude's call.*

### Occurrences and what shows

Each occurrence has a date: monthly on `day` of every month, yearly on `day` of `month` every year (clamped), from `start_date` to `end_date`. An occurrence is **recorded** when a transaction with this `recurring_template_id` is dated in the same calendar month (monthly) or within 45 days either side of the occurrence date (yearly, because renewals are often paid a little early or late).

- **Due:** an unrecorded occurrence dated on or before today (India's date). Missed ones stay due, oldest first, as SIPs and RD instalments do.
- **Coming up:** the next unrecorded occurrence within `remind_days` after today.
- A stopped template is never due or coming up.

**Record** opens the transaction form pre-filled from the template (type, amount, accounts, category, note, and the occurrence date, or today if that's later). The owner can change anything. Nothing is ever posted without the owner saving it. **Skip** marks one occurrence as not happening (e.g. a month without rent) by storing it in a small `recurring_skips` table (template, occurrence date), so it stops showing.

Templates appear on the dashboard and on the transactions screen as "Due" and "Coming up" lines, with Record and Skip, on both clients. SIPs and RD instalments keep their own reminders; they are not turned into templates.

## Insurance policies

A policy is a record of cover. It holds no money and isn't counted in net worth.

| Field | Meaning |
|---|---|
| `kind` | `health` (others, such as life or motor, may come later) |
| `insurer` | e.g. "Care Health Insurance" |
| `plan` | e.g. "Care Supreme + Care Advanced" |
| `policy_number` | e.g. "A3859370" |
| `insured` | who's covered, free text: "Self" |
| `sum_insured` | ₹, 2 decimals |
| `period_start`, `period_end` | the current policy year: 2026-04-07 to 2027-04-06 |
| `premium` | the current yearly premium, ₹ |
| `template_id` | the yearly recurring template that reminds about the premium |
| `funded_by_id` | optional: the account set aside to pay it, e.g. the RD |
| `details` | optional free text for cover notes: bonus, add-ons, waiting periods, nominee |
| `active` | false once the policy lapses or is cancelled |

Creating a policy creates its template in the same request: a yearly `expense` named "{insurer} premium", category **Insurance**, amount `premium`, paid from the account the owner picks (the Federal Signet card), on the day and month of `period_end`, `remind_days` 30, with `start_date` = `period_end` (the next renewal; for the owner, 6 Apr 2027, showing from 7 Mar 2027).

The policy also gets its first `policy_periods` row for the current period (below), with the premium and the date it was paid. If that payment is already in the app, it links that transaction. Otherwise, as for the owner's 6 Apr 2026 payment made before using the app, it stores the paid date and amount with no transaction ("Paid before using the app"). The policy and its template stay in step: changing the premium, the paying account or the period updates the template.

### Renewal

**Renew** is one form and one request. It's what Record opens for a policy's reminder, and it's also on the policy page. It asks for:
- the payment: date, amount (pre-filled: the premium) and paying account (pre-filled: the template's);
- the new period (pre-filled: the next year's dates);
- the new sum insured (pre-filled: the same).

Saving does both things atomically: it creates the premium `expense` linked to the template, and it adds a `policy_periods` row (period, premium, sum insured, paid date and the transaction). The policy then moves to the new period. Either both happen or neither does.

The plain transaction form can't link to a policy's template ("Renew the policy instead."), so a premium can't be recorded without the period moving on. *Claude's call.*

The policy page shows the `policy_periods` history.

### Funding check

If the policy has `funded_by_id` and it's an RD that hasn't been closed:

- The policy shows: "Funded by Bank of India RD: matures 19 May 2027, about ₹18,643 — covers the ₹11,936 premium" (or "₹… short" if the estimate is less than the premium).
- If the premium's paying account is a credit card with a statement day and due day, the app works out when the bill for a charge on the renewal date falls due: the first statement date on or after the charge, then the next due day after that statement. If that due date is before the RD's maturity date, the reminder and the policy say: "This premium's card bill is due {date}, before your RD matures on 19 May. Plan to pay it from the bank." This only informs; it never moves money.

### Tax figure

The policy page shows the premium paid in each financial year, summed from its `policy_periods` rows by their paid date. That covers the period paid before the app ("Premium paid in FY 2026-27: ₹11,936 — usually deductible under section 80D"). The next renewal, paid around 6 Apr 2027, falls in FY 2027-28. No tax calculation beyond that.

## API

The builder shapes these in the style of the existing routes:

- Templates: list (each with its due and coming-up occurrence dates), create, edit, stop/restart, delete (only when no transaction uses it; otherwise stop it), and skip an occurrence.
- `GET /recurring/due`: everything due or coming up, for the dashboard and lists.
- Transactions accept an optional `recurring_template_id` on create and edit (it must be the owner's template, and the transaction's type must match the template's). Existing transaction responses gain the field; nothing else changes, so the installed app keeps working.
- Policies: list, create (with its template), edit, renew (records the period change after the premium is recorded), lapse, delete (only when its template has no transactions).
- The dashboard gains a `recurring` list (due and coming up), as a new key.

## Clients

Each platform gets its own UI on the shared backend.

- **Web:** a **Recurring** page (templates and what's due), an **Insurance** page (policy cards: insurer, plan, sum insured, premium, renewal date with days left, funding line and card-bill warning, premium history, 80D figure), and due/coming-up lines on the dashboard and transactions page with Record and Skip.
- **Android:** the same features laid out for a phone: due and coming-up cards on the dashboard, a Recurring list with forms, and an Insurance screen. Record opens the existing transaction form pre-filled.

## Importing the owner's policy

No script needed: the owner adds the policy in the app (one form, from the certificate above), picks the Federal Signet card and the Bank of India RD, and enters the current period as paid on 6 Apr 2026 for ₹11,936 with no transaction (it was paid before the app). The first reminder is the 6 Apr 2027 renewal.

## Non-goals

Claims, cashless cards and hospital lists; family floater members as structured data; comparing plans; tax calculation beyond the FY premium figure; auto-posting anything; phone notifications; life, motor and other insurance kinds (the model allows them later); turning SIPs or RD instalments into templates; weekly or quarterly frequencies.

## Design calls made by Claude ("do what's best"), not yet confirmed by the owner

1. **Build general recurring templates now**, monthly and yearly, for expenses, income and transfers, so salary, rent, subscriptions and EMIs can use them too, with health insurance as the first user.
2. **A policy is its own record**, not an account or instrument, linked to a yearly template.
3. **The premium uses the existing "Insurance" category.**
4. **Yearly reminders start 30 days early**; monthly ones 3 days early. Both adjustable.
5. **A yearly occurrence counts as recorded** by a linked payment within 45 days of the date.
6. **Renewal moves the policy to the next period** and keeps the old periods as history.
7. **The funding check and card-bill warning** only inform, never move money.
8. **The owner enters the policy in the app.** The 6 Apr 2026 premium is stored as the first period's payment without a transaction, and it counts in the FY 2026-27 figure.
11. **Renew is one atomic form** (premium transaction + new period). A policy's template can't be linked from the plain transaction form.
12. **Templates are validated with the transaction rules**, so every template can actually be recorded.
9. **SIPs and RD instalments keep their own reminders.**
10. **Skip** exists for one-off missed occurrences.
