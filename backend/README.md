# Backend (FastAPI)

```bash
uv sync
uv run fastapi dev app/main.py   # http://localhost:8000/api/docs
uv run pytest
uv run ruff check .
```

## Tests on PostgreSQL

`uv run pytest` uses in-memory SQLite and skips the PostgreSQL-only tests. To run everything on PostgreSQL, point `TEST_DATABASE_URL` at a database whose name ends in `_test`. It's created if missing and wiped on every run.

```bash
npm run db:start   # from the repo root, if the local cluster isn't running
TEST_DATABASE_URL=postgresql+psycopg://pfm:<password>@localhost:5434/pfm_test uv run pytest
```

CI (`.github/workflows/backend.yml`) runs both. What the PostgreSQL tests cover is in [docs/architecture/testing.md](../docs/architecture/testing.md).
