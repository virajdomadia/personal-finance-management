# SMS review speed: suggestions from history and "Approve all confident"

Date: 2026-11-13. Status: implemented (branch sms-speed).

## Why

User complaint 8 in the product review: "If 15 SMS pile up I'll stop opening the app." Today every
message whose payee has no payee rule waits in To review with an empty category picker, and each one
takes a pick and a tap. Phase 5's "SMS review speed" bullet in
`docs/superpowers/plans/2026-11-12-product-review-plan.md` asks for two things: categories filled in
from the payee's own history, and one tap that approves every draft Gullak is sure about.

**Done when:** a draft from a payee seen 3+ times arrives with its category filled in, one tap
approves every confident draft, and a normal week of drafts clears in under 5 minutes.

## What a "draft" is here

SMS money is recorded straight away when the account and amount are known (automation design,
section 3). A new payee's money is recorded with **no category** and waits in To review with reason
`category`. Those items are the drafts this work speeds up: what is missing is only the category.
Every other review reason (unknown account, "typed in already?", "a transfer?", "a regular
payment?", card bill payer, SIP units, CDSL share trade, couldn't record) is a question only the
owner can answer, so it is never confident and never approved in bulk.

## How it works

### 1. A suggested category for every draft

Computed **on read** (no migration). For a `category` item with a payee, in order:

1. **Payee rule** (or the built-in merchant list, the same lookup ingestion uses): a rule created or
   changed after the message arrived. Source `rule`.
2. **History:** the payee's past recorded transactions of the same type (expense or income) that
   have a category, through the SMS entries that point at them. The suggestion is the most common
   category among the latest 20 *(my call: recent habits win over old ones)*; ties go to the one used
   most recently. Source `history`, with `count` (times that category was used) and `total`
   (categorised transactions looked at).

Every name goes through `usable` (the category registry): an archived category is never suggested.
The website and the app put the suggestion in the category picker, so the draft arrives filled in.

For an `account` item the payee's history can also name the account: when every earlier recorded
message from that payee was in one account, that account is suggested and preselected. It is never
confident: a missing account always needs the owner.

### 2. Confident

**The rule** *(my call on the exact threshold)*: a draft is confident when **all** of these hold:

- its reason is `category`, it has a payee, and its money is recorded as an uncategorised income or
  expense that isn't tied to a reminder;
- it has a suggestion from a **payee rule**, or from **history where the top category was used at
  least 3 times and in at least 80% of the payee's categorised transactions looked at**
  (`count >= 3 and count * 5 >= total * 4`);
- **nothing else about it needs a human**, re-checked on every read:
  - no other open item offers its transaction as a choice (a card bill "paid by this debit?", the
    other side of "a transfer?");
  - no transaction typed in by hand in the same account with the same amount and direction within a
    day and not already linked to an SMS (a possible duplicate);
  - for a bank debit, no EMI, SIP or reminder it could be paying (the same `expected_candidates`
    check ingestion runs);
  - an account and an amount are known, and the account isn't archived.

Everything ingestion deliberately sends to a human keeps doing so: those items have other reasons
and are excluded by the first condition.

### 3. Why: a short reason on every item

Each item carries `why`, a short phrase shown on the card or row:

- confident: "Payee rule: Groceries", "Groceries 4 of 4 times before";
- not confident: "First time for this payee", "Seen 2 times before", "Groceries only 3 of 5 times",
  "Might be your Rent", "May have paid a card bill", "You may have typed this in", "No payee in the
  SMS";
- other reasons: "Account unknown", "Possible duplicate", "Possible transfer", "Possible regular
  payment", "Card bill payer unknown", "Units are estimated", "Check the price", "Couldn't record".

### 4. Approve all confident

`POST /api/sms/review/approve` with `{"items": [{"id": 12, "category": "Groceries"}, ...]}`: the
items and categories the owner saw in the confirmation. The server takes the user lock, then for each
item, in its own savepoint (atomic per draft):

- the item must still be open, still confident, and still suggest the same category; otherwise it is
  skipped with a reason ("Already answered", "Not confident any more", "Its suggestion changed");
- it is categorised through the same path as a single answer (`review.categorise`, same save checks),
  **without** creating a payee rule *(my call: a bulk tap shouldn't teach rules silently; the result
  offers that instead, see 5)*;
- a save-check failure skips that item with the checker's message and leaves it waiting.

The response says how many were approved, which were skipped and why, and which payees could become
rules. At most 200 items per call.

`GET /api/sms/review` gains a `confident` summary computed by the server (the clients do no money
math): the count, the money out and in, and a per-category breakdown, for the confirmation.

Nothing is recorded without the owner's action: the bulk approval is an explicit tap plus a
confirmation, and ingestion is unchanged.

### 5. Learn faster

- After a bulk approval, every payee approved from **history** (not from a rule) is offered as
  "Always use <category> for <payee>". One tap creates the payee rule through a new
  `POST /api/payee-rules` (`{"entry_id", "category"}`), so the next message from that payee is
  recorded with its category and never waits.
- The single-item "Always use this" box (already ticked by default) now names the category it will
  remember ("Always use Groceries for Ramesh"), so a changed pick is learned knowingly.

## Out of scope

- Auto-recording categories at ingestion from history (the owner reviews first).
- Bulk answers for any reason other than `category`.

## Clients

Each in its own style, as always.

- **Website:** an "Approve N confident" bar above the cards, a dialog listing the totals and the
  per-category breakdown, then a result panel with skipped items and "Always use" buttons. Each card
  shows its `why` as a chip and opens with the suggestion picked.
- **App:** an "Approve N confident" button at the top of To review, a react-native-paper dialog with
  the totals, then a result card with skips and "Always use" chips. Rows show `why` in their meta
  line; the review item screen prefills the category chip and the account.
