# Chunky & loud UI redesign: design

## Why

The owner finds both the website and the Android app "very bad boring" and wants "some cool looking UI so i dont get bored and stop using the app". The goal is a look that makes them *want* to open the app every day, so they keep logging. Today the web app is grey zinc with Arial and outlined boxes, no colour, icons or charts. The app is close to stock react-native-paper with a teal theme.

Success: the owner opens it and enjoys it. Anti-goal: something that looks fun but is harder to read or slower to use than today.

## Decided with the owner (via mockups)

The owner went from four moods (neon, playful bento, editorial, aurora glass) to **playful bento**, then from four bento variants to **B2 "Chunky & loud"**, then asked for a mix of **B2a (classic loud)** and **B2c (with charts & stickers)**. They approved the full set of phone screens and the web screens ("nice start updating"). The mockups live in `.superpowers/brainstorm/4979-1794386878/content/`:

- `all-screens.html`: every app screen (the reference for mobile)
- `web-screens-v2.html`: dashboard, transactions, investments, goals and login on the web (the reference for web)
- `chunky-variants.html`: B2a and B2c side by side

The look, in words:

- **Cream background** (`#FFFDF5`), near-black ink (`#1A1A1A`), white cards.
- **Thick ink outlines** (2.5px) and a **hard offset shadow** (`0 4px 0 ink`, no blur) on every card, button, chip, tab bar and input. Buttons look pressable. On press, they move down 4px and lose the shadow.
- **Bright tiles** for the headline numbers: green (net worth), yellow (you have), pink (you owe), blue (investments), purple (goals), orange (streak / due).
- **Rounded, heavy type**: Nunito, weights 700–900, tabular numbers for amounts.
- **Emoji as icons**: one per category, account type, investment kind and goal.
- **Bento grids** of tiles on summary screens. Lists are chunky rows with a coloured emoji square on the left and the amount on the right.
- **Charts inside tiles**: a stacked "where it is / where it went" bar with a legend, progress bars and rings for goals, and a price line on detail pages.
- **Stickers**: a rotated yellow badge on a tile when something good happens.
- **Friendly copy**: "Hey Viraj!", "Your money, but fun.", "SAVE ✓".
- **Platform-native, not a replica.** The web gets a sidebar, wide bento rows and real tables. The app gets a floating chunky bottom tab bar, phone-width stacks and full-screen forms. One backend serves both.

## Goals

1. Restyle **every** screen on both platforms in this look. On mobile that's login, lock, the five tabs, every form and detail screen, goals, recurring, insurance and archived accounts. On the web it's login, every `(app)` page and every dialog.
2. Add the three "fun" data features from the mockups that need **no database migration**:
   - **Logging streak**: the number of consecutive India-time days, ending today or yesterday, on which the user created at least one transaction. It's based on `created_at` (when they logged it), not the transaction `date`. It shows in the dashboard header (app), the profile screen (app) and the sidebar box (web).
   - **This month's spending by category**: the sum of this calendar month's money-out transactions per category, for the "where it went" bar on transactions (both platforms). It excludes transfers between the user's own accounts. Uncategorised spending goes in "Other", and only the top 4 categories are shown, plus "Other".
   - **Asset split**: how net-worth assets divide between bank/cash, deposits and investment kinds, for the "where it is" bar. It's derived from figures the dashboard already computes.
3. Fix contrast. White text on the bright tiles in the mockups fails WCAG AA. Use a deeper shade of each tile colour that gives ≥4.5:1 with white text, or use ink text on the light tiles (yellow, and green if needed). Keep the colours recognisably the mockup's. All functional text is ≥11px.

## Non-goals

- **Net-worth trend chart and the "NEW HIGH!" sticker.** Both need a net-worth history table, a Neon migration and weeks of data before they look like anything. They're deferred to a follow-up, and the dashboard's net-worth tile shows "▲/▼ this month" only if it can be computed without history. If it can't, it shows nothing extra.
- **Dark mode.** The mockups are light-only. Both platforms switch to the light theme. The "Loud at night" (B2b) variant is a possible follow-up. The web drops its `prefers-color-scheme: dark` styles, and the app forces the light theme.
- No new features beyond the above, no changes to what any screen does, and no navigation restructuring on the app. The five tabs stay, and goals/recurring/insurance stay under Profile.
- No technical renaming. The Android package (`com.virajdomadia.personalfinance`), the Expo slug and the URL scheme stay as they are, because Google sign-in and EAS are tied to them. Only the **display name** changes (see Brand).

## Brand (owner asked for a name, logo, favicon and app icon, and delegated the choice)

**Name: Gullak**, the Hindi word for the clay piggy-bank pot. It's about saving, warm and Indian, and it doesn't read like a bank. Picked by Claude from four options (Gullak, Chillar, Rupi, Paisa Pop) shown in `.superpowers/brainstorm/4979-1794386878/content/name-logo.html`.

**Logo**: an orange (`#FF7A00`) clay pot with a neck and a dark coin slot, a green (`#58CC02`) coin dropping in above it, and ink (`#1A1A1A`) outlines. For the app icon and favicon it sits on a yellow (`#FFC800`) rounded square with an ink border. The master is the SVG in `name-logo.html` (option 1). The favicon uses the simplified version (thicker strokes, no slot shading) so it reads at 16px.

**Where the name shows**: the web `<title>` ("Gullak", with the page name before it where pages set one), the sidebar top (logo + "Gullak"), the login page headline lockup, the app's `expo.name` ("Gullak") and the login screen.

**Files to produce** (one script renders them all from the SVG masters, using the `sharp` already installed under `frontend/node_modules`, plus Pillow for the `.ico`):
- Web: `frontend/src/app/icon.svg`, `frontend/src/app/favicon.ico` (16/32/48), `frontend/src/app/apple-icon.png` (180). Remove the unused Next starter SVGs in `frontend/public`.
- App: `mobile/assets/icon.png` (1024, full tile), `android-icon-foreground.png` (1024, transparent, pot and coin inside the centre 66% safe zone), `android-icon-background.png` (1024, solid yellow), `android-icon-monochrome.png` (1024, white silhouette on transparent), `splash-icon.png` (pot and coin, transparent). Set `adaptiveIcon.backgroundColor` and the splash background to `#FFC800`.
- Keep the master SVGs and the script in the repo (`branding/`), so the icons can be regenerated.

## Constraints

- **Existing behaviour stays.** Every existing lib test (`frontend` and `mobile` `npm test`) and backend test keeps passing. Accessibility the code already has (aria labels, `role="status"`/`alert`, focus rings, `aria-current`) is kept and restyled, never removed. The focus ring becomes a thick ink or yellow ring that matches the look.
- **Web stack**: Next 16, React 19 and Tailwind 4 (tokens via `@theme` in `globals.css`). Load Nunito with `next/font/google`. No component library is added.
- **Mobile stack**: Expo 58 and react-native-paper 5. Keep Paper for text inputs, menus, dialogs and date pickers, restyled through the theme (roundness, colours, fonts). Build the chunky look as a small set of own components. Load Nunito with `@expo-google-fonts/nunito` (new dependency).
- **Backend**: the streak and category breakdown are added to existing responses (dashboard and the transactions list, or one small new endpoint) **without a migration**, with pytest coverage.
- Per the owner's standing rules: after the web works, the app is tested against the deployed API, not a LAN IP. Before merge, confirm there's no Neon migration (there shouldn't be one).

## The building blocks (both platforms implement their own)

| Block | Look |
|---|---|
| **Tile** | rounded 18px, ink border, offset shadow, colour variant, optional emoji top-right, label (11–12px, 800) + value (16–22px, 900; "huge" 27–40px for headline) |
| **Sticker** | yellow circle, ink border, rotated 12°, 2 short words, overlapping the tile's top-right |
| **ChunkyButton** | primary = ink fill + white text; alt = white; colour variants (green save, pink sell). Uppercase 900 label, pressed state drops the shadow |
| **Row** | white card, ink border, small shadow; emoji square (34px, coloured) + title/meta + right-aligned amount (green in, red out) |
| **Chip / Segmented control** | pill chips (selected = ink fill), segmented control with yellow selected segment |
| **StackedBar + legend** | 14–16px pill with ink border, segments in tile colours |
| **ProgressBar / Ring** | green fill with ink edge; ring for goal cards and goal detail |
| **Due highlight** | pale yellow (`#FFF1C2`) row/tile for things needing attention |
| **Header** | big 900-weight title; back button is a small chunky square on detail screens; streak pill (orange) top-right where shown |
| **Tab bar (app)** | floating chunky bar, selected tab gets a yellow pill |
| **Sidebar (web)** | white with ink right border, "🐷 Personal Finance" (or similar) at top, selected link = yellow chunky pill, streak box at the bottom, log out below it |
| **Table (web)** | ink-bordered rounded table, yellow header row, emoji square on the name column, right-aligned tabular amounts |
| **Inputs** | ink border 2.5px, rounded 14px, bold text; the add-transaction form has a big centred amount and Spent / Got / Move kind buttons |

Emoji maps (category → emoji, account type → emoji, investment kind → emoji, with a fallback) live in each platform's lib with unit tests.

## Screen notes beyond the mockups

Screens not drawn in the mockups (accounts, recurring and insurance on the web; account transactions, archived accounts, all forms, fund/coin detail and dialogs) follow the same pattern. On the web that's a coloured summary bento on top and a chunky table or rows below. On the app it's a summary tile, then grouped rows. Dialogs and forms use the chunky inputs and buttons. Loading, error and empty states get the look too: a friendly line, a big emoji and a chunky retry or "add your first…" button.

## Calls made by Claude after the builder check (owner delegates these)

1. **What counts as "spent".** Transaction types are income, expense, transfer and emi. "Spent this month" and the "where it went" bar count **expense** transactions (by category) plus **EMI** transactions at their full amount, as one "EMI" segment, because the money leaves the owner's pocket. **Transfers never count**, including money into PPF/RD/FD, which is saving, not spending. Income never counts. "Got this month" (web transactions tile) is income only.
2. **Asset split.** Assets only, never liabilities. The groups are Bank & cash, Deposits (FD/RD/PPF), Stocks, Funds and Crypto, and empty groups are omitted. It's carried on the dashboard response. Web: the "Where it is" tile on the dashboard. App: its own full-width "Where it is" tile on the dashboard under the 2×2 grid. The app's Accounts "Total balance" tile shows the total **without** a bar (the mockup's pink segment is dropped).
3. **No other history charts.** Every "over time" bar series in the mockups is dropped, including the Investments tile's, for the same reason as the net-worth trend. The Investments tile shows worth, the unrealised gain and the Stocks/Funds/Crypto split bar.
4. **Sticker rules** (only these): **"DONE!"** on a goal that has reached its target. **"+N%"** on the investments tile when the unrealised gain is ≥ 10% (N rounded down). **"🔥 N"** milestone sticker on the streak pill/box at 7, 30 and 100+ days (from 7 to 29 days it shows as "7+", and so on, so it's not a new sticker every day). Nothing else gets a sticker.
5. **`react-native-svg` is added** to mobile, for rings, the price line and the stacked bar, if a View-based version is clumsy. It's a native module, so **a new EAS APK build is needed** before testing on the phone against the deployed API. Fonts come through `@expo-google-fonts/nunito` and the existing `expo-font`.
6. **The lock screen shows no user data.** It's a big 🔒 with "Welcome back!" and the unlock button. The mockup's streak line is dropped so nothing leaks before unlock.
7. **The dashboard goal tile (app)** shows the active goal with a target that is closest to done but not yet reached (highest percent, then the earliest created). If every goal is reached, it shows the most recently reached one with "DONE!". If there are no goals, the tile reads "🎯 Set a goal" and opens goal creation. The web dashboard lists all goals as in the mockup.

## Left to the builder

- Exact deeper tile hex values (subject to the contrast rule).
- Whether streak and breakdown ride on existing responses or a new endpoint.
- The emoji chosen per category and type.
- Whether the stock/fund/coin detail price line is drawn from stored price history (only when there are ≥2 price points; otherwise omit it).
- Small motion (button press, tile hover lift on web), kept subtle and disabled under `prefers-reduced-motion`.
- Order of work. The suggestion is web tokens and building blocks, then web screens, then the backend additions, then mobile.
