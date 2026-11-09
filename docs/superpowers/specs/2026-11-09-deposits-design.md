# PPF and recurring deposits: design

## Why

The owner holds a PPF account and a recurring deposit (RD). Today neither shows in the app: money leaves the bank for them and nothing records what it became, so net worth is understated and nothing tells the owner when an RD instalment is due, how much PPF room is left this year, or what either will be worth at maturity.

Both are **deposits**: money paid in on a schedule, at a fixed rate, until a maturity date, with a value that comes from interest rather than a market price. That is why they share one design. This is part of Milestone 3 ("fixed and recurring deposits") in the [roadmap](../../product/roadmap.md), done now after [mutual funds](2026-11-09-mutual-funds-design.md) because it is what the owner holds.

Order of the remaining holdings (Claude's call): deposits (this spec), then crypto, then health insurance with recurring reminders, then the emergency fund goal. See the end for the follow-ups moved to later specs.

## Decided with the owner

- PPF: yearly deposits, interest compounded annually, 15-year lock-in.
- RD: a fixed monthly deposit, a fixed rate, quarterly compounding, a maturity date.
- Everything else was left to Claude ("do what's best"). Those calls are listed at the end.

## Model

### A deposit is an account

PPF and RD become two new account types, `ppf` and `rd`, the way loans became type `loan`. They are assets: their balance counts in "You have" and in net worth, and it can't go below ₹0.

The balance is what the passbook says: **deposits plus interest credited, minus withdrawals**. It moves only through ordinary transactions:

| Event | Transaction | Effect |
|---|---|---|
| Deposit (PPF payment, RD instalment) | `transfer` from a bank (only a bank) to the deposit | bank down, deposit up, net worth unchanged |
| Interest credited | `income` into the deposit, category "Interest" | deposit up, counts as income |
| Withdrawal, maturity payout | `transfer` from the deposit to a bank | deposit down, bank up |

Because deposits are transfers, the bank account's transactions list already shows every deposit. No new movement source is added to the balance code.

A deposit accepts only those three. An `expense`, an `emi`, or a transfer *from* a deposit *to* anything but a bank is refused with "A PPF account only takes deposits, interest and withdrawals to a bank." (or "An RD …").

### Fields

Stored as columns on `accounts`, like the loan fields. Existing columns are reused where the meaning matches.

| Field | PPF | RD | Meaning |
|---|---|---|---|
| `institution` | optional | optional | bank or post office |
| `interest_rate` | required | required | annual %, 0–100, ≤ 2 decimals (existing column) |
| `opened_on` | required | required | **new** `Date`. The real opening date, not today; ≤ today |
| `pay_from_id` | optional | required | the bank deposits come from (existing column). Must be an active `bank` |
| `deposit_amount` | — | required | **new** `Numeric(14,2)`, the monthly instalment, > 0 |
| `due_day` | — | required | instalment day, 1–31, clamped to the month (existing column) |
| `tenure_months` | — | required | **new** `Integer`, 1–120 |
| `deposits_paid` | — | required, ≥ 0 | instalments paid so far, ≤ `tenure_months`. Stored as **new** `deposits_at_opening Integer` = `deposits_paid` − the months with a transfer recorded, the way a loan's `emis_left` is stored |
| `balance` | required | required | as for every account: the balance today, which sets `opening_balance` |

Every account response gains `opened_on`, `deposit_amount`, `tenure_months` and a `deposit` object (below), all null except for these two types. Fields that don't belong to a type are refused, as they are today.

### Maturity

- **PPF** matures 15 full financial years after the end of the financial year it was opened in. Opened on any date in FY Y–(Y+1), it matures on **1 April (Y+16)**. Opened 10 Jun 2020 → matures 1 Apr 2036.
- **RD** matures `tenure_months` months after `opened_on` (day clamped to the month's length). Opened 15 Jan 2026 for 24 months → matures 15 Jan 2028.

Extending a PPF in 5-year blocks, premature closure and partial withdrawal rules are non-goals. A transfer out before maturity is allowed (the owner may have taken a permitted withdrawal); the app doesn't police lock-in, it shows it.

### What the app works out: the `deposit` object

Every figure here is computed on request, never stored, from the account and its transactions. Rates use `Decimal`, and every money figure is rounded half up to paise at the end of its calculation, not along the way.

The **balance on a date** is `opening_balance` plus the deposit's transactions dated on or before it. The opening balance is treated as present from the start.

#### PPF

| Field | Meaning |
|---|---|
| `maturity_date` | as above |
| `deposited_this_year` | transfers into the PPF dated in the current financial year (1 Apr – 31 Mar, India's date) |
| `year_limit` | `"150000.00"`. Shown, not enforced: the bank enforces it, and the limit can change |
| `interest_this_year` | the estimate below, for the current financial year up to today |
| `interest_due` | null, or `{ "year": "2026-27", "amount": "…" }` (below) |

**Interest estimate.** PPF interest for a month is `rate ÷ 12 ÷ 100 × the lowest balance between the end of the 5th and the end of the month`. A deposit made on or before the 5th earns for that month; one made after doesn't. The year's interest is the sum of the months from April to March, rounded once to paise, and is credited on 31 March. A month counts once today has reached its last day, so on 31 March the whole year is in.

Worked example, rate 7.1%: balance ₹1,00,000 on 1 April, ₹50,000 deposited on 10 April. April earns on ₹1,00,000 (₹591.67), May to March earn on ₹1,50,000 (₹887.50 × 11 = ₹9,762.50). The year's interest is **₹10,354.17**. Deposited on 4 April instead, every month earns on ₹1,50,000: **₹10,650.00**.

**Interest due.** From 31 March, the year just ended is due when:
- that year ended on or after the date the account was added to the app (`created_at`, India's date), so interest already in the opening balance is never asked for again, and
- no `income` into the PPF is dated between 31 March of that year's end and 30 March a year later.

`amount` is that year's estimate. The screens show "PPF: record interest for 2026-27, about ₹10,354.17", and recording opens an income form pre-filled with that amount, the date 31 March, category "Interest" and the PPF as the account. The owner corrects it to the passbook figure.

#### RD

| Field | Meaning |
|---|---|
| `maturity_date` | as above |
| `deposits_paid` | `deposits_at_opening` + the number of months with a transfer into the RD |
| `deposits_left` | `tenure_months − deposits_paid`, never below 0 |
| `deposited` | the sum of transfers into the RD plus `deposits_at_opening × deposit_amount` |
| `interest_so_far` | estimate, below |
| `value_today` | `balance + interest_so_far` |
| `maturity_value` | estimate, below |
| `due` | the due instalment months, oldest first (below) |

**Quarterly compounding.** With `q = 1 + rate ÷ 400`, an amount held for `m` whole months grows to `amount × q^(m ÷ 3)`. This is the formula Indian banks publish for RDs.

- `maturity_value` = Σ over k = 1…n of `deposit_amount × q^((n − k + 1) ÷ 3)`, with n = `tenure_months`. That is what the RD pays if every instalment is paid on time. Examples: ₹1,000 a month for 12 months at 6.8% → **₹12,448.73**. ₹5,000 for 24 months at 7% → **₹1,29,098.90**.
- `interest_so_far` = Σ over every instalment paid of `amount × (q^(m ÷ 3) − 1)`, where m is the whole months from the instalment's date to today (or to the maturity date, if that is earlier), **minus the interest already recorded into the RD**, never below 0. Some banks credit RD interest to the passbook every quarter; subtracting what's recorded keeps `value_today` right whether or not the owner records those credits. The `deposits_at_opening` instalments are dated `opened_on`, `opened_on` + 1 month, and so on. Each recorded transfer in uses its own date and amount. Example: four ₹5,000 instalments at 7% held 3, 2, 1 and 0 months, nothing recorded yet → ₹174.66.
- The interest maths lives in one module with one function per figure, so a bank whose method differs (completed quarters only, rounding each quarter) can be matched by changing that function alone.

Both are labelled as estimates. The bank's own figure wins: at maturity the owner enters what was actually paid.

**Instalments due.** Like a SIP, an RD instalment **never posts on its own**. Month i (0-based, i = 0 is the month of `opened_on`) is checked when i ≥ `deposits_at_opening` and i < `tenure_months`. It is due when its instalment day (clamped) is on or before today and no transfer into the RD is dated in that calendar month. Missed months stay due until recorded. The screens show one line per RD: "SBI RD: ₹5,000 instalment due since 15 Nov. Record it." with "(2 months)" when more are due. Recording opens a transfer form pre-filled with: from `pay_from_id`, to the RD, the amount, and the oldest due month's instalment date.

**Closing at maturity.** "Close RD" (offered from the maturity date on, and also earlier for premature closure) asks for the amount received, the date (default today) and the bank (default `pay_from_id`). It records, in one request:
1. an `income` into the RD of `received − balance`, category "Interest", when that is above 0,
2. a `transfer` of `received` from the RD to the bank,
3. archives the RD.

If `received` is below the balance (penalty on premature closure), step 1 is skipped and the shortfall is recorded as an `expense` from the RD, category "Fees and charges" (the existing category), before the transfer, so the RD ends at exactly ₹0. This is the one expense a deposit can carry; it is created only by Close RD. The pre-filled amount is `maturity_value`. TDS isn't modelled: the owner enters what reached the bank.

PPF closure is a non-goal (it is 2036 or later for any PPF the owner can hold today); a transfer out and archive does it by hand.

### Adding an existing deposit

The account form takes the balance today, `opened_on`, and, for an RD, the instalments already paid. Nothing is debited from the bank for the past, exactly as an opening balance works for any account. For the most accurate PPF interest estimate in the current year, the owner can instead enter the balance on 1 April and record this year's deposits as transfers; the import below does that for the owner's own accounts.

### Rules elsewhere

- A bank can't be archived while it is the `pay_from_id` of an active RD. The message names the RD. An active PPF's `pay_from_id` is cleared instead, since it is only a default.
- A PPF or RD can't be archived while its balance is above ₹0: "Withdraw the balance from {name} before archiving it." (Close RD archives on its own.)
- Income into a deposit must be category "Interest".

## Net worth and dashboard

- A deposit's **balance** counts in "You have" and in net worth: `ppf` and `rd` join the asset types.
- The estimated interest not yet credited does **not** count in net worth. It is shown next to the balance as "+ ₹X interest so far (estimate)". Net worth is built from recorded figures only, the same rule that keeps a fund at cost until a NAV is recorded.
- The dashboard is unchanged, apart from net worth now including the deposits.

## API

The builder shapes these in the style of the accounts and loans routes. They need to cover:

- Accounts: types `ppf` and `rd` with the fields above, on create, edit and in every response, plus the `deposit` object.
- Transactions: the deposit rules above. `Interest` is already an income category and `Fees and charges` an expense category; no new categories.
- `POST /accounts/{id}/close-rd` with `amount`, `date` and `account_id`, all-or-nothing.
- A way for the screens to get every due item (RD instalments and PPF interest) without one call per account; the account list response carrying the `deposit` object is enough.
- The Android app already installed must keep working. It must not crash on the new account types: it reads `type` as a string, and old builds will show the new types without their figures. The builder checks how the current app handles an unknown type, and makes the API response safe for it if needed.

## Clients

Each platform gets its own UI on the shared backend, never a copy of the other.

- **Web:** the Accounts page gains a **Deposits** group. A PPF row shows balance, interest this year (estimate), "₹X of ₹1,50,000 this year" and the maturity date. An RD row shows balance, instalments paid/left, value today (estimate), maturity value and date. Due lines (RD instalment due, PPF interest to record) sit at the top of the page, each with its action. The account dialog gains both types and their fields. Actions: Deposit (a transfer pre-filled into the deposit), Record interest, Record instalment, Close RD.
- **Android:** the Accounts tab gains the same group as its own cards, due cards at the top, the new types on the account form, and phone forms for deposit, instalment, interest and Close RD. Recording an instalment is one tap to open and one to save.
- Both clients only display the server's figures. No interest arithmetic in a client.

## Importing the owner's accounts

After deployment, the owner's PPF and RD go in through a reviewed SQL script, as before, tested on the dev database with a rollback first, and run by the owner. It needs from the owner's passbook and RD advice:

- **PPF:** bank, opening date, current rate, the balance on 1 April 2026 (after the 2025-26 interest), and each deposit since then with its date and amount.
- **RD:** bank, opening date, monthly amount, debit day, tenure, rate, the maturity amount on the bank's advice, and the instalments paid so far.

The PPF goes in with the 1 April balance as its opening balance and this year's deposits as transfers from the bank. **The bank's balance today must not change**, so the script raises the bank's opening balance by the same total. The RD goes in with its paid instalments as `deposits_at_opening` and the balance as its opening balance, with no transfers. The RD's maturity amount checks the formula. **The bank's figure is the reference**: the build is tested against the worked examples above, and before merging, the owner's RD terms are run through `maturity_value`. If it differs from the bank's advice by more than ₹1, the interest function is changed to the bank's method (see above) before the merge, not after.

## Non-goals (for now)

- Fixed deposits (one lump sum; the next natural addition to this model), Sukanya Samriddhi, NSC, EPF.
- Interest rate history: one rate per account, edited when the government or bank changes it. The PPF estimate uses today's rate for the whole year.
- PPF extension, withdrawal and loan rules; RD penalty calculation; TDS; tax (80C) reports.
- Phone notifications.
- Counting estimated interest in net worth.

## Follow-ups moved to later specs

From the mutual funds review. None of them touches deposits, so they go with the work that touches their code:
- **Crypto spec:** the bank account page doesn't list fund or stock debits; the web Investments page fails as a whole if the fund endpoints error; a SIP moving bank can show unlinked old-bank months as due again; `update_sip` reads the SIP before locking accounts; the missing test for a hand-entered NAV on the same date.
- **Owner's phone test** (unchanged): NAV autofocus on Record SIP, and the return after deleting a fund.

## Design calls made by Claude ("do what's best"), not yet confirmed by the owner

1. **PPF and RD are account types**, not instruments. A passbook is an account with a balance, and transfers already move money without touching net worth.
2. **Deposits are transfers, interest is income** ("Interest"), payouts are transfers. No new movement types.
3. **Estimated interest is shown, not counted in net worth.** Net worth uses the passbook balance.
4. **RD instalments remind instead of posting**, with missed months staying due, like SIPs.
5. **PPF interest reminders** start with the first financial year ending after the account was added, so interest already in the opening balance isn't asked for again.
6. **The ₹1,50,000 PPF limit is shown, not enforced.**
7. **Lock-in is shown, not enforced.** Transfers out before maturity are allowed.
8. **Close RD** records the interest (or penalty) and the payout in one step and archives the RD.
9. **RD maturity uses the published quarterly formula**, checked against the owner's RD advice before merging.
10. **Fields live on `accounts`**, following the loans precedent.
11. **The order of the remaining work**: deposits, crypto, health insurance with recurring reminders, emergency fund.
12. **RD interest so far subtracts interest already recorded**, so quarterly passbook credits are never counted twice.
13. **Only a bank can pay into a deposit**, and a penalty on closing goes to "Fees and charges".
14. **The bank's RD maturity figure is the reference**; a mismatch above ₹1 changes the formula before merging.
