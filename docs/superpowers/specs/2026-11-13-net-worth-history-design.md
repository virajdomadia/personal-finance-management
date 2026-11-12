# Net worth over time: design

## Why

Complaint 5 from the product review: "Net worth today without last month to compare doesn't motivate anyone." The dashboard shows one number, worked out on every request, and nothing is kept, so there is no trend to show. This is Phase 4 of the [product review plan](../plans/2026-11-12-product-review-plan.md).

**Done when** the website shows a 12-month net worth line and allocation over time, and the app dashboard shows a sparkline and the change since last month.

The calculation rules (what a snapshot holds, how the backfill estimates, how the change figures pick their comparison) are in [financial calculations](../../architecture/financial-calculations.md#net-worth-over-time). This document covers the pieces and the screens.

## Snapshots

A new table, `net_worth_snapshots`, one row per user per India date:

| Column | Type | Meaning |
|---|---|---|
| `id` | integer | primary key |
| `user_id` | FK users | |
| `date` | date | India's date; unique with `user_id` |
| `net_worth`, `total_have`, `total_owe` | `NUMERIC(16, 2)` | the dashboard's figures |
| `bank_cash`, `deposits`, `stocks`, `funds`, `crypto` | `NUMERIC(16, 2)` | the dashboard's asset split, all five stored |
| `estimated` | boolean, default false | true for a backfilled point |
| `created_at`, `updated_at` | timestamptz | |

The figures are sums over many accounts, so they get two more digits than a single amount (`NUMERIC(16, 2)`). *My call.* The split is five columns, not JSON, because the groups are fixed and typed columns keep `alembic check` and Decimal handling simple. *My call.*

### Who writes them

1. **The nightly cron** (`GET /api/cron/prices`, 18:00 UTC = 23:30 India): after `run_nightly` has refreshed and applied prices, it writes today's snapshot for every user with at least one account or instrument (upsert, overwrites). One failing user is logged and skipped. The response gains a `snapshots` count.
2. **The history request** (`GET /api/net-worth`), which both dashboards make on load: when there is no real snapshot for today it writes one (insert, or replace an estimated row for the same date). So a new install gets its first point at once. *My call:* the trigger is the history request, not `GET /dashboard`, so the dashboard route stays read-only and unchanged, and the write happens on the request that needs the point. Concurrent first loads are safe because the write is an `INSERT … ON CONFLICT` upsert.
3. **The backfill CLI** writes estimated month-ends (below).

A user with no accounts and no instruments gets no snapshot and an empty history. *My call:* a flat line at ₹0 says nothing.

### Reusing the dashboard's maths

The dashboard's net worth, have, owe and split code moves into `app/api/worth.py` (`worth_of(db, user_id, active, today)`), which returns the figures plus the intermediate pieces the dashboard still needs (book, trade replay, prices, deposit rows). `get_dashboard` calls it; the snapshot writer calls it. Nothing is computed twice in two ways.

## Backfill

`python -m app.cli backfill-net-worth [email] [--months 12]` estimates month-end points for the last 12 months from transaction history: bank, cash, wallet, card, loan, broker cash, PPF and RD balances. Stocks, funds and coins are left out until snapshots start. It writes only month-ends before the user's first real snapshot, never touches a real snapshot, and replaces its own earlier estimates when re-run. The rules and their limits are written in financial calculations.

*My call:* PPF, RD and broker cash are included, because their balances come from transactions exactly like a bank's. Only priced holdings are left out.

## API

`GET /api/net-worth?range=3m|6m|1y|all` (default `1y`; anything else is a 422).

```json
{
  "range": "1y",
  "today": "2026-11-13",
  "points": [
    {
      "date": "2026-05-31",
      "net_worth": "350000.00",
      "total_have": "400000.00",
      "total_owe": "50000.00",
      "allocation": {"bank_cash": "380000.00", "deposits": "20000.00", "stocks": "0.00", "funds": "0.00", "crypto": "0.00"},
      "estimated": true
    },
    {"date": "2026-11-13", "...": "today, worked out live", "estimated": false}
  ],
  "since_last_month": {"amount": "22000.00", "from_date": "2026-10-12"},
  "since_start": {"amount": "162000.00", "from_date": "2026-05-31"},
  "tracked_since": "2026-11-13"
}
```

- `points` are oldest first. Every stored snapshot from the range's start up to yesterday, then today's live figures as the last point. Empty for a user with nothing.
- `since_last_month` and `since_start` are `null` when there is nothing to compare against. Amounts are signed, two-decimal strings.
- `tracked_since` is the date of the first real snapshot (`null` before one exists). Clients use it for the "history before … is estimated" note.

## Website

Web-native: hover and keyboard tooltips, wide charts, a page of its own.

- **Dashboard:** the Net worth tile links to `/net-worth` and gains a small trend inside it (a white sparkline over the last year and "▲ ₹22,000 since last month"). A self-contained `NetWorthTrend` component fetches the history, so the dashboard change is two lines.
- **`/net-worth` page**, also in the sidebar ("Net worth" 📊):
  - A range switch (3M / 6M / 1Y / All), using the existing `Segmented`.
  - Two tiles: change since last month and since the start of the range, with their dates.
  - **Net worth line chart:** hand-built SVG (the site has no chart library). x is spaced by date, so gaps are visible, and a gap over 45 days breaks the line. Estimated points are hollow dots joined by a dashed line; real points a solid line. Y axis with Indian short labels (₹5L, ₹1.2Cr). Hover or arrow keys move a tooltip that shows the date, net worth, have and owe, and "estimated" when it is.
  - **Allocation over time:** a stacked area chart of the five groups in the dashboard's colours, with a legend and the same tooltip behaviour (each group's value on that date). Negative groups are drawn as zero.
  - A note when any shown point is estimated: "History before {date} is estimated from your transactions and leaves out stocks, funds and coins."
  - A screen-reader table of the points (visually hidden) so the chart is not the only way in.
- No chart library is added. *My call:* two SVG charts are a few hundred lines, and a library would be the site's first.

## Android app

Android-native: a glanceable sparkline, a tap through to a simple screen.

- **Dashboard:** under the net worth figure, inside the green tile, a white sparkline (react-native-svg, already a dependency) and "▲ ₹22,000 since last month" (or ▼, or "Your trend starts today" when there is no comparison). The tile becomes pressable and opens the history screen. The history loads separately from the dashboard, so a failure only hides the sparkline.
- **History screen** (`/net-worth`): back header, `Segmented` range (3M / 6M / 1Y / All), a big chunky change tile, a larger line chart with estimated points hollow and dashed, a list of month-end values below it, the estimated note, and pull to refresh. *My call:* the list replaces tap-and-hold scrubbing, which is fiddly on a phone and hard to make accessible.
- No new native modules.

## Not in scope

ADR-004 (the ledger decision) is part of Phase 4 in the review plan but is a product decision for the owner, not code; it is left for the owner. Per-account history, CSV export of snapshots, and comparing against a budget are not built.

## Decisions marked "my call"

1. Snapshot figures are `NUMERIC(16, 2)`, with the split as five columns.
2. The lazy first snapshot is written by `GET /net-worth`, which both dashboards call, not by `GET /dashboard`.
3. A user with no accounts and no instruments gets no snapshots.
4. Today's point and the change figures are always live, never the stored row.
5. "Last month" is the snapshot nearest the same day last month, within 16 days, before today; ties go to the earlier.
6. The backfill includes PPF, RD and broker cash; it writes only before the first real snapshot.
7. The chart breaks the line on gaps over 45 days.
8. Hand-built SVG on the website; react-native-svg (already installed) on the app.
9. The app's history screen lists month-end values instead of a scrubbable chart.
10. A "Net worth" sidebar link on the website as well as the link from the tile.
