# Weekly Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly digest ("you spent X, Y more than usual", top categories, budgets at risk, due next 7 days) on the website dashboard and in the Android app, with a Sunday local notification on the app; the streak leaves the dashboard.

**Architecture:**
- **Logic:** `backend/app/api/digest.py` (week windows, usual, on pace, headline), pure functions.
- **Route:** `backend/app/api/routes/digest.py` (`GET /digest`), reusing `cash_flow`, `routes.budgets.MonthBook`/`month_rows` and `routes.upcoming.upcoming_items` (pulled out of `/upcoming`).
- **No migration.**
- **Website:** `components/dashboard/weekly-digest-card.tsx`, `lib/digest.ts`; streak to the sidebar footer.
- **App:** `components/digest-card.tsx`, `app/digest.tsx`, `lib/digest.ts`, `lib/weekly-summary.ts` (expo-notifications); Profile switch; streak chip off the dashboard.

**Spec:** [docs/superpowers/specs/2026-11-13-weekly-digest-design.md](../specs/2026-11-13-weekly-digest-design.md).

## Global Constraints

- Money is `Decimal`, crosses the API as 2-decimal strings. Clients do no money arithmetic; percents, labels and the headline come from the server.
- Tests freeze "now" by patching `now_india` in the digest route and `today_india` where other routes are used.
- Web and Android each get their own UI.

## Review Focus

1. The week's spending equals `/cash-flow`'s rules over the same days.
2. Defaults on Sunday afternoon, Sunday night and Monday morning.
3. Usual with 0, 2 and 4+ weeks of history; same-days comparison for this week so far.
4. "On pace" and the month chosen at a month boundary.

---

### Task 1: Rules and design
- [x] "Weekly digest" in `financial-calculations.md`, the spec and this plan.

### Task 2: Backend (test first)
- [x] `tests/test_digest.py`: frozen-time cases, red.
- [x] `now_india()` in `app/api/dates.py`; `app/api/digest.py`; `routes/digest.py`; `upcoming_items` pulled out of `/upcoming`.

### Task 3: Website
- [x] `lib/digest.ts` + `digest.test.mjs` (dismissal key, tones), added to `npm test`.
- [x] `weekly-digest-card.tsx`, one line in the dashboard.
- [x] Streak: out of the sidebar's main area into a quiet footer line.

### Task 4: App
- [x] `npx expo install expo-notifications`; config plugin in `app.json`.
- [x] `lib/digest.ts` + test; `lib/weekly-summary.ts` (channel, permission, weekly schedule, cancel).
- [x] Dashboard card, `/digest` screen, notification tap → `/digest`.
- [x] Profile "Weekly summary" switch; streak chip off the dashboard.

### Task 5: Checks
- [x] Backend pytest + ruff; frontend lint, test, tsc, build; mobile lint, typecheck, test, expo-doctor.
- [x] Device-check list in the spec.
