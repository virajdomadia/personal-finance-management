# Personal Finance Manager

Monorepo: **Next.js** (App Router, TypeScript, Tailwind) frontend + **FastAPI** (Python 3.12, uv) backend.

```
.
├── frontend/          Next.js app (port 3000)
│   └── src/
│       ├── app/           routes & layouts
│       ├── components/    UI components
│       └── lib/api.ts     typed fetch helper for the backend
└── backend/           FastAPI app (port 8000)
    ├── app/
    │   ├── main.py        app factory, CORS, router mount
    │   ├── core/config.py settings (pydantic-settings, reads .env)
    │   └── api/routes/    endpoint modules
    └── tests/
```

## Prerequisites

- Node.js 22+
- Python 3.12+ and [uv](https://docs.astral.sh/uv/)

## Getting started

```bash
npm run setup   # installs root, frontend, and backend deps
npm run dev     # runs Next.js on :3000 and FastAPI on :8000
```

- App: http://localhost:3000
- API docs (Swagger): http://localhost:8000/api/docs

The frontend proxies `/api/*` to the backend through a rewrite in `frontend/next.config.ts`, so browser code calls `/api/...` on the same origin. Set `API_URL` in `frontend/.env.local` to point at a different backend.

## Scripts

| Command        | What it does                         |
| -------------- | ------------------------------------ |
| `npm run dev`  | Start frontend and backend together  |
| `npm run lint` | ESLint (frontend) + Ruff (backend)   |
| `npm run test` | Backend pytest suite                 |

## Adding an API endpoint

1. Create `backend/app/api/routes/<name>.py` with an `APIRouter`.
2. Include it in `backend/app/api/router.py`.
3. Call it from the frontend with `apiFetch("/<path>")` from `@/lib/api`.
