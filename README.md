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

The frontend proxies `/api/*` to the backend in `frontend/src/proxy.ts`, so browser code calls `/api/...` on the same origin. Set `API_URL` in `frontend/.env.local` to point at a different backend.

## Access control

The app has one password and no user accounts. Nothing below is enforced locally unless you set the variables; in production, a missing variable keeps the app locked.

- `frontend/src/proxy.ts` sends visitors without a valid session cookie to `/login`, and returns 401 for `/api/*`.
- It adds a secret header to requests it forwards. `backend/app/core/security.py` rejects anything without that secret, so the API can't be used directly. Only `/api/health` is public.

| Variable            | Vercel project                         | Purpose                   |
| ------------------- | -------------------------------------- | ------------------------- |
| `API_SECRET`        | `personal-finance`, `personal-finance-api` | Same value on both        |
| `SESSION_SECRET`    | `personal-finance`                     | Signs the session cookie  |
| `APP_PASSWORD_HASH` | `personal-finance`                     | Hash of the login password |

To change the password, run `npm --prefix frontend run --silent hash-password < file-containing-password`, set the output as `APP_PASSWORD_HASH` in Vercel, and redeploy the frontend. Changing `SESSION_SECRET` logs out every session.

## Scripts

| Command        | What it does                         |
| -------------- | ------------------------------------ |
| `npm run dev`  | Start frontend and backend together  |
| `npm run lint` | ESLint (frontend) + Ruff (backend)   |
| `npm run test` | Frontend auth tests + backend pytest |

## Adding an API endpoint

1. Create `backend/app/api/routes/<name>.py` with an `APIRouter`.
2. Include it in `backend/app/api/router.py`.
3. Call it from the frontend with `apiFetch("/<path>")` from `@/lib/api`.
