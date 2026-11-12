# First-run setup and empty states: design

## Why

Complaint 10 from the product review: "Empty first screen; setting up 10 accounts before seeing any value." A new user lands on a dashboard that says "Nothing here yet" and is sent to an accounts page with one big "Add account" button. Nothing tells them what to add first, what's optional, or how far along they are. Every list screen that's empty says something different, or nothing.

This is the "first-run setup" and "empty states" part of Phase 7 in [the product review plan](../plans/2026-11-12-product-review-plan.md). Invites and `is_admin` are a separate piece of work and not in this spec.

**Done when** (complaint row 10): a new user with no data sees a guided checklist: salary account, cards, loans, SIPs and investments, then SMS on the app. It can be skipped and resumed, the dashboard shows progress, and every screen has a written empty state.

## The checklist

| Step | Key | Done when (from the user's own data) | Web goes to | App goes to |
|---|---|---|---|---|
| Your main bank account | `bank` | an active (not archived) `bank` account | Accounts, with the add dialog open on Bank, kind Salary | Account form on Bank, kind Salary |
| Credit cards | `cards` | an active `credit_card` account | Accounts, add dialog on Credit card | Account form on Credit card |
| Loans | `loans` | an active `loan` account | Accounts, add dialog on Loan | Account form on Loan |
| Salary, rent and SIPs | `recurring` | an active recurring reminder or an active SIP | Recurring, with the add dialog open | Reminder form |
| Investments | `investments` | any stock, fund or coin, or an active PPF or RD | Investments | Investments tab |
| Bank SMS (app only) | `sms` | SMS reading is turned on on this phone | (not shown) | Bank SMS settings |

The first five come from `GET /api/setup`. The last is phone state, so the app decides it from its own SMS settings.

### Endpoint

`GET /api/setup` returns

```json
{"user_id": 7, "steps": [{"key": "bank", "done": true, "count": 1}, {"key": "cards", "done": false, "count": 0}, ...]}
```

in the order above. `count` is how many of that thing the user has (accounts, reminders plus SIPs, holdings plus deposits), so a client can say "2 added". Every query is scoped to the user. No money crosses this endpoint, and nothing is written.

### Not everyone has a loan

A user with no credit card would never finish. So every step except the bank account has **"Not for me"**. It marks the step as skipped; skipped steps count toward progress ("4 of 6") and can be undone. If the user adds a card later, the step simply shows as done.

### Skip, resume, hide

The checklist has three modes, kept on the device:

- **Open:** the full checklist card at the top of the dashboard. This is the default.
- **Later** ("Skip for now" on the web, "Later" on the app): a one-line strip, "Finish setting up · 3 of 6 done", with **Resume** (back to open) and **Don't show again** (to hidden).
- **Hidden:** gone from the dashboard.

Once every step is done or skipped, the checklist disappears, whatever the mode.

### Where it lives

- **Website:** one self-contained component, `SetupChecklist`, inserted at the top of the dashboard with one line. It fetches `/api/setup` itself on mount and when the tab regains focus, so steps tick off when the user comes back from adding something.
- **App:** one self-contained component, `SetupChecklist`, inserted at the top of the dashboard body with one line. It reloads on screen focus (`useFocusEffect`) and reads the SMS setting at the same time.

Web and Android get their own designs. The website shows a chunky card with a progress bar and numbered rows, each a link. The app shows its chunky list rows (emoji square, title, one-line hint; a green tick square once done) inside a chunky box, the whole row tappable, with large tap targets, and "Not for me" as a compact secondary button on the row.

## Empty states

Every list screen gets a written empty state: what the screen is for, in one or two short sentences, plus one clear action. No jargon ("entity", "record", "instrument"). Same shape everywhere on each platform:

- **Website:** a new `EmptyState` component (emoji, title, one or two lines, one button or link) in `frontend/src/components/ui/empty-state.tsx`, built from the existing chunky card and `buttonClass`.
- **App:** a new `EmptyState` component in `mobile/src/components/chunky/empty-state.tsx` (emoji, title, text, one `ChunkyButton`), exported from the chunky index.

Investment screens are being reworked by the "Add investment" work in parallel, so on those screens only the empty-state **text** changes; their layout stays as it is.

## Design calls made by Claude

- **Skipping and hiding are stored on the device, not in the database**, per signed-in user, because family members may share a phone or browser: key `gullak.setup.<userId>`. Web uses `localStorage` and takes the id from the `user_id` that `/api/setup` now returns; the app uses `expo-secure-store` and takes the id from its token (`userId.sessionVersion.expiry.signature`). No migration. A user on a second device sees the checklist again there; that's acceptable for a one-time helper.
- **While `/api/setup` loads**, the website shows the dashboard's own "Nothing here yet" box (the fallback), so a new user never sees a blank gap. The app holds the space with a small "Checking your setup..." strip, unless the checklist was gone last time or is hidden (it remembers what it last showed, per user).
- **"Not for me" is also stored on the device**, for the same reason.
- **Any bank account counts as "main bank account"**, not only one marked Salary, because many people get paid into a savings account. The add form starts on kind Salary as a hint.
- **The SIP step also counts recurring reminders** and vice versa (one step: "Salary, rent and SIPs"), so a user who only has a salary reminder isn't nagged about SIPs.
- **PPF and RD count as investments**, matching the Investments tab where they live.
- **Existing users see the checklist too** (in Open mode) until they finish, skip or hide it. It costs one tap and they likely have a missing step anyway.
- **No way back after "Don't show again"**, other than clearing site data or reinstalling. "Later" is the resumable option; Hide is meant to be final.
- **The step order is fixed by the backend**, and the app adds the SMS step last.
- **The SMS step only appears in an app build that has the SMS reader** (`isAvailable()` from the `sms-inbox` module), so an older build isn't asked for something it can't do.
- **"Not for me" is also a TalkBack action on the row**, because the row is one accessibility node and the button inside it isn't reachable on its own.
- **Steps are counted, not money:** the clients count done steps for "3 of 6" and the progress bar. No amounts are involved.
- **The website dashboard's old "Nothing here yet" box is replaced** by the checklist when there are no accounts and the checklist is showing. The box is passed to the checklist as its `fallback`, so if the user hid the checklist (or it fails to load) the box is still there. On the app, the Net worth tile's small "Add your first account" button stays: it's part of the tile, and changing the tile would collide with the parallel dashboard work.
