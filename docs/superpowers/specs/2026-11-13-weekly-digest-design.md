# Weekly digest: design

## Why

Phase 5 of the [product review plan](../plans/2026-11-12-product-review-plan.md) fixes complaint 7:

| # | Complaint | Check that proves it's fixed |
|---|---|---|
| 7 | The streak feels gimmicky; I want "you spent X, Y more than usual" | Sunday notification on the app and a card on the website: spent this week compared with the 4-week average, budgets at risk, what's due next week. The streak no longer appears on the dashboard. |

The digest becomes the reason to come back each week; the streak moves off the dashboard to Profile. Everything the plan doesn't decide was left to Claude ("do what's best"); those calls are marked *my call* and listed at the end. The rules are in [financial-calculations.md](../../architecture/financial-calculations.md#weekly-digest), written before the code.

## API

`GET /digest?week=` (no migration, nothing stored):

- no `week`: the last whole Monday–Sunday week in India, where a Sunday counts as whole from 6 pm IST (*my call*, see below);
- `week=YYYY-MM-DD`: the week holding that date (whole, or so far if it is this week);
- `week=current`: this week so far.

A week that hasn't started is refused with 422, like a future month on `/cash-flow`.

```
user_id                       # for per-user dismissal keys on the clients
week_start, week_end          # Monday, Sunday
through                       # the last day counted (week_end, or today for this week so far)
is_current, is_complete
label                         # "this week" | "last week" | "the week of 26 October"
spending                      # the /cash-flow rules over the window
usual | null, usual_weeks     # average of up to 4 earlier weeks (same days), and how many counted
change: {amount, percent} | null
tone: "more" | "less" | "same" | null   # exact ±5% test; the clients use it as is
top_spending: [CategorySlice] # the /cash-flow shape, top 3, no children
budgets: {
  month, through, days, days_in_month, elapsed_percent,
  at_risk: [{category_id, name, icon, colour, amount, spent, percent, bar,
             status: "over" | "on_pace", over_by, projected}]
}
due: { start, through, total, items: [UpcomingItem] }    # the /upcoming shape, today → today + 7
headline                      # one plain sentence
```

### Reuse, so fixes elsewhere flow through

- Spending: `app.api.cash_flow` (`Row`, `totals`, `grouped`, `percent`) and the month report's `_slice`, over rows loaded by `routes.budgets.month_rows` (the query `/cash-flow` and `/budgets` use).
- Budgets: `routes.budgets.MonthBook` for the month holding `through`, cut at `through` (`cash_flow.windows`), and its `bd.Line` figures (`spent`, `amount`, `over`, `percent`, `bar`, `over_by`). Only the "on pace" test is new.
- Due: `/upcoming`'s list builder, pulled out of the route as `upcoming_items(db, user_id, today, until)` so `/upcoming` and the digest share it (same order, overdue rule, running balance).

## Clients

### Website

`components/dashboard/weekly-digest-card.tsx`, one line in the dashboard (after the setup checklist). A chunky "Your week" card: the headline large; spent and usual with the difference badge; top 3 categories; budgets at risk ("Over by ₹X" red / "On pace for ₹X" amber), each linking to `/budgets`; due in the next 7 days (count and total, the first few items); links to the month report (`/cash-flow?month=` of the week's last day) and Budgets. A "Hide for this week" button stores the dismissal in localStorage under `pfm:digest-dismissed:<user id>:<week_start>` (the checklist's pattern), so the next week's digest shows again. A failed call hides the card.

When it shows: the backend's default switches weeks at Sunday 6 pm IST, so the card shows the week that ended on the last Sunday evening from then until the next Sunday evening, unless it was dismissed for that week. The client needs no clock logic.

### Android app

- A dashboard card in the app's chunky style (not the website's layout): headline, spent-vs-usual tile with a coloured badge, a line for budgets at risk and for what's due; tapping it opens the digest screen. A small "Hide" text button dismisses it for that week, kept in SecureStore per user and week (the app's store; see below).
- `/digest` screen: fetched live; sections for spending, top categories, budgets at risk (tap → Budgets), due in the next 7 days (tap → Next 30 days); "This week so far" toggle (`week=current`).
- **Weekly summary notification** with `expo-notifications`, local only (no push server, no FCM): a repeating weekly trigger, Sunday 19:00 device time, on an Android channel "Weekly summary". The text is generic ("Your week in money is ready", "See what you spent and what's due next.") because a local notification can't fetch data; `data.url = "/digest"`. Tapping it opens the digest screen, which fetches `/digest` live.
- **Profile → "Weekly summary" switch**, off by default. Turning it on creates the channel, asks for notification permission (Android 13+), and schedules the reminder; refused permission turns the switch back off with a line on how to allow it in settings. Turning it off cancels the schedule. The choice is kept per device in SecureStore; on app start a stored "on" re-schedules the reminder if it's missing (idempotent: it cancels by our identifier first).

### Streak

- Website: the orange streak box leaves the sidebar's main area; a quiet one-line "🔥 N-day logging streak" sits collapsed in the sidebar footer above Log out (*my call*: the website has no profile or settings page). The login page's "Streak 🔥 12" tile is decoration and stays.
- App: the streak chip leaves the dashboard header; Profile keeps its streak tile.
- `GET /streak` is unchanged.

## Testing

Backend tests first (`tests/test_digest.py`), with frozen dates and times: Sunday night and Sunday afternoon, Monday morning, a week spanning a month boundary, the 1st of a month, a user with fewer than 4 weeks of history and with none, no spending, the cash-flow rules (transfers, EMI interest, income), budgets over / on pace / fine, due within 7 days vs later, `week=current` same-day comparison, a future week, other users' data. Clients: pure helpers (`digest.test.mjs`) for dismissal keys, badge tone and the notification schedule.

## Device-check list (Android)

`expo-notifications` is a new native module: **the app needs a new build** before any of this can be checked on a phone.

1. Profile → Weekly summary on: Android 13+ asks for notification permission; deny → the switch goes back off with the settings hint; allow → it stays on.
2. A notification arrives on Sunday around 7 pm (it may be a few minutes late: inexact alarm, no exact-alarm permission asked); it survives a reboot.
3. Tapping it opens the digest screen with live figures, from a cold start and from the background.
4. Turning the switch off: no notification the next Sunday.
5. Dashboard: the "Your week" card, its Hide button, and that the card returns the following week; no streak chip on the dashboard; streak still on Profile.
6. The notification's small icon (the adaptive icon's monochrome layer, tinted #FFC800 by the `expo-notifications` config plugin) looks right in the status bar and shade.
7. The digest screen: "Last full week" / "This week so far", budgets at risk open Budgets, "Month report" opens the right month, "Next 30 days" opens the list.

`npx expo-doctor` flags only patch-version mismatches that were there before (expo, expo-dev-client, expo-font, expo-linking, expo-local-authentication, expo-router, expo-secure-store, expo-status-bar); nothing about `expo-notifications` (installed at ~58.1.9 by `npx expo install`).

## Design calls made by Claude ("do what's best"), not yet confirmed by the owner

1. **A Sunday counts as whole from 6 pm IST**, so the default week flips at 6 pm Sunday, an hour before the app's reminder, and the website card appears Sunday evening.
2. **`week` takes any date in the week, or `current`**; a week that hasn't started is refused.
3. **Usual = average of up to 4 earlier weeks over the same days**; a week whose compared days end before the first transaction doesn't count; no comparison with no history.
4. **"About the same as usual" within ±5%**, decided exactly on the server and sent as `tone`.
5. **On pace to go over** = month not whole, 50% ≤ used < 100% and used > elapsed + 10 points (a budget used exactly up isn't flagged); budgets judged for the month holding the week's last counted day, up to that day.
6. **Due = today → today + 7 days**, overdue included, whatever week is shown: it's about what's coming.
7. **Local notification only**, Sunday 19:00 device time, generic text; off until turned on in Profile; inexact (no exact-alarm permission).
8. **Dismissals**: website localStorage per user and week; app SecureStore per user and week.
9. **Web streak** goes to a quiet line in the sidebar footer.
10. **Notification channel** "weekly-summary", default importance.
