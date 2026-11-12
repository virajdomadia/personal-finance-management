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

Copy `backend/.env.example` to `backend/.env` first. It sets `ENVIRONMENT=development`; without it the API treats itself as production and rejects every request that lacks a valid token.

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
| `API_URL`                      | `personal-finance`                         | Where the website's proxy sends `/api/*` requests |
| `GOOGLE_CLIENT_ID`             | `personal-finance-api`                     | Same Google OAuth web client ID, used to verify ID tokens |
| `DATABASE_URL`                 | `personal-finance-api`                     | Neon connection string |
| `CORS_ORIGINS`                 | `personal-finance-api`                     | Origins allowed to call the API |
| `ENVIRONMENT`                  | `personal-finance-api`                     | Set to `production` |

Changing `TOKEN_SECRET` logs out every session. `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is read at build time, so redeploy the website after changing it.

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

- The `iosUrlScheme` value in `mobile/app.json` is a placeholder the sign-in library's plugin demands. It is unused on Android.
- If the account picker appears and then returns to the login screen with no error, the Android OAuth client's SHA-1 or package name is wrong, because the library reports that mismatch as a cancel.

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

## SMS transactions

The Android app can fill in transactions from bank SMS. It is off until the owner turns on "Fill in transactions from bank SMS" in the profile screen, which asks for Android's `READ_SMS` permission.

- **What the phone reads.** Only when the app is opened or brought to the front. The native reader returns the inbox messages since the start date to the app, which keeps only those from known bank, card and depository (CDSL, NSDL) senders. Messages from anyone else are dropped there: they are never parsed, stored or sent.
- **What the server gets.** The phone parses each SMS and sends only the fields (kind, amount, date, last 4 digits, payee, reference, balance) plus a hash of the text. The raw SMS stays on the phone. The one exception is "Send sample": after an explicit tap, one masked message (digits and names replaced) goes to `POST /api/sms/samples`.
- **Where the parsers are.** `mobile/src/lib/sms/`: `senders.ts` maps a sender header to a bank, `parse.ts` holds the per-bank patterns and a general reader for any other bank, `fixtures.mjs` has the sample messages and what each should parse to. The native inbox reader is the local Expo module `mobile/modules/sms-inbox`. The server side is `backend/app/sms/` and `backend/app/api/routes/sms.py`.
- **Adding a bank from a "Send sample".** Read the masked sample on the website's Payee rules page ("Samples sent from the phone"), add it to `fixtures.mjs` with its expected fields, add the sender header to `senders.ts` and a pattern to `parse.ts` if the general reader gets it wrong, run `npm run test` in `mobile/`, then ship it with `npx eas-cli@latest update` (parsers are JavaScript, so no new APK).
- **To review.** An SMS is recorded straight away when the account and amount are known, so balances match the bank. To review (website and app) asks only for what is missing: a category for a new payee (with "always use this for this payee" ticked by default, which saves a payee rule), the account for an unknown last 4, or whether an SMS is one of several manual entries or a transfer between your accounts. CDSL share movements are drafts until confirmed. Payee rules can be edited on their own page.

Deploy notes:

- The migration `e3b81f46a0d7` (add SMS tables) must be run on Neon by hand before merging, as in "Production database commands" above. Merging deploys the API.
- The app needs a new APK (`npx eas-cli@latest build -p android --profile production`), because of the native `sms-inbox` module and the new `expo-crypto` and `expo-clipboard` dependencies. `eas update` alone is not enough for this release.
- `READ_SMS` is a restricted permission, so the app can't be listed on the Play Store. It is installed as an APK.

## Scripts

| Command        | What it does                         |
| -------------- | ------------------------------------ |
| `npm run dev`  | Start frontend and backend together  |
| `npm run dev:mobile` | Start the Android app's dev server |
| `npm run lint` | ESLint and type checks (frontend, app) + Ruff (backend) |
| `npm run test` | Frontend auth, accounts and transactions tests + mobile app-lock and accounts tests + backend pytest |

## Adding an API endpoint

1. Create `backend/app/api/routes/<name>.py` with an `APIRouter`.
2. Include it in `backend/app/api/router.py`.
3. Call it from the frontend with `apiFetch("/<path>")` from `@/lib/api`.
