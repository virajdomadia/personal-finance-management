# Split transactions

## Why

One payment (a card swipe, a UPI payment, one bank SMS) often covers more than one of the owner's own categories: a ₹3,000 supermarket bill that is ₹2,200 groceries and ₹800 household. Today a transaction has exactly one category, so budgets and cash flow put the whole bill in one place.

Not this: splitting a bill with other people (money owed back). That is a different feature.

## Approaches

- **A. Linked transactions (chosen; the owner asked for "what's best").** Splitting turns the bill into several ordinary expense transactions, tied together. Everything that counts by category (cash flow, budgets, digest, calendar, exports, about 26 places) keeps working unchanged, and the account balance doesn't move because the parts add up to the bill. Costs: the list shows the parts as rows, and the SMS duplicate check must learn to see a split's total.
- **B. One transaction with category lines.** Keeps one row and the SMS link as they are, but every one of the ~26 category readers must expand the lines: several times the code and many chances to miscount money.
- Dropped: a "Split" category with the breakdown in the note (budgets would be wrong).

## Design

- **Data:** one nullable column `transactions.split_of_id` → the original transaction. The original keeps its id (so its SMS link, refunds and history stay on it) and becomes the first part; the other parts point to it. Migration needed (run on Neon before the API deploy).
- **What can be split:** an `expense` that isn't itself a part. At least 2 parts, each with a category and an amount > 0, adding up exactly to the bill. Every part has the bill's date, account, note and source.
- **One endpoint:** `PUT /transactions/{original id}/split` with `parts: [{category, amount}, ...]`. The first part updates the original; the rest replace any existing parts. Sending the same call again changes a split; sending one part (the whole amount) undoes it.
- **Editing parts directly:** a part's category and note can be edited as usual. Changing a part's amount, date, account or type, or deleting a part, is refused with "Change the split instead". Deleting the original deletes its parts.
- **SMS:** the hand-typed duplicate check (`sms/ingest.py` `_typed_by_hand`) also matches a split original when the original plus its parts add up to the SMS amount.
- **Web and phone:** the transaction's edit screen gets a **Split** button opening a parts editor (category + amount rows, "Add part", what's left to assign, Save). The transaction list tags each part "Split 1 of 2".
- **Rules doc:** a short "Split transactions" entry in `docs/architecture/financial-calculations.md`.

## Not doing

Splitting income, transfers or EMIs; splits with other people; percentages; splitting from the SMS review card (record first, then split).

## Left to the builder

Exact copy, where the Split button sits on each client, and the list tag's look.
