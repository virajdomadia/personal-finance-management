# Automation: transactions from bank SMS, and prices every night

Date: 2026-11-12. Status: Builds 2 and 3 implemented (branch sms).

## Why

The owner types everything into Gullak by hand: every expense, the rent, every SIP instalment, every trade and every price. That is the boring part, and boredom is what would make them stop using the app (the same worry behind the Gullak redesign). The goal is that most of Gullak fills itself in, and the owner only steps in for things the app can't know.

Two facts from the owner make this possible:

- About 9 payments in 10 are UPI, and the bank sends an SMS for **every** kind of transaction: UPI, card, NEFT/IMPS transfers, ATM, and auto-debits (EMIs, SIPs). Credit card spends also come by SMS.
- CDSL sends a day-end SMS when shares enter or leave the demat account.

This design was put ahead of the safety net, net worth history, everyday cash flow and reports work, at the owner's request. Those come next, as separate designs.

## Goals

1. **Bank and card transactions from SMS.** The Android app reads bank and card SMS and records the transactions in the right account.
2. **Categories that learn.** A payee seen before gets its category automatically. A new payee goes to a "To review" list, and the owner picks a category once.
3. **Regular payments tick themselves off.** Rent (a recurring template), EMIs, SIP debits, RD instalments and card bill payments are matched to what Gullak already knows.
4. **Investment prices every night.** Mutual fund NAVs, stock closing prices and crypto prices are fetched by the server, with no typing.
5. **Stock trades from the CDSL SMS** become drafts that the owner confirms after checking the price.

## Non-goals (for now)

- Crypto trades stay manual. The owner trades rarely and exchanges send no standard SMS. Crypto **prices** are automated.
- No reading of emails, PDF statements, CAMS/KFintech CAS files, or Account Aggregator APIs.
- No listening for SMS in the background while the app is closed. The app reads new SMS when it is opened or brought to the front (see "When SMS are read").
- No iPhone support. The SMS part is Android only.
- No Play Store release. The app is installed as an APK. Google Play restricts the SMS permission, so a Play release would need rethinking.
- The other improvement areas (export and backup, rate limiting and error monitoring, net worth history, quick-add, budgets, reports) are not part of this design.

## Anti-goals (a failure even if it works)

- **Money counted twice.** The same payment from a repeated SMS, from a bank SMS plus a card SMS, or from an SMS plus a manual entry must never appear twice.
- **Wrong money recorded silently.** If the app is unsure, it asks instead of guessing quietly.
- **Personal messages read or uploaded.** Only messages from banks, card issuers and CDSL are looked at. The raw SMS text never leaves the phone.
- **A balance that drifts from the bank.** Recorded money must match what the bank SMS said.

## Constraints

- Backend is FastAPI on Vercel (`personal-finance-api`), and the database is Neon Postgres. Every schema change is an Alembic migration that the **owner runs on Neon by hand before the merge** (the merge deploys automatically). The plan must flag this.
- New Vercel environment variables (such as a cron secret) are **set by the owner**. The plan says which ones and what value, and Claude doesn't set them.
- The Android app is Expo (SDK 58, expo-router, EAS builds with expo-updates). Reading SMS needs native code, so a **new APK** is required. The owner has put off phone installs until the app is "done" (see the pending device-check list), so the SMS part only goes live on the phone after that install. Everything server-side (prices, matching, the review list on the website) works before then.
- The website and the Android app each get their own UI for new screens. Neither copies the other.
- Money stays `Decimal`/`NUMERIC` end to end. No client-side arithmetic on amounts.
- The "remind, never post" rule for recurring templates and SIPs is **relaxed only when there's evidence**: a bank SMS showing the money actually moved. Without an SMS, templates and SIPs still only remind.

## How it works

### 1. Reading SMS on the phone

- **Opt-in.** A switch in the profile screen: "Fill in transactions from bank SMS". It explains what is read and asks for Android's SMS permission (`READ_SMS`). Off by default.
- **Which messages.** Only messages from bank, card, and CDSL senders. In India these come from sender IDs like `AD-BOIIND` or `VM-HDFCBK`. The app keeps a list of known sender IDs, and messages from anyone else are never opened.
- **When SMS are read.** When the app opens or comes back to the front, it reads bank SMS newer than the last one it handled. *(Claude's call: this is simpler and more reliable than a background listener. The cost is that transactions appear when the owner opens the app, not the moment they pay.)*
- **First run.** The owner picks a start date, today by default and up to 90 days back. Older SMS are ignored. Duplicate checks (below) protect anything already typed in by hand.
- **Parsing happens on the phone.** A parser for each bank turns an SMS into fields: kind (debit, credit, card spend, card payment received, card statement, CDSL movement), amount, date and time, the last 4 digits of the account or card, the payee (UPI ID or merchant name), the reference number (UPI/IMPS ref) and the available balance if given. Only these fields go to the server, along with a hash of the SMS for duplicate checks. The raw text stays on the phone.
- **The parser is JavaScript**, so fixes and new bank formats ship with `eas update` and don't need a new APK. Only the small native module that reads the SMS inbox is native code.
- **Messages the app can't read.** A bank SMS that looks like a transaction (it has "debited"/"credited" and an amount) but doesn't match a parser shows in a "Couldn't read" list **on the phone only**. The owner can copy the text to share as a sample for a new parser.
- **Built for many people, not just the owner** (the owner may extend Gullak to family and friends, whose banks are unknown). Parsers cover India's main banks from day one: SBI, HDFC, ICICI, Axis, Kotak, Bank of India, Bank of Baroda, PNB, Canara, Union, IDFC First, Yes and IndusInd, their credit cards, and CDSL and NSDL. A **general reader** tries any other bank SMS containing debited/credited and an amount, and marks what it records for review.
- **Samples.** Formats come from the owner's real SMS (masked) and publicly documented examples. The builder asks the owner for their own masked samples (Bank of India, their card(s), CDSL) to test with.
- **"Send sample" button** in the "Couldn't read" list *(Claude's call)*. After an explicit tap, one message at a time, the phone masks digits (account, card, reference, balance) and names, and sends the masked text to the server for the owner to see and add a parser for. This is the only time any SMS text leaves the phone. Parser fixes ship to everyone with `eas update`.
- **Each user's data is separate:** payee rules, categories and review lists are per user. Only the built-in merchant list is shared. Sign-up for new users is out of scope (users are still added by hand).

### 2. Matching an SMS to an account

- An SMS's last 4 digits are matched to the account's or card's existing `last4`, together with the bank in `institution`. One account can have **several** 4-digit identifiers *(Claude's call)*, for example the bank account number and its debit card, so a debit-card spend lands in the bank account. The builder needs a small identifiers table, not just the single `last4` column. Accounts without `last4` are asked about once ("Which account is XX1234?"), and the answer is saved.
- If no account matches, the SMS goes to "To review" and asks for the account.

### 3. Recording, and the "To review" list

**Rule** *(Claude's call, which refines what the owner agreed in chat)*: money is **recorded straight away** whenever the account and amount are known, so balances always match the bank. "To review" then asks only for the missing piece:

| Situation | What happens |
|---|---|
| Known payee (learned rule or built-in list) | Recorded with that category. Nothing to review. |
| New payee | Recorded with **no category yet** and shown in "To review". The owner picks a category, and "Always use this for <payee>" is ticked by default. |
| Unknown account | Not recorded yet. In "To review", the owner picks the account. |
| CDSL share movement | **Draft only**, not recorded until confirmed (see section 6). |

- **Payee rules.** A rule says "payments to this payee are category X". It can also say "this payee is a transfer to my account Y", for example an RD, a wallet top-up or one's own other bank. Rules are learned from the owner's choices and can be edited and deleted from a small "Payee rules" screen.
- **Built-in list.** A starting set of common Indian merchants and their categories (Swiggy and Zomato as Food and dining, Uber and Ola as Transport, Amazon and Flipkart as Shopping, petrol pumps as Fuel, Airtel and Jio as Utilities, and so on). The owner's own rules always win.
- **Payee names are normalised** for matching: case, spaces, and suffixes like `@okaxis` are kept as the key, but cleaned for display.
- "To review" shows as a count on the dashboard, with its own screen on both the website and the app.

### 4. Never counting twice

Checked in this order:

1. **Same SMS again:** the same hash for the same user is ignored.
2. **Same reference number:** a UPI or IMPS ref already recorded for that account is ignored.
3. **Already typed in by hand:** a manual transaction in the same account with the same amount and type, within one day of the SMS date, and not already linked to an SMS. If there's exactly one, the SMS is linked to it and nothing new is created. If there are several, it goes to "To review" as "Is this one of these?".
4. **Two sides of one transfer:** a debit in one of the owner's accounts and a credit of the same amount in another within 3 days can be **one transfer**. They merge automatically **only with evidence** *(Claude's call)*: a card "payment received" SMS for that card (the card bill case: the bank says "debited", the card says "payment received"), the same reference number on both sides, or a payee rule that points the debit at the other account. Without evidence, they are recorded as they are, and "To review" asks "Is this a transfer between your accounts?", so a friend's ₹500 refund is never silently merged with an unrelated ₹500 spend. Whichever SMS arrives first is recorded first, and a confirmed match turns the pair into a transfer.

Deleting a transaction that came from an SMS marks that SMS as ignored, so the next read doesn't bring it back.

### 5. Regular payments tick themselves off

When a debit SMS arrives, Gullak checks whether it is a payment it was already expecting:

- **Recurring templates (rent and others):** same account, and a payee rule or earlier occurrence ties the payee to the template. The amount can be within ±10% of the template's *(Claude's call)*, and the date within the template's reminder window. It is recorded as that template's occurrence, and the reminder is ticked off. The first time, the owner is asked "Is this your Rent?", and the answer is saved as a payee rule.
- **EMIs:** debit from the loan's `pay_from` account for the loan's `emi_amount`. It is recorded as an EMI the same way the "record" action on the EMI reminder does it today.
- **SIPs:** debit from the SIP's account for the SIP amount, near the SIP day. A fund buy is recorded through the existing fund-trade path, using AMFI's NAV for the allotment date (see section 7). The units are worked out from amount and NAV and **marked "estimated"** until the owner checks them against the fund statement and taps confirm, or edits them.
- **RD instalments:** a debit equal to the RD's `deposit_amount`, with a payee rule pointing at the RD, is recorded as a transfer into the RD.
- **Card statement SMS:** stores the statement total and due date for that card. The dashboard shows "Card bill ₹X due <date>" until a payment that covers it is matched.

If more than one thing could match, nothing is guessed. It goes to "To review" with the candidates.

### 6. Stock trades from the CDSL SMS

- The day-end CDSL SMS lists shares that left (debit) or entered (credit) the demat account, with quantity and the company or ISIN. It usually doesn't give a price.
- Each line becomes a **draft trade**: the stock is matched by ISIN or name to the owner's stocks (using NSE's public symbol–ISIN list), plus side, quantity and date. The **price is pre-filled with that day's closing price**, charges with 0, and the account with the owner's broker account (the owner picks if there is more than one).
- Drafts sit in "To review". The owner checks the price and charges against the contract note and taps confirm, and then the trade is recorded through the existing trade path.
- A draft for a stock the owner doesn't hold yet offers to create that stock first.
- If the same trade was already typed in by hand (same stock, side and quantity, within 2 days), the draft is linked to it and not offered.
- Samples of the CDSL SMS are needed before this parser is written.

### 7. Prices every night

A scheduled job on the server runs every night at about **23:30 IST** *(Claude's call: after markets close and AMFI publishes NAVs)*. It uses a Vercel Cron Job calling a protected API endpoint. The endpoint checks a secret that the owner sets as a Vercel environment variable.

| Kind | Source | Notes |
|---|---|---|
| Mutual funds | AMFI's daily NAV file (`NAVAll.txt`), free and official | Matched by AMFI scheme code |
| Stocks | NSE's end-of-day bhavcopy, official | NSE sometimes blocks requests from servers, so a second source (such as Yahoo Finance's `.NS` quotes) is used when it fails |
| Crypto | CoinGecko's free price API, in INR | Matched by CoinGecko coin id. Also refreshed when the website or app opens and the last crypto price is more than 6 hours old *(Claude's call: the free Vercel plan allows only one cron run a day)* |

- **Linking holdings to sources.** Each instrument gets a link to its source: an AMFI scheme code, an NSE symbol, or a CoinGecko id. New instruments are linked when created, with a search box. Existing ones get a one-time "link your holdings" prompt.
- **Saving.** Fetched prices go into the existing `instrument_prices` table, marked as automatic. A price the owner typed in for the same day always wins and is never overwritten.
- **Failures.** If a source fails, the last price stays and is shown with its date ("price from 12 Nov"). A failure never deletes or zeroes anything. Failures are logged.
- **Sync button** (added 2026-11-12 at the owner's request, alongside the nightly run, not instead of it). A "Sync prices" button on the Investments page (website) and Investments tab (app) refreshes the user's own linked holdings on demand: crypto live, stocks near-live (Yahoo, about 15 minutes delayed, during market hours) and funds' latest published NAV (AMFI publishes once a day, so a daytime sync can't be newer than last night). A source is not fetched again if that user's prices for it were refreshed in the last minute, so repeated taps don't get Gullak blocked. The nightly run later replaces a day's synced stock price with the official close.
- The same fetched data also gives the NAV for SIP instalments (section 5) and the closing price for CDSL drafts (section 6).

### 8. What the owner sees

- **Profile:** the SMS switch, the start date, which banks were found, and the time of the last read.
- **Dashboard:** a "To review" count and the card bill due.
- **To review** (website and app, each in its own style): new payees to categorise, unknown accounts, "is this one of these?" matches, estimated SIP units, and CDSL drafts.
- **Payee rules:** list, edit, delete.
- **Transactions** created from SMS carry a small "from SMS" mark. They can be edited like any other.
- **Prices** show their date and whether they were automatic or typed in.

## Data (outline; exact columns are the builder's call)

- **SMS entries:** one row per parsed SMS. Holds the user, SMS hash (unique per user), sender, kind, amount, date and time, last 4 digits, payee, reference number, matched account, status (recorded, to review, ignored, duplicate) and links to the transaction or trade it created or matched.
- **Payee rules:** user, payee key, display name, and either a category or a transfer-to account, optionally tied to a recurring template.
- **Transactions:** gain a link to their SMS entry, and a way to sit without a category while waiting for review.
- **Investment trades:** gain an "estimated" flag for SIP units.
- **Instruments:** gain a source link (scheme code, NSE symbol or CoinGecko id).
- **Instrument prices:** gain a source marker (manual or automatic).
- **Card statements:** card, statement total, due date and the SMS it came from.
- **Drafts** for CDSL trades: the SMS entry plus the proposed trade fields, or a small drafts table.

## Testing

- Parser tests on the phone side, using real SMS samples (masked) as fixtures, including messages that must **not** parse.
- Server tests for every duplicate rule in section 4, every match in section 5, and the "record straight away" rule.
- Price job tests using saved copies of the AMFI file, a bhavcopy and a CoinGecko response, plus failure cases: source down, a fund missing from the file, and a manual price already present.
- Existing ledger invariant tests must keep passing. SMS-created transactions go through the same validation as manual ones.
- PostgreSQL migration tests, as for every earlier migration.

## Rollout

1. Server: tables, matching, review endpoints, and the nightly price job. The owner runs the migration on Neon and sets the cron secret.
2. Website: To review, payee rules, linking holdings to price sources, and price dates.
3. App screens (JavaScript, shippable with `eas update`).
4. Native SMS module plus parsers. Needs the new APK, so it goes live when the owner does the deferred install. It is added to the pending device-check list.

Prices (step 1) help right away, even before the phone install.

## Left to the builder

- Exact table and column names, and endpoint shapes.
- How the native module is built (a local Expo module in Kotlin is the expected route).
- The exact backup stock-price source, after checking what works from Vercel.
- The contents of the built-in merchant list.
- How "no category yet" is represented (null plus a review flag, or similar), as long as summaries show it as "Uncategorised".
- The UI layout of each new screen, following the Gullak chunky style and platform-native patterns.
