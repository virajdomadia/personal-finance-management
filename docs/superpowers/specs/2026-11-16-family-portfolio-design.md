# Family portfolio: design

## Why

The owner manages investments for their family (parents, spouse, children) and wants to see the family's investments together, without them mixing into the owner's own net worth, dashboard, budgets or Investments page.

## Decided with the owner

- One login, the owner's. Family members don't sign in.
- Family members' figures are kept **separate** from the owner's. Only a Family portfolio tab brings everyone together.
- Approach B: each family member is their own profile (a user with no login), managed by the owner.

## Approaches considered

- **A. Tag accounts with a member.** One user; accounts carry a member id. Every total (net worth, dashboard, snapshots, cash flow, budgets, upcoming, goals, investments, "You have") would have to leave family accounts out: over 30 places today, and every future feature. A missed filter silently mixes family money into the owner's figures. Rejected.
- **B. Members are profiles (chosen).** The app already keeps every user's data apart, so the owner's figures stay theirs with no filtering. New work is member management, choosing which profile a request acts for, and the Family tab.

## Model

- `users` gains `owner_id` (the owner, for a member; null for a real login) and `name` (a member's display name). A member's `email` is a placeholder, `family-<owner id>-<n>@members.invalid`, which no Google account can have. Sign-in refuses any user with an owner.
- A member never has members of its own.

## Acting for a member

- Requests carry an `X-Profile: <user id>` header. With none, or the owner's own id, the request is the owner's, as today. With a member's id, `get_current_user` returns that member after checking `owner_id` is the signed-in user; anyone else's id is refused (404), the same as a missing one.
- Always the signed-in owner, whatever the header: sign-in and session routes, SMS (the phone's SMS are the owner's), and the family routes themselves.
- Everything else (accounts, transactions, investments, imports, exports, goals, ...) works for whichever profile is chosen. The owner adds Papa's demat, PPF and holdings by switching to Papa and using the normal screens and imports.

## API (`/api/family`, always the signed-in owner)

- `GET /family`: `{ me: {id, name: "Me"}, members: [{id, name}] }`.
- `POST /family/members` `{name}` → 201. Name 1–40 characters, unique among the owner's members (ignoring case), not "Me". At most 10 members.
- `PATCH /family/members/{id}` `{name}`.
- `DELETE /family/members/{id}?confirm=<name>`: deletes the member and all their data. `confirm` must equal the member's name (ignoring case).
- `GET /family/portfolio`: per person (the owner first, then members by name): invested, value, unrealised and its percent, the same four figures per type (stocks, mutual funds, crypto, deposits), and their holdings (kind, name, symbol, account, quantity, invested, value). Plus the family's totals overall and per type. Each person's figures are exactly their own Investments page's (`get_portfolio`), so the two never disagree; deposits count at their balance, as on the Investments page.

## Clients

- **Switcher.** Website: at the top of the sidebar, "Viewing: Me ▾" listing the owner and members, plus "Manage family". App: the same on the Profile tab. The choice is remembered on the device and sent as `X-Profile` on every request. While viewing a member, a coloured bar on every page says "Viewing Papa's profile" with a "Back to me" button, so the owner never records their own spending into a member by mistake.
- **Family portfolio tab.** Website sidebar "Family" and an app tab: the family total, a split by person and by type, and each person's holdings, expandable.
- **Manage family.** Add, rename and remove members (removing asks to type the name).

## Left to the builder

- Exports, backups and imports act on the chosen profile, like everything else.
- The nightly snapshot and price jobs already run for every user, members included.

## Non-goals

- Family members signing in, sharing with another login, or permissions.
- A combined family net worth (bank accounts, loans); only investments are combined.
- Moving existing accounts between profiles.
