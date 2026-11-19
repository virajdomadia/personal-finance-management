# Smart category: auto-pick from the note

## Why

Small items ("ice cream", "chai", "parking") stall entry: the owner doesn't want to decide
which category they belong to. They want to type what they bought and have the category picked
for them, changing it only when it's wrong.

## Goals

- Typing a note in the transaction dialog fills the category by itself.
- It learns: once the owner files "ice cream" somewhere, it goes there every time after.
- Works from day one for everyday items, with no setup.

## Non-goals

- AI or any outside service (left for later; see Approaches).
- SMS entries: payee rules already categorise those.
- The mobile app: it has no manual add-transaction form today. The endpoint is ready for one.

## Anti-goals

- Overwriting a category the owner chose by hand.
- Slowing the dialog down, or blocking a save when there's no suggestion.

## Approaches

- **A. History, then a built-in keyword list (picked).** Free, private, instant. An unknown word
  gets no pick the first time, but once chosen it's remembered.
- **B. A, plus Claude Haiku for unknown words.** Knows nearly anything from day one, but sends
  note text out, needs an API key, costs per item, and adds latency.

The owner left the choice to Claude, which picked **A**. B can be added later behind the same
endpoint without changing the dialog.

## Design

**Endpoint:** `GET /transactions/suggest-category?note=…&type=expense|income`, which returns
`{ "category": "Food and dining" | null, "source": "history" | "keywords" | null }`.

The suggester goes in order and the first match wins:

1. **History.** Normalise the note (case-fold, trim, collapse spaces). Look up the owner's most
   recent transaction of the same kind with the same normalised note and a category. Use that
   category, resolved through merges and renames, and skip it if it's now archived.
2. **Keywords.** A built-in map from words or phrases to default category names, matched on word
   boundaries in the note, with the longest phrase winning ("ice cream" before "cream"). Roughly
   150 to 250 everyday Indian entries across the default expense categories (and a few income ones
   like "salary" and "refund"). Skip the match if the owner has archived or merged away that
   category; follow merges to the target.
3. Otherwise `null`.

Learning needs no new table: every saved transaction is history.

**Dialog (web):**
- After the note stops changing for about 300 ms, ask for a suggestion.
- Fill the category only while the owner hasn't touched the category field in this dialog. If
  they have picked one, never replace it.
- Show a small hint by the field, "Auto-picked", so it's clear where the category came from.
- Editing an existing transaction behaves the same: no auto-fill if it already has a category.
- If the request fails or returns nothing, nothing changes.

## Left to the builder

- The exact keyword list and where it lives (a Python module next to `app/api/categories.py`).
- The debounce timing and the hint's styling, matching the chunky UI.
- Tests: history wins over keywords; merged, renamed and archived categories are handled; the
  longest phrase wins; the dialog never overrides a manual pick.

## Branch note

The current branch, `feat/corporate-actions`, has uncommitted work. Build this on its own
branch from `main`.
