# Personal Finance Manager

Monorepo: **Next.js** (App Router, TypeScript, Tailwind) website + **Expo** Android app, both on one **FastAPI** (Python 3.12, uv) backend. Each client has its own UI designed for its platform.

```
.
├── frontend/          Next.js app (port 3000)
│   └── src/
│       ├── app/           routes & layouts
│       ├── components/    UI components
│       └── lib/api.ts     typed fetch helper for the backend
├── mobile/            Expo Android app (Material Design, react-native-paper)
│   └── src/
│       ├── app/           screens (Expo Router)
│       └── lib/           API client, session, theme
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

The website needs a local user: after `alembic upgrade head`, run `uv run python -m app.cli create-user <email>` from `backend/`, otherwise the local site shows the login page.

The frontend proxies `/api/*` to the backend in `frontend/src/proxy.ts`, so browser code calls `/api/...` on the same origin. Set `API_URL` in `frontend/.env.local` to point at a different backend.

## Access control

Sign-in is with Google, and only accounts in the `users` table get in (see the admin commands below). Nothing here is enforced locally unless you set the variables; in production, a missing variable keeps the app locked.

- The login page uses Google Identity Services and sends Google's ID token to `POST /api/auth/google`. The API checks it, finds the user and returns its own 30-day token, which the website keeps in an httpOnly cookie.
- `frontend/src/proxy.ts` sends visitors without a valid session cookie to `/login`, and returns 401 for `/api/*`. It forwards the cookie's token to the API as `Authorization: Bearer ...`.
- `backend/app/core/security.py` rejects anything without a valid token, so the API can't be used directly. Only `/api/health` and `/api/auth/google` are public.
- If the API says the session is no longer valid, the website clears the cookie and returns to `/login`.

| Variable                       | Vercel project                             | Purpose                                      |
| ------------------------------ | ------------------------------------------ | -------------------------------------------- |
| `TOKEN_SECRET`                 | `personal-finance`, `personal-finance-api` | Signs and verifies session tokens, same value on both |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | `personal-finance`                         | Google OAuth web client ID for the login button |

Changing `TOKEN_SECRET` logs out every session.

## Production database commands

Users live in the `users` table. Migrations and the admin commands run from your machine against Neon, never from Vercel. In a shell, from `backend/`, set `DATABASE_URL` to Neon's direct (unpooled) connection string for that shell only; do not put it in `backend/.env`:

```
$env:DATABASE_URL = "<Neon direct connection string>"   # PowerShell
uv run alembic upgrade head
```

Then run any of these (emails are lowercased):

- `uv run python -m app.cli create-user you@gmail.com` adds a user who may sign in.
- `uv run python -m app.cli move-user old@gmail.com new@gmail.com` points the user at a different Google account. It clears the Google link and signs the user out everywhere.
- `uv run python -m app.cli revoke-sessions you@gmail.com` signs the user out of every device.

`move-user` is the way back in after losing a Google account: run it with the old and new emails, then sign in with the new account.

## Android app

The app always talks to the deployed API, so build new features in this order: backend, website, deploy, then app.

The app signs in with Google, through `react-native-nitro-google-signin` (Android Credential Manager) and `src/lib/google.ts`. It sends Google's ID token to `POST /api/auth/google` and keeps the API's token in secure storage. Google needs an Android OAuth client for the package `com.virajdomadia.personalfinance` and the SHA-1 of the key that signs the build, so each signing key needs its own client. Sign-in only works in a development or production build, not Expo Go.

First time only, from `mobile/`:

```bash
npx eas-cli@latest login
npx eas-cli@latest init    # links the project and adds its ID to app.json
```

| Goal                              | Command (from `mobile/`)                                |
| --------------------------------- | ------------------------------------------------------- |
| Build the app to develop against  | `npx eas-cli@latest build -p android --profile development` |
| Build the app for everyday use    | `npx eas-cli@latest build -p android --profile production`  |
| Start the dev server              | `npm run dev:mobile` (from the repo root)               |

Both builds produce an APK to install directly. Rebuild the development app only when native dependencies change; JavaScript changes reload from the dev server.

## Scripts

| Command        | What it does                         |
| -------------- | ------------------------------------ |
| `npm run dev`  | Start frontend and backend together  |
| `npm run dev:mobile` | Start the Android app's dev server |
| `npm run lint` | ESLint and type checks (frontend, app) + Ruff (backend) |
| `npm run test` | Frontend auth tests + backend pytest |

## Adding an API endpoint

1. Create `backend/app/api/routes/<name>.py` with an `APIRouter`.
2. Include it in `backend/app/api/router.py`.
3. Call it from the frontend with `apiFetch("/<path>")` from `@/lib/api`.
