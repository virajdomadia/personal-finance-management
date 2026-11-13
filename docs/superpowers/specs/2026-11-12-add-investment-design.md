# One "Add investment" flow: design

## Why

Complaint 6 of the product review (2026-11-12): the app has a screen for each thing a developer stores. Adding a stock you already own meant "add stock", then "add trade", and later "add price" and "link". The Android app has 11 investment form screens: `stock-form`, `trade-form`, `price-form`, `nav-form`, `link-form`, `sip-form`, `fund-form`, `fund-trade-form`, `coin-form`, `coin-price-form` and `crypto-trade-form`. The website mirrors them as dialogs, with Buy, Sell, Add existing and Add SIP buttons on every section of the Investments page.

Phase 6 of the review plan sets what "done" means:

- One **Add investment** entry point. It asks for the type (stock, mutual fund, crypto, deposit), then the instrument, and records the first purchase in the same flow.
- Price, NAV, link and SIP are actions on the holding screen, not top-level entry points. So are buying more and selling.
- The app's investment form screens are at least halved. The website gets the same single entry point, designed for the web.

## The flow

1. **Type.** Stock, mutual fund, crypto, PPF or RD. A fund can also be started as a SIP ("Start a SIP"), because a SIP can begin before any units are bought.
2. **Instrument.** Pick one you already have, or add a new one. A new one offers the market search from the nightly prices feature ("Find it": NSE stocks, AMFI funds, CoinGecko coins). Picking a match fills in the name (and the symbol for stocks and coins) and links it to live prices. Typing a name and symbol by hand still works for anything the search doesn't know.
3. **First purchase.** "Buy now" (moves the account's cash) or "I already hold it" (existing shares, units or coins, which move none). The same fields as today's buy.
4. **One save.** A new instrument and its first purchase are created together by one request, or not at all.

**Deposits** are accounts (`POST /accounts` with `type` `ppf` or `rd` and an opening balance). That is already one save, so the flow opens the account form with the type chosen. Nothing changes on the backend for them.

## Backend

Today a new instrument with a purchase is two requests: `POST /investments/stocks`, then `POST /investments/trades`. If the trade is refused (say the broker is archived, or the price is missing) the stock is left behind with no trades. The clients worked around it by keeping the new stock selected for a retry.

Three composite routes make it atomic. Each takes the existing create body for the instrument and the existing create body for the trade, minus the instrument id and the side:

| Route | Body | Response |
|---|---|---|
| `POST /investments/stocks/with-trade` | `{stock: {symbol, name, source_code?}, trade: {account_id, date, quantity, price, charges?, opening?, note?}}` | `201 {stock: Stock, trade: Trade}` |
| `POST /investments/funds/with-trade` | `{fund: {name, symbol?, source_code?}, trade: {account_id, date, units, nav, charges?, amount, opening?, note?}}` | `201 {fund: Fund, trade: FundTrade}` |
| `POST /investments/coins/with-trade` | `{coin: {symbol, name, source_code?}, trade: {account_id, date, quantity, price, charges?, amount, opening?, note?}}` | `201 {coin: Coin, trade: CryptoTrade}` |

- The first trade is always a buy (`side` is not accepted). `opening: true` records existing holdings.
- Every rule is the existing one, run by the same code: the instrument is validated and flushed, then the trade goes through the kind's `*_save_checks` against it, then one commit. Any refusal rolls both back.
- Errors keep the existing field names. Instrument fields (`symbol`, `name`, `source_code`) and trade fields (`account_id`, `quantity`, `units`, `nav`, ...) never share a name, so the clients' `splitErrors` (which reads the last `loc` element) maps them to the right input.
- A fund trade records its NAV as that day's price, and a linked instrument gets its market price at once, exactly as the two separate requests did.
- No migration. Every existing route keeps its shape.

## Android app

| Before (11) | After (5) |
|---|---|
| `trade-form`, `fund-trade-form`, `crypto-trade-form` | `trade-form?kind=stock\|mutual_fund\|crypto` |
| `price-form`, `nav-form`, `coin-price-form` | `price-form?kind=…` |
| `stock-form`, `fund-form`, `coin-form`, `link-form` | `holding-form?kind=…` (rename, delete, and live-price link on one screen) |
| `sip-form` | `sip-form` |
| | `add-investment` (new: the type step) |

- The Investments tab loses its three per-segment speed dials (Buy, Sell, Add existing, Add SIP, Record SIP). One extended FAB, **Add investment**, shows on every segment, including Deposits.
- `add-investment` is a short list of big tiles, one per type. A tile replaces itself with the trade form for that kind (or the account form for PPF and RD), so Back goes straight to the tab.
- The trade form's "new stock / fund / coin" part gains the market search (it only had typed fields on the app) and saves through the composite route.
- The holding screens (`stock`, `fund`, `coin`) keep Buy, Sell or Redeem, Update price or NAV, Link and SIPs. They now point at the merged screens. Due SIP cards on the tab still open Record SIP directly.
- The three trade forms are tuned, tested screens (about 2,500 lines). They become one route that picks the kind's form component, moved to `src/components/trade-forms/`, rather than one rewritten form. *Claude's call:* this halves the screens without risking the trade rules each form encodes.

## Website

- The Investments page header gets one **Add investment** button. It opens a two-step dialog. Step 1 is a grid of type cards (with "Start a SIP" under it). Step 2 is that kind's trade dialog in buy mode, with a "Back" link to step 1 and a "Step 2 of 2" line. PPF and RD open the account dialog with the type chosen.
- The section buttons (Buy, Sell, Add existing, Add SIP) go. Buying more, selling and SIPs are on each holding's page, which already has them, along with Update price or NAV and Link.
- The empty states keep their copy (first-run owns it). Their buttons open the Add investment dialog at step 2 for that kind.
- The trade dialogs' "New stock / fund / coin..." option saves through the composite route.

## Design calls made by Claude

- **Three routes, not one with a `kind` field.** Each kind already has its own create and trade bodies and response shapes; a union would need a discriminator and three response types anyway.
- **`/with-trade` lives next to its instrument** (`/stocks/with-trade`) so the existing routers and helpers own it. `POST /stocks/{id}` doesn't exist, so the path can't clash.
- **The type step on the app replaces itself** with the next screen instead of pushing, so a save's `router.back()` lands on the tab and no screen needs to know it was reached from the add flow.
- **Picking a coin match fills the ticker** from the match's name (`"Bitcoin (BTC)"` → name `Bitcoin`, symbol `BTC`); a stock match fills the symbol with its NSE code; a fund only fills the name, since its symbol is derived.
- **Inline "New fund" in the SIP form stays**, so starting a SIP for a fund not yet held is still possible from the add flow ("Start a SIP").
- **Record SIP for a SIP that isn't due** moves from the tab's speed dial to the SIP's card on the fund screen, which already had it.
