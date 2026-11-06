# Google Sign-In and Database User Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared password with Google sign-in for one user stored in Postgres, on both the website and the Android app, and add a fingerprint lock to the app.

**Architecture:** Both clients get a Google ID token and exchange it at `POST /api/auth/google` for a signed 30-day API token. The website keeps that token in an httpOnly cookie and its proxy forwards it as a Bearer header; the app keeps it in SecureStore. The API trusts only Bearer tokens, so `API_SECRET`, `SESSION_SECRET` and `APP_PASSWORD_HASH` all go away.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, `google-auth`, Next.js 16, Google Identity Services, Expo SDK 58, `expo-local-authentication`.

**Spec:** No separate document. The decisions below were agreed in conversation on 2026-11-06, except those marked "builder's call".

## Decisions

- One user, in a `users` table. There is no sign-up route: a row can only be created by a server command, and that table is the allowlist.
- A Google account matches by `google_sub` once linked. The first login links by verified email.
- Recovery is a server command that moves the user to another Google account.
- UIs are platform-native, not replicas. Android only.
- Order of work: backend, website, deploy, then app. The app is tested only against the deployed API, with no LAN setup.
- Builder's call: logging out a lost device means revoking all sessions through `session_version`, not per-device sessions. Signing back in takes one tap.
- Builder's call: the fingerprint lock is a UI lock over a token stored in SecureStore, not hardware-bound to the token. `requireAuthentication` on SecureStore would prompt on every read and break when fingerprints change.
- Builder's call: lock on cold start and after 5 minutes in the background, with the device PIN allowed as a fallback.
- Builder's call: one merge cuts everything over, because no one else uses the system. Rollback is reverting the merge commit.

## Global Constraints

- Work on branch `google-sign-in`. Do not merge to `main` until Task 4.
- Never commit secrets, or print them to chat. The user sets Vercel variables and runs production database commands; Vercel writes are blocked for Claude.
- Dev Postgres is port 5434 (`npm run db:start`). Never touch the system service on 5432.
- Verify ID tokens against the **web** client ID on both platforms. Android requests its ID token using `webClientId`, so that is its `aud`.
- `verify_oauth2_token` checks signature, `aud` and `exp` only. Check `iss` (`accounts.google.com` or `https://accounts.google.com`) and `email_verified` ourselves.
- Local dev stays open when `TOKEN_SECRET` is unset. Production must never fall open.
- Do not add iOS configuration.

## Review Focus

Each line is pinned by an automated test in the task named, or by a device or production check where only a real run can show it.

1. A revoked or user-less token whose signature is still valid: the website goes to `/login` with no redirect loop, and the app returns to login. (Test in Task 2; checks in Tasks 4 and 7)
2. A different Google account signs in: clear rejection, and no row is created or changed. (Task 2)
3. An email that matches but a different `sub`, as with a recycled or moved account: rejected. (Task 2)
4. Google's keys or the database are unreachable during login: 503 and a "try again" message, not "account not allowed". (Task 2)
5. Fingerprint cancelled, none enrolled, or the app offline: cancel stays locked with a retry, no device security does not trap the user, and being offline never logs out. (Check in Task 7)

---

### Task 1: Users table and admin commands

**Files:**
- Create: `backend/app/models/user.py`, `backend/app/cli.py`, `backend/tests/conftest.py`, `backend/tests/test_cli.py`, `backend/migrations/versions/<generated>_create_users.py`
- Modify: `backend/app/models/__init__.py`, `backend/migrations/env.py` (only if autogenerate needs it), `README.md`

**Interfaces:**
- Produces: `User` with `id: int`, `email: str` (unique, lowercase), `google_sub: str | None` (unique), `session_version: int` (default 1), `created_at: datetime`.
- Produces: `create_user(db, email) -> User`, `move_user(db, old_email, new_email) -> User`, `revoke_sessions(db, email) -> User`, all in `app/cli.py`, plus `python -m app.cli create-user|move-user|revoke-sessions`.
- Produces: pytest fixture `db_session` in `conftest.py` (in-memory SQLite with `StaticPool`, overriding `get_db`).

- [ ] **Step 1: Create the branch**

Run: `git switch -c google-sign-in`

- [ ] **Step 2: Write failing tests in `test_cli.py`**

```python
def test_create_user_lowercases_email(db_session):
    assert create_user(db_session, "Me@Gmail.com").email == "me@gmail.com"

def test_create_user_rejects_a_second_user_with_same_email(db_session):
    create_user(db_session, "me@gmail.com")
    with pytest.raises(ValueError):
        create_user(db_session, "ME@gmail.com")

def test_move_user_clears_link_and_revokes_sessions(db_session):
    user = create_user(db_session, "old@gmail.com")
    user.google_sub = "123"
    moved = move_user(db_session, "old@gmail.com", "new@gmail.com")
    assert (moved.email, moved.google_sub, moved.session_version) == ("new@gmail.com", None, 2)

def test_revoke_sessions_bumps_version(db_session):
    create_user(db_session, "me@gmail.com")
    assert revoke_sessions(db_session, "me@gmail.com").session_version == 2

def test_unknown_email_raises(db_session):
    with pytest.raises(ValueError):
        revoke_sessions(db_session, "nobody@gmail.com")
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `cd backend && uv run pytest tests/test_cli.py -q`
Expected: FAIL on import.

- [ ] **Step 4: Implement the model and commands**

Use `argparse`, with no new dependency. The CLI exits non-zero with a one-line message on `ValueError`, and uses `SessionLocal`, so it follows `DATABASE_URL`.

- [ ] **Step 5: Generate and check the migration on dev Postgres**

Run: `npm run db:start`, then from `backend/`: `uv run alembic revision --autogenerate -m "create users"`, `uv run alembic upgrade head`, `uv run alembic downgrade base`, `uv run alembic upgrade head`.
Expected: all succeed, and the migration creates only `users`.

- [ ] **Step 6: Document production database commands in `README.md`**

Cover setting `DATABASE_URL` from Neon's direct (unpooled) connection string for one shell, running `alembic upgrade head`, and each recovery command. State plainly that `move-user` is the way back in after losing a Google account.

- [ ] **Step 7: Run tests, then commit**

Run: `cd backend && uv run pytest -q && uv run ruff check .`
Commit: `git commit -m "Add a users table with admin commands"`

### Task 2: Google login and Bearer-only API

**Files:**
- Create: `backend/app/core/google.py`, `backend/app/api/deps.py`, `backend/tests/test_google_login.py`, `backend/tests/test_access.py`
- Modify: `backend/app/core/security.py`, `backend/app/core/config.py`, `backend/app/api/routes/auth.py`, `backend/app/api/router.py`, `backend/.env.example`, `backend/pyproject.toml`
- Delete: `backend/tests/test_api_secret.py`, `backend/tests/test_auth.py`

**Interfaces:**
- Consumes: `User`, `db_session`.
- Produces in `security.py`: `create_token(user_id: int, session_version: int, secret: str, now: float | None = None) -> str` and `parse_token(token: str, secret: str, now: float | None = None) -> TokenClaims | None`, where `TokenClaims` has `user_id`, `session_version`, `expires_at`.
- Token format: `"{user_id}.{session_version}.{expiry_seconds}.{base64url_hmac_sha256}"`, signing everything before the last dot. Task 3 verifies this format in Node.
- Produces in `google.py`: `GoogleIdentity(sub: str, email: str)`, `verify_google_id_token(token: str, client_id: str) -> GoogleIdentity`, `InvalidGoogleToken`, `GoogleUnavailable`.
- Produces in `deps.py`: `get_current_user(request, db) -> User` and `CurrentUser`.
- Produces routes: `POST /api/auth/google` with `{"id_token": str}` returning `{"token": str}`; `GET /api/auth/session` returning `{"email": str}`.
- Config: remove `api_secret` and `app_password_hash`; keep `token_secret`; add `google_client_id: str = ""`.

- [ ] **Step 1: Add the dependency**

Run: `cd backend && uv add "google-auth[requests]"`

- [ ] **Step 2: Write failing tests**

In `test_google_login.py`, monkeypatch `verify_google_id_token` in the route module.

```python
def test_first_login_links_the_verified_email(...)        # 200, token returned, google_sub stored
def test_later_login_matches_by_sub_after_email_change(...)  # 200
def test_unknown_account_is_rejected_and_creates_no_row(...) # 403, users count unchanged
def test_same_email_with_different_sub_is_rejected(...)      # 403, stored sub unchanged
def test_invalid_google_token_returns_401(...)               # InvalidGoogleToken -> 401
def test_google_unavailable_returns_503(...)                 # GoogleUnavailable -> 503
def test_database_failure_returns_503(...)                   # SQLAlchemyError -> 503
def test_login_closed_when_not_configured(...)               # empty client id or secret -> 503
```

Also test `verify_google_id_token` by patching `id_token.verify_oauth2_token`: a wrong `iss` or `email_verified` False raises `InvalidGoogleToken`; `ValueError` raises `InvalidGoogleToken`; `google.auth.exceptions.TransportError` raises `GoogleUnavailable`.

In `test_access.py`, cover:

```python
def test_health_and_google_login_are_the_only_public_routes(...)
def test_unknown_paths_are_guarded(...)                  # /api/not-a-route -> 401
def test_old_api_secret_header_is_no_longer_accepted(...)
def test_production_without_token_secret_stays_closed(...)
def test_development_without_token_secret_uses_first_user(...)
def test_token_for_a_deleted_user_is_rejected(...)       # 401
def test_token_with_old_session_version_is_rejected(...) # 401
def test_malformed_tokens_do_not_crash(...)  # "", "garbage", "a.b.c.d", "é.é.é.é", 5000 digits
def test_tampered_token_is_rejected(...)
def test_token_expires_after_thirty_days(...)
def test_token_vector(...)  # create_token(7, 2, "vector-secret", now=1000) equals a fixed string
```

Record the fixed string once it is generated. Task 3 asserts the same value in Node.

- [ ] **Step 3: Run them to confirm they fail**

Run: `cd backend && uv run pytest tests/test_google_login.py tests/test_access.py -q`
Expected: FAIL on import.

- [ ] **Step 4: Implement**

- Remove `verify_password` and the old login. The middleware stays deny-by-default: only `/health` and `/auth/google` are public, and everything else needs a token that passes `parse_token`.
- Put protected routes on a router created with `dependencies=[Depends(get_current_user)]`, which re-checks the user and `session_version` against the database.
- Update `.env.example`.

- [ ] **Step 5: Run tests, then commit**

Run: `cd backend && uv run pytest -q && uv run ruff check .`
Expected: all pass.
Commit: `git commit -m "Replace the API password and secret with Google login"`

### Task 3: Website login with Google

**Files:**
- Create: `frontend/src/components/google-sign-in-button.tsx`
- Modify: `frontend/src/lib/auth.ts`, `frontend/src/lib/auth.test.mjs`, `frontend/src/proxy.ts`, `frontend/src/lib/api.ts`, `frontend/src/components/api-status.tsx`, `frontend/src/app/login/actions.ts`, `frontend/src/app/login/page.tsx`, `frontend/.env.example`, `frontend/package.json`, `README.md`
- Delete: `frontend/src/app/login/login-form.tsx`, `frontend/scripts/hash-password.mjs`

**Interfaces:**
- Consumes: the Task 2 token format and routes.
- Produces: `isValidSessionToken(token, secret, now?)` for the new format, in seconds; `loginWithGoogle(credential: string): Promise<LoginState>`; `logout()`.
- Env: `TOKEN_SECRET` (same as the API), `API_URL`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. Remove `API_SECRET`, `SESSION_SECRET`, `APP_PASSWORD_HASH`.

- [ ] **Step 1: Write failing tests in `auth.test.mjs`**

Replace the password tests.

```js
test("accepts the token vector generated by the backend", ...)  // same fixed string as test_token_vector
test("rejects a tampered token", ...)
test("rejects an expired token", ...)
test("rejects malformed tokens", ...)  // "", "garbage", "a.b.c", "1.2.3.4.5"
test("rejects any token when the secret is empty", ...)
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npm --prefix frontend test`
Expected: FAIL on the vector test.

- [ ] **Step 3: Implement token checks and the proxy**

The proxy validates the cookie with `TOKEN_SECRET`, sends `Authorization: Bearer <cookie>` on `/api/*`, and deletes the cookie header. Keep the local-dev bypass when `TOKEN_SECRET` is unset, and keep production closed. Remove `hashPassword`, `verifyPassword`, the `hash-password` script and its `package.json` entry.

- [ ] **Step 4: Implement the login page**

- `google-sign-in-button.tsx` loads `https://accounts.google.com/gsi/client` with `next/script`, calls `initialize` with `callback` and `use_fedcm_for_button: true`, and renders Google's own button.
- `loginWithGoogle` posts to `${API_URL}/api/auth/google` and sets the same httpOnly cookie as today.
- Copy: 403 shows "This Google account doesn't have access."; 503 or a network failure shows "Sign-in isn't available right now. Try again in a few minutes."
- Design it as a desktop-first page, not a port of the Android layout.

- [ ] **Step 5: Handle revoked sessions**

`ApiStatus` calls `/auth/session` before `/health`, because health is public and cannot detect a dead session. A 401 calls `logout()`, which clears the cookie and goes to `/login`. That breaks the loop where the proxy would otherwise send a valid-looking cookie back to `/`.

- [ ] **Step 6: Update the README's access-control section, then run checks**

Run: `npm --prefix frontend test && npm --prefix frontend run lint && npm --prefix frontend run build`
Expected: all pass.

- [ ] **Step 7: Commit**

Commit: `git commit -m "Log in to the website with Google"`

### Task 4: Google setup and production cutover

Steps marked **User** are done by the user. Do not ask for secret values.

**Files:**
- None, unless verification finds a bug.

**Interfaces:**
- Consumes: Tasks 1 to 3 on the branch.
- Produces: a live website login, and the web client ID that Task 5 needs.

- [ ] **Step 1 (User): Create the Google project**

In Google Cloud Console, create a project and configure the OAuth consent screen as External. Testing status is fine: Google's docs say the 7-day expiry doesn't apply to Sign in with Google. List your Gmail as a test user. Create an OAuth client of type **Web** with authorized JavaScript origins `https://finance.virajdomadia.com` and `http://localhost:3000`. Confirm localhost's requirements on Google's client ID page at this step, because the docs read during planning didn't cover them.

- [ ] **Step 2 (User): Set Vercel variables**

`personal-finance-api`: `GOOGLE_CLIENT_ID`, `TOKEN_SECRET`. `personal-finance`: `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and the same `TOKEN_SECRET`.

- [ ] **Step 3 (User): Prepare the production database**

Using the README commands, run `alembic upgrade head`, then `python -m app.cli create-user <your Gmail>`.
Expected: the command reports the user was created.

- [ ] **Step 4: Merge and push, with the user's confirmation**

Run the full test suites first: `npm run test && npm run lint`. Then fast-forward `main` to the branch and push.

- [ ] **Step 5: Verify production**

- `/api/health` returns 200; `/api/auth/session` with no token returns 401; `/api/auth/login` returns 401 from the middleware.
- User: sign in with the allowed account, reach home, and log out.
- User: sign in with another Google account and see the access message.
- User: run `revoke-sessions`, reload the website, and land on `/login` with no loop.

- [ ] **Step 6 (User): Remove the old values**

Delete `API_SECRET`, `SESSION_SECRET` and `APP_PASSWORD_HASH` from both Vercel projects if set, and delete `.env.login.local`. The firewall rule for password guessing is no longer needed.

### Task 5: Android Google sign-in

**Files:**
- Create: `mobile/src/lib/google.ts`
- Modify: `mobile/src/lib/session.tsx`, `mobile/src/app/login.tsx`, `mobile/src/app/index.tsx`, `mobile/app.json`, `mobile/package.json`, `README.md`

**Interfaces:**
- Consumes: `POST /api/auth/google`, `GET /api/auth/session`, and the web client ID.
- Produces: `getGoogleIdToken(): Promise<string | null>`, where `null` means the user cancelled, and `signOutOfGoogle(): Promise<void>`. `useSession()` replaces `logIn(password)` with `logIn(): Promise<void>`.

- [ ] **Step 1: Choose the library**

Expo's guide offers `react-native-nitro-google-signin` (Credential Manager) and `@react-native-google-signin/google-signin`, whose Credential Manager support is paid and whose free module uses Google's deprecated SDK. Use the nitro library if its current docs confirm it is free and it passes `npx expo-doctor` on SDK 58. Otherwise use the free `@react-native-google-signin` module and tell the user it relies on the deprecated SDK. All library use stays inside `google.ts`, so changing later touches one file.

- [ ] **Step 2: Implement sign-in**

- Install with `npx expo install`, add the config plugin without Firebase and without any iOS option, and pass the web client ID as `webClientId` from a constant in `google.ts`. It isn't secret.
- A cancelled picker returns `null` and shows no error.
- Login screen: keep the title and the thumb-reach layout, replace the password field with a single Google button, and remove the password state.
- Copy matches the website: 403 and 503 messages from Task 3, and "Can't reach the server. Check your connection and try again." for network failures.
- Log out also calls `signOutOfGoogle`, so the account picker appears next time.

- [ ] **Step 3: Confirm session behaviour**

Read `index.tsx` and confirm that a 401 logs out, and that a network error shows the failure card and keeps the token. The current code does both, so no change should be needed.

- [ ] **Step 4: Run checks, then commit**

Run: `cd mobile && npx tsc --noEmit && npx expo lint && npx --yes expo-doctor && npx expo export --platform android --output-dir "$TEMP/pfm-export"`
Expected: all pass. Delete the export folder afterwards.
Commit: `git commit -m "Log in to the Android app with Google"`

### Task 6: Fingerprint lock

**Files:**
- Create: `mobile/src/lib/app-lock.ts`, `mobile/src/lib/app-lock.test.mjs`, `mobile/src/lib/use-app-lock.ts`, `mobile/src/components/lock-screen.tsx`
- Modify: `mobile/src/app/_layout.tsx`, `mobile/app.json`, `mobile/package.json`

**Interfaces:**
- Produces in `app-lock.ts`: `shouldLock(backgroundedAt: number | null, now: number): boolean` with `LOCK_AFTER_MS = 5 * 60 * 1000`.
- Produces in `use-app-lock.ts`: `useAppLock(enabled: boolean): { locked: boolean; unlock: () => Promise<void> }`.

- [ ] **Step 1: Write failing tests for `shouldLock`**

Keep `app-lock.ts` free of native imports so Node can run it, in the style of `auth.test.mjs`, and add `"test": "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test src/lib/app-lock.test.mjs"`.

```js
test("locks on a cold start", ...)                  // shouldLock(null, now) === true
test("stays unlocked just under five minutes", ...) // now - 299_999 -> false
test("locks at five minutes", ...)                  // now - 300_000 -> true
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npm --prefix mobile test`
Expected: FAIL on import.

- [ ] **Step 3: Implement the lock**

- Install `expo-local-authentication` with `npx expo install`, and add its plugin.
- Use `AppState` to record when the app goes to the background.
- If `getEnrolledLevelAsync` reports no device security, do not lock.
- `authenticateAsync` allows device PIN fallback.
- `lock-screen.tsx` is a Material screen with "Unlock" and "Log out". Cancelling or failing stays on it, and "Log out" is the way out if the sensor is broken.
- Render it over the navigator only when logged in and locked, so finance data never shows behind it.
- Add `npm --prefix mobile test` to the root `test` script.

- [ ] **Step 4: Run checks, then commit**

Run: `npm --prefix mobile test && cd mobile && npx tsc --noEmit && npx expo lint && npx --yes expo-doctor`
Expected: all pass.
Commit: `git commit -m "Add a fingerprint lock to the Android app"`

### Task 7: Build and test on the phone

**Files:**
- Modify only if the device test finds a bug.

**Interfaces:**
- Consumes: Tasks 5 and 6, deployed API from Task 4.

- [ ] **Step 1 (User): Register the app with Google**

From `mobile/`: run `npx eas-cli@latest login` and `npx eas-cli@latest init` if not done, then read the SHA-1 from `npx eas-cli@latest credentials` (Android). Create an OAuth client of type **Android** with package `com.virajdomadia.personalfinance` and that SHA-1. Check the `development` and `production` profiles separately, since the docs don't say they share a keystore, and create one client per distinct SHA-1.

- [ ] **Step 2 (User): Build and install**

Run: `npx eas-cli@latest build -p android --profile production`, then install the APK.

- [ ] **Step 3 (User): Test on the phone**

- Sign in with the allowed account; a different account shows the access message; cancelling the picker shows no error.
- Close and reopen the app: it asks for a fingerprint and stays signed in. Cancel stays locked. Unlock works. Five minutes in the background locks it; a short switch doesn't.
- Airplane mode: shows the failure card and stays logged in. Pull-to-refresh recovers.
- `revoke-sessions`: reopening returns to login.
- Check the earlier unverified items: the top bar's menu icon and light and dark themes.
- If Google returns `DEVELOPER_ERROR`, the SHA-1 or package name in the Android client is wrong.

- [ ] **Step 4: Commit the Expo project ID, merge and push, with the user's confirmation**

Run: `npm run test && npm run lint`, then fast-forward `main` and push.
Update `project-infra-decisions` in memory: Google login, users table, removed variables.
