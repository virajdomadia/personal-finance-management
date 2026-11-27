# Statement import safety — design

**Why:** On 28 Nov a Bank of India statement import counted 44 lines twice and "Match bank" then
over-corrected, leaving the balance wrong (fixed by hand in Neon). Four fixes so it can't recur.

## 1. Lines from before the account was added (opening shift)
An account's opening balance is its balance on the day it was added (`created_at`, India date);
it has no date of its own. A statement line dated on or before that day is already inside the
opening balance. Such lines are **imported as normal** (full history), and saving them **moves the
opening balance** of every account the line touches (both sides of a transfer, each against its
own added day) by the line's effect, so that account's balance today is unchanged. Below-₹0 and
largest-balance checks apply only to the unshifted part.
Preview returns `added_on` (ISO date) and `before_start` (count of keepable, non-duplicate lines
dated ≤ `added_on`); web and phone show a note:
"{n} lines are from before you added this account on {date}. Saving them keeps today's balance
the same: the opening balance moves instead."

## 2. Match bank uses the bank's end-of-day balance
The latest balance-bearing debit/credit SMS for a bank account on day D gives balance B.
Later debit/credit SMS for that account on D (higher id; any status) are money that moved after it:
bank end-of-day = B − later debits + later credits. That is shown as the bank's balance and
compared with Gullak's end-of-day balance.

## 3. Near-duplicates
An import line matches a saved movement in the same direction within ±1 day when amounts are
equal, or else differ by less than ₹1 (exact matches are taken first).

## 4. Picture-only PDF
A PDF whose pages have no text but do have images raises: "This PDF is a scanned image, so
Gullak can't read it. Download the statement as Excel or CSV, or use the password-protected PDF
your bank emails you."

## Approaches considered
- (1) Untick lines before the added day (approved first, then replaced by the owner's choice of
  the opening shift, which keeps the balance right *and* gives history).
- (2) Only trust a balance SMS that is the last SMS of its day — rejected: the check lags by days.
- (4) OCR via a vision API — deferred; the emailed locked PDF has text.

No migration. Out of scope: SMS read from before an account was added.
