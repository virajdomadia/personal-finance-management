# Corporate actions: design

## Why

A stock gives its holders more than price moves: splits, bonus shares, dividends, demergers, mergers. Today the app knows none of these. Holdings are replayed from trades ([stocks design](2026-11-08-stocks-design.md)), so when a held stock splits 1:5 the nightly NSE price falls to a fifth while the share count stays put, and the holding shows a false ~80% loss. Dividends only exist as a bank-transaction category and aren't tied to the stock that paid them.

The owner wants the app to know what each stock gives, keep holdings and P&L right after these events, and show dividend income per stock.

## Decided with the owner

- **Scope:** splits, reverse splits (consolidation), bonus issues, dividends, demergers, mergers. Rights issues, buybacks, open offers and delisting stay ordinary buy/sell trades (out of scope here).
- **Automatic:** the app fetches corporate actions from NSE every night, and the owner confirms before anything changes a holding.
- **Approach (option 1):** corporate actions are stored as their own records and applied inside the FIFO replay at their date. Trades are never rewritten; deleting an applied action undoes it completely.

## Approaches considered

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| 1 | Separate action records applied during replay | One new concept in `replay`; fully reversible; tax dates and real trade prices stay true | **Picked** |
| 2 | Insert synthetic trades (₹0 buy for a bonus) | Fits bonus only; splits and demergers would need past trades rewritten, losing real prices and hard to undo | Rejected |
| 3 | Rewrite past prices/quantities to the new basis ("adjusted" history) | Smooth charts, but history shows prices never paid and tax lots blur | Rejected |

## Goals, non-goals, anti-goals

- **Goals:** correct quantity, average cost and P&L across splits, bonuses, consolidations, demergers and mergers; dividend income per stock and in total; upcoming announced actions visible for held stocks; no missed split goes unnoticed.
- **Non-goals:** tax computation or capital-gains reports; rights/buyback/open-offer handling; US or other markets; mutual fund or crypto events.
- **Anti-goals:** a dividend counted twice in net worth (it already arrives in the bank via statements/SMS); a holding silently changed without the owner's confirmation; a broken NSE fetch blocking or slowing the nightly price job.

## Model

### `corporate_actions` (shared, not per user — like `market_codes`)

One announced event for one listed stock, as fetched.

| Field | Meaning |
|---|---|
| `symbol`, `isin` | NSE symbol and ISIN at announcement time |
| `kind` | `split`, `consolidation`, `bonus`, `dividend`, `demerger`, `merger`, `other` |
| `ex_date` | Ex-date (India). Also the record date in today's T+1 market; store `record_date` separately when the source gives it |
| `ratio_new`, `ratio_old` | Split/consolidation: shares after : before (FV ₹10 → ₹1 is 10:1). Bonus: new shares : held (1:1, 1:2). Merger/demerger: new-company shares : held |
| `amount_per_share` | Dividend ₹ per share |
| `purpose` | The source's raw text, always kept |
| `source` | `nse`, `bse` |
| unique | (`symbol`, `kind`, `ex_date`, normalised `purpose`) — an interim and a special dividend on the same ex-date stay two rows |

`other` holds anything the parser couldn't read (shown with its raw text so the owner can enter it by hand).

### `stock_actions` (per user)

What the owner has done about an event for one of their instruments.

| Field | Meaning |
|---|---|
| `user_id`, `instrument_id` | The owner's stock |
| `corporate_action_id` | The fetched event, or null when entered by hand |
| `kind`, `ex_date`, `ratio_new`, `ratio_old`, `amount_per_share` | Copied from the event at creation, editable by the owner before confirming |
| `status` | `pending`, `applied`, `dismissed` |
| `target_instrument_id` | Demerger: the new company. Merger: the company it merged into |
| `cost_share_pct` | Demerger only: % of the parent's cost that moves to the new company (from the company's announcement, entered by the owner) |
| unique | (`user_id`, `instrument_id`, `corporate_action_id`) when fetched; hand-entered rows aren't unique-keyed |

Only `applied` rows affect holdings. Demergers and mergers are created `pending` with their ratio but need the owner to pick/create the target stock (and the cost % for a demerger) before they can be applied.

### Dividends

Not a separate stored table: a dividend is an `applied` dividend `stock_action`, and what the owner received is derived:

- **Entitled shares** = shares held in each broker account at the end of the day before the ex-date (from replay).
- **Gross amount** = entitled shares × `amount_per_share`, rounded to paise. Shown gross; the app makes no TDS claim.
- **Link to bank:** a dividend can be linked to one or more existing transactions (the ones statement import put in "Dividends") through a `dividend_links` table (`stock_action_id`, `transaction_id`, unique pair) — a stock held in two demat accounts pays two credits. The app suggests matches per broker account: a Dividends-category credit within 45 days after the ex-date whose amount is between 85% and 100% of that account's gross (covers TDS). Linking is informational only — **no new ledger entry is ever created**, so net worth is unchanged.
- **Totals (builder's call, settled here):** "Dividends received" counts every `applied` dividend at its gross amount, linked or not, dated by its ex-date (the payment date isn't known reliably). Financial-year totals bucket by ex-date. Total return uses the same gross figure. The family view sums the same numbers per member.

Dividends don't change holdings, so they're recorded `applied` automatically for held stocks; the owner can dismiss one. (Splits, bonuses, consolidations, mergers and demergers always wait as `pending`.)

## Replay rules (`backend/app/api/portfolio.py`)

`replay` takes the user's applied actions alongside trades. Per (instrument, account) group, events run in date order; **an action on date D applies before any trade dated D** (a trade on the ex-date is already at the new basis).

| Action | Effect on each lot held at that moment |
|---|---|
| Split / consolidation `n:o` | quantity × n/o; cost unchanged; lot date unchanged |
| Bonus `n:o` | New lot of floor(held × n/o) shares, cost ₹0, dated the ex-date. Fractional entitlements are dropped (companies settle them in cash) |
| Merger `n:o` into target | Each eligible lot (basis before ex-date) moves to the target instrument, same account: quantity floor-adjusted × n/o, cost and lot date kept. Source keeps only lots entered on/after the ex-date (normally none, so it ends at 0) |
| Demerger `n:o`, `cost_share_pct` p | Each lot: child lot in target instrument with quantity × n/o (floored), cost = round_paise(lot cost × p/100), original lot date kept; parent lot keeps the remaining cost |

Fraction rounding (settled): flooring is **per position** (one instrument in one account), never per lot, so counts match the broker. Bonus: one new lot of floor(position × n/o). Merger/demerger: each lot gets its exact quantity × n/o, then the fractional remainder of the position total is removed from the newest lot (its cost unchanged). Split/consolidation keep exact Decimal quantities. Cash paid for fractions is ignored; the owner can record it as a sell if they want. Paise rounding as today, with the remainder staying on the parent lot so costs always add up.

Because mergers/demergers move lots across instruments, replay can no longer process each (instrument, account) group fully independently: process groups in an order where a target's group runs after its sources up to the action date, or (simpler) replay per account across all instruments in one date-ordered stream. Builder's choice.

**Existing rules extend to actions:** a holding can never go below 0 in date order. Deleting/un-applying an action, or editing a trade, that would leave a later sell short is refused, naming the stock and date.

### Opening shares ("Add existing shares")

Brokers show holdings already adjusted for past splits/bonuses, so an opening buy is entered at today's basis even though its date is in the past. A new column `investment_trades.basis_date` (India date) records the day a trade's quantity and price were last entered: set on create and whenever quantity or price is edited; backfilled from `updated_at` by the migration. **An action is applied to a lot only if the lot's `basis_date` is before the action's ex-date** — for a normal trade entered on its own date this is the same as "trades before the ex-date". This also covers an owner who already fixed a split by hand by editing the quantity.

Every review card shows the before → after share count and average cost, so a double adjustment is visible before it's confirmed and can be dismissed.

The owner confirmed their opening shares were copied from the broker app's current holdings and no split was ever fixed by hand. So:

- A fetched split/bonus/consolidation/merger/demerger that would change **no lot** (every lot's `basis_date` is on or after its ex-date) is created `dismissed` silently instead of `pending`, so backfill doesn't flood the review card with no-op events. It stays visible in the stock's history.
- Dividend entitlement also counts only lots whose `basis_date` is before the ex-date. Past dividends are therefore derived only for shares entered as real dated trades, never for opening shares, whose past quantity isn't known.

## Fetching (nightly)

- New step in `backend/app/prices/refresh.py`, after stock prices, with its own time budget (~15 s) and own commit. Failure is logged in the `RefreshReport` and never affects prices or net worth snapshots.
- **Window:** ex-dates from 7 days ago to 60 days ahead, so upcoming announcements show too.
- **Sources:** NSE corporate actions API (`www.nseindia.com/api/corporates-corporateActions`, needs a cookie from a first homepage request, may be blocked from cloud IPs) with BSE's corporate actions API as fallback. Both calls live in `fetch.py`; parsing of the `purpose` text in `parse.py` with unit tests on real samples ("Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share", "Bonus 1:1", "Interim Dividend - Rs 2.50 Per Share", etc.). Builder must verify both endpoints and their exact parameters/headers before relying on them.
- **Matching to users:** for every user instrument linked to an NSE symbol (`source_code`) with shares held on the ex-date eve (or, for upcoming events, held now), create a `stock_actions` row if none exists for that key.
- **Backfill:** every linked stock needs its history fetched back to its earliest trade (NSE supports a per-symbol query), creating rows the same way; past splits/bonuses arrive `pending` for review. It runs in the nightly job, not in a request: `instruments.actions_backfilled_at` (null = not done) and each run backfills as many null stocks as fit in the remaining budget. Linking a stock clears the field. Nobody waits on it; the stock page says "checking past corporate actions…" until it's done.
- **Safety net:** if a held stock's close drops more than 35% day-on-day and no split/bonus/consolidation/demerger is known around that date, raise a "possible missed corporate action" notice on the stock with a button to enter one by hand.
- Symbol renames: when the equity list shows the same ISIN under a new symbol, update the instrument's `source_code` automatically (no event row needed).

## API

- `GET /stocks/actions?status=pending|applied|dismissed` — the review inbox, plus count for a badge.
- `GET /stocks/{id}/actions` — a stock's events (past and upcoming) with dividend amounts.
- `POST /stocks/{id}/actions` — enter one by hand (`pending`).
- `PATCH /stocks/actions/{id}` — edit fields while pending; `{status: "applied" | "dismissed" | "pending"}` to confirm, dismiss or undo (undo subject to the never-below-0 rule).
- `POST /stocks/actions/{id}/link` / `DELETE …/link` — link a dividend to a transaction; `GET …/link-suggestions`.
- Portfolio responses gain `dividends` per holding and in totals.

## UI (web and mobile, as with other investment features)

- **Review card** on the investments page when anything is pending: "3 corporate actions to review", each showing e.g. "INFY split 1:5 on 12 Mar 2026 — 40 → 200 shares, avg ₹1,500 → ₹300" with Confirm / Dismiss. Demerger/merger cards ask for the target stock and (demerger) the cost %.
- **Stock page:** an "Actions & dividends" section — upcoming events, past applied events, dividends with amount and linked/unlinked state.
- **Investments totals:** "Dividends received" (this financial year and all time), and total return = unrealised + realised + dividends.
- Missed-action notice on a stock page when the safety net fires.

## Constraints

- Indian equities only, INR, India dates, paise rounding (`round_paise`), Decimal quantities — as the rest of investments.
- Vercel Hobby limits: the nightly route must stay inside its time limit; corporate actions run last with a budget.
- New tables need an Alembic migration and must be included in export/backup ([export-backup design](2026-11-13-export-backup-design.md)) and the family portfolio view.

## Left to the builder

- Exact NSE/BSE endpoint parameters, headers and cookie handling (verify live).
- Replay restructure for cross-instrument moves (per-account stream vs ordered groups).
- Purpose-text parser coverage beyond the listed samples; unknowns go to `other`.
- Exact wording and layout of the review card and stock-page section, following the existing chunky UI.
