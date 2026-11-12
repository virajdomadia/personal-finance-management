# SMS Review Speed Implementation Plan

**Goal:** To review clears a normal week of drafts in under 5 minutes: drafts arrive with a suggested
category, each says why it is or isn't confident, and one confirmed tap approves every confident one.

**Spec:** `docs/superpowers/specs/2026-11-13-sms-review-speed-design.md`.

**Architecture:** a new read-only module `backend/app/sms/confidence.py` assesses an open entry
(suggestion, confident, why). `GET /sms/review` adds the assessment to every item and a server-made
`confident` summary. `POST /sms/review/approve` re-assesses and categorises each listed item in its
own savepoint through `review.categorise`. `POST /payee-rules` creates a rule from an entry's payee.
No ingestion changes (`sms/ingest.py` is untouched; its helpers are only imported). No migration.

## Global constraints

- Money stays `Decimal`; totals are made on the server and sent as strings.
- Category names always go through `usable` / `resolve`.
- Tests freeze "today" (`TODAY = 2026-11-13`, patched in every `app.*` module that imports
  `today_india`).
- Checks: `cd backend && uv run pytest -q && uv run ruff check .`; website
  `npm run lint && npm test && npx next typegen && npx tsc --noEmit && npm run build`; app
  `npm run lint && npm run typecheck && npm test`.

## Tasks

### Task 1: Backend assessment (tests first)

- [x] `backend/tests/test_sms_review_speed.py`: suggestion from history (most common, recency tie,
  archived skipped, other type ignored, other users ignored); confident at 3 of 3 and 4 of 5, not at
  2 of 2 or 3 of 4; rule source; every safety exclusion (card-bill candidate, typed-in duplicate,
  expected payment, other reasons, no payee); account suggestion; `why` texts.
- [x] `backend/app/sms/confidence.py` and the new `ReviewItem` fields (`suggested_category`,
  `suggested_account_id`, `confident`, `why`, `history_count`, `history_total`) plus the list's
  `confident` summary.

### Task 2: Approve all and learn (tests first)

- [x] Tests: approves only listed confident items, skips changed / answered / unconfident ones with
  reasons, per-item atomicity under a failing save check, no rules created, `learn` list, 200 cap,
  other user's ids skipped as not found.
- [x] `POST /sms/review/approve`; `POST /payee-rules`; `_record_categorised` honours `remember`.

### Task 3: Website

- [x] `frontend/src/lib/review.ts` types and pure helpers (`approveBody`, `confidentSummaryText`,
  `rememberLabel`) with tests in `review.test.mjs`.
- [x] Approve bar, confirmation dialog and result panel in `review-view.tsx`; `why` chip and prefill
  in `review-card.tsx`.

### Task 4: App

- [x] `mobile/src/lib/review.ts` helpers with tests.
- [x] `review.tsx`: approve button, paper `Dialog` confirmation, result card with "Always use" chips;
  `why` in each row's meta. `review-item.tsx`: prefilled category and account, `why` line.

## Device checks (pending install)

- To review: "Approve N confident" button, confirmation dialog totals, result card, "Always use"
  chips create rules.
- Review item: category chip and account preselected from history; the `why` line reads well.
