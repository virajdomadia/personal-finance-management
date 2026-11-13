# Export, Backup and Restore Implementation Plan

**Goal:** Fix complaint 9: CSV export, a versioned JSON backup, a tested restore CLI. Backend, website, Android app.

**Spec:** [docs/superpowers/specs/2026-11-13-export-backup-design.md](../specs/2026-11-13-export-backup-design.md). No migration.

## Global constraints

- Exports are read-only and only contain the signed-in user's rows (tested with a second user).
- Tables are discovered from `Base.metadata`; the coverage test fails on any unclassified table.
- Restore runs in one transaction and remaps every primary and foreign key.

## Tasks

- [x] **Backend tests first:** `tests/test_export_coverage.py` (classification, FK targets, stray `_id` columns, JSON columns), `tests/test_export_restore.py` (rich fixture user in every exported table, export, restore into a fresh user, identical `/dashboard`, `/cash-flow`, `/budgets`, `/safe-to-spend`, `/upcoming`, `/investments/portfolio`, `/accounts`, `/goals`; refusals: revision, non-empty, `--replace`; other users never exported), `tests/test_export_api.py` (backup and CSV endpoints, BOM, headers, plain numbers).
- [x] **Backend code:** `app/export/tables.py` (classification), `app/export/backup.py` (dump, restore, delete), `app/export/csv_export.py`, `app/api/routes/export.py`, `app/cli.py` (`export-user`, `restore-user`).
- [x] **README:** backup format and restore procedure in `backend/README.md`.
- [x] **Website:** `/data` page, sidebar link, downloads through the `/api` proxy.
- [x] **App:** Profile "Export my data", `expo-file-system` + `expo-sharing`, device-check list entry.
- [x] **Checks:** backend pytest (SQLite and PostgreSQL), ruff; frontend lint, test, tsc, build; mobile lint, typecheck, test.

## Results

- Backend: 1426 passed, 83 skipped on SQLite (whole suite); the 18 export tests pass on PostgreSQL (`pfm_export_test`, migrated by Alembic).
- Not yet seen rendered: the website page was linted, type-checked and built but not viewed against a live backend; the app's Export my data needs a new build (`expo-file-system`, `expo-sharing`) and is on the device-check list.
- When the `net-worth` branch merges, `net_worth_snapshots` is backed up automatically, but `tests/export_fixture.py` needs a snapshot row or `test_the_fixture_fills_every_exported_table` fails, on purpose.
