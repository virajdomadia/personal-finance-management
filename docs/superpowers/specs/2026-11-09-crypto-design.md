# Crypto: design

## Why

The owner holds a little Bitcoin and Ethereum on CoinDCX. The app doesn't show it today, so net worth is short by about ₹2,000 and the money that went bank → CoinDCX is untraced. This is the third investment type in Milestone 4, after [stocks](2026-11-08-stocks-design.md) and [mutual funds](2026-11-09-mutual-funds-design.md), and it reuses their model: `instruments` with a `kind`, `investment_trades` with `amount` as the money source of truth, and `instrument_prices`.

The owner **isn't adding to these holdings**. No SIP and no new buys are planned. The goal is to record what's held, value it, and keep the app correct if the owner ever sells (or, rarely, buys).

The owner's CoinDCX figures (screenshots, 9 Nov 2026, 19:31–19:35):

| Coin | Total qty | Avg. buying price | Invested | LTP (19:31) |
|---|---|---|---|---|
| Bitcoin (BTC) | 0.00014067 | ₹70,66,858.22 | ₹994.11 (shown on the BTC page) | ₹75,04,827.5 |
| Ethereum (ETH) | 0.00485 | ₹2,05,135.15 | ₹994.11 (owner, from the ETH page) | ₹2,13,349.1 |

CoinDCX's overview shows Invested ₹1,988 (= ₹994.11 + ₹994.11, rounded down), current value ₹2,089, and P&L +₹101 (5.1%). CoinDCX's average price isn't exactly invested ÷ quantity: for BTC, ₹994.11 ÷ 0.00014067 = ₹70,66,965.24 against its ₹70,66,858.22, and the gap is presumably fees. The app keeps "invested" exact and derives the average from it, so its averages will read ₹70,66,965.24 (BTC) and ₹2,04,971.13 (ETH). That's accepted.

The buys, per CoinDCX's transaction lists (quantities only; the app doesn't show a per-trade price or fee):

| Date | BTC | ETH |
|---|---|---|
| 14 Apr 2026 | 0.00003499 | 0.00108 |
| 05 May 2026 | 0.00003195 | 0.00109 |
| 28 May 2026 | 0.0000336 | 0.00124 |
| 05 Jul 2026 | 0.00004014 | 0.00143 |
| **Sum** | 0.00014068 | 0.00484 |

The sums are off by one in the last place from the totals (0.00014067 and 0.00485), probably because of fees taken in coin and display rounding. INR deposits from the bank were ₹500 each (05 May, 28 May, 26 Jun, plus earlier ones). The INR balance on CoinDCX is **₹0** today.

## Decided with the owner

- Money flows **bank → CoinDCX INR balance → buy coin**, and **sell coin → CoinDCX INR balance → bank**. This is the same flow as stocks through a broker.
- There are no crypto SIPs and no new investment is planned. Recording the existing holdings is the main job.
- Everything is entered by hand, including prices, as for stocks and funds.

## Model

### Quantity widening

`investment_trades.quantity` goes from `Numeric(18,3)` to **`Numeric(24,8)`**. That is strictly wider: 16 integer digits instead of 15, and 8 decimals instead of 3. Every existing value fits unchanged, and PostgreSQL keeps the values exactly when it rescales them.

**No stock or fund figure may change.** Existing outputs are already formatted per kind (`fmt_units` gives 3 decimals for funds, and stocks give whole numbers), so the wider column doesn't change any response. A migration test, like the funds one, records every stock and fund figure (portfolio, holdings, trades, dashboard) before the migration and checks they're identical after it. Stock and fund input validation keeps its own limits: whole shares, and at most 3 decimals for units.

`instrument_prices.price` and `investment_trades.price` stay `Numeric(14,4)`. That holds up to ₹99,99,99,999.9999, enough for BTC at ₹75 lakh, and 4 decimals covers coins priced in paise. `amount` stays `Numeric(14,2)`.

### Crypto coin

An instrument of kind **`crypto`**:

| Field | Meaning |
|---|---|
| `symbol` | The ticker, e.g. `BTC`, `ETH`. Required, 1–20 characters, upper-cased, unique per user among crypto. |
| `name` | e.g. "Bitcoin". 1–60 characters, required. |

### Exchange account

CoinDCX's INR balance is an account of the existing type **`broker`**, with institution "CoinDCX". No new account type is added. Bank → CoinDCX and CoinDCX → bank are ordinary transfers, which already work.

### Crypto trades

A crypto trade uses the same row as stock and fund trades. Its rules:

| | Crypto |
|---|---|
| Account | an active `broker` account |
| Quantity | more than 0, at most **8 decimals** |
| Price | per coin in ₹, more than 0, at most 4 decimals |
| `charges` | Buy: trading fee + GST. Sell: trading fee + GST + 1% TDS, together. |
| `amount` | **Entered.** Buy: the INR that left the CoinDCX balance. Sell: the INR that arrived in it. |
| Opening ("Add existing coins") | yes: coin, account, total quantity, amount invested, approximate date. Price stored = `round(amount ÷ quantity, 4)`. No cash moves. |

`amount` is entered rather than computed, as for funds: an 8-decimal quantity times a price is rarely exactly what the exchange debited.

**Consistency check** (buy and sell, not opening): quantity × price must be within ₹1.00 of `amount − charges` for a buy, and of `amount + charges` for a sell. The error goes on `quantity`: "Quantity × price doesn't match the amount. Check the quantity and price."

**Cash and cost** follow stocks and funds exactly: a buy takes `amount` from the broker cash and that's the lot's cost. A sell adds `amount` to it, and realised P&L = `amount` − FIFO cost. Fractional FIFO works as it does for fund units: exact `Decimal` quantities and the paise-remainder rule. TDS is counted as a charge, so realised P&L is after TDS. The app makes no tax claim, as with stocks.

**Prices** behave like stocks: recording a trade **doesn't** record a price. "Update price" records the price for a date. A coin is valued at its latest recorded price, or at cost until one is recorded. Value = `round_paise(quantity × latest price)`.

### Archiving

A broker account can't be archived while it holds coins, as with shares. The message names the reason.

## Net worth and dashboard

Crypto counts in investments exactly as stocks and funds do: current value in "You have" and net worth, and in the dashboard's overall investments figure (value, unrealised ₹ and %).

## API

The builder shapes these in the style of the fund routes, covering:

- Coins: list, create, rename, delete (delete only when the coin has no trades), with `kind = crypto`.
- Crypto trades: create, edit, delete, with the rules above. Quantity crosses the API as a string with 8 decimals (`"0.00014067"`), and price with 4.
- Prices: record, list, delete.
- Portfolio: **existing fields stay unchanged** (`holdings`, `by_stock`, `closed`, `totals`, `funds`, and so on), so the installed Android app keeps working. Crypto goes in a new `crypto` object (holdings, closed, totals), and `overall` includes it.
- Dashboard `investments` = overall, now including crypto.

## Clients

Each platform gets its own UI on the shared backend, never a copy of the other.

- **Web:** the Investments page gains a **Crypto** section beside Stocks, Mutual funds and Deposits, with a summary (invested, value, unrealised, realised) and coin rows. A coin page shows quantity, average price, holdings per account, trades and price history. Actions: Buy, Sell, Add existing coins, Update price.
- **Android:** the Investments tab's segments gain **Crypto**. It has a coin list, a coin screen, and phone forms with the same actions. With four segments, the builder may make them fit (shorter labels or a scrollable row).
- Quantities show up to 8 decimals with trailing zeros trimmed (0.00485, not 0.00485000). Prices show 2 decimals when they have no more.

## Follow-ups folded in

1. **The bank account page lists investment debits and credits.** Today it shows transactions only, so stock, fund and crypto trades that move an account's cash don't appear, even though the balance is right. The account page (web and Android) lists, in date order, every non-opening investment trade on that account alongside its transactions, read-only, labelled "Bought 0.00004 BTC" / "SIP: Parag Parikh Flexi Cap", and so on, with the signed amount. Editing stays on the investment's own page. (PPF and RD contributions are already transfers, so they already show.)
   - *Claude's call:* the trades come from a **new endpoint** (e.g. `GET /accounts/{id}/investment-activity`, optionally by month). `GET /transactions` and its rows stay unchanged, so the installed app isn't shown trades as editable transactions. The trades **don't count** in the income and expense totals: like a transfer, a buy moves money into investments rather than spending it. Each client merges them into the account's list by date.
2. **Missing test:** a hand-entered NAV on the same date as a fund trade means the trade doesn't create or take over a NAV (no NAV handover).
3. **Archive lock order:** `archive_account(bank)` locks the bank and then its PPFs. Change it to lock all the rows involved in ascending id order, so it can't deadlock with a PPF edit.

Not folded: the "SIP moved bank" due-month case. It's unrelated to crypto and stays open.

## Import

After deployment, a reviewed SQL script (tested on the dev database with a rollback first, and run by the owner with one PowerShell command) does the following:

- Creates the `broker` account "CoinDCX" (institution CoinDCX, opening balance ₹0) if the owner doesn't already have one.
- Creates the coins BTC "Bitcoin" and ETH "Ethereum".
- Adds **one opening purchase per coin**, dated 14 Apr 2026 (the first buy): BTC 0.00014067 for ₹994.11, and ETH 0.00485 for ₹994.11. Opening purchases move no cash.
- Leaves the past ₹500 Bank of India → CoinDCX transfers alone. They predate the owner's use of the app, so the Bank of India balance already reflects them through its opening balance and they aren't recorded as transactions. Creating them would double-count. *Claude's call.* The script itself reuses an existing active account named CoinDCX (any case) instead of creating a second, and prints any transactions already on it.
- Records today's prices: BTC ₹75,04,827.50, ETH ₹2,13,349.10.

Why not the four buys each: CoinDCX shows no per-trade price or fee, and the quantities don't add up to the holdings. One opening lot per coin matches CoinDCX's own invested figure and average price exactly.

## Non-goals

Live prices or an exchange API; CoinDCX CSV import; crypto SIPs; futures, options, staking/Earn and Web3 wallets; coin-to-coin trades; transfers of coins between exchanges or wallets; crypto tax (30% gains tax, TDS credit tracking); XIRR.

## Design calls made by Claude ("do what's best"), not yet confirmed by the owner

1. **Widen `quantity` to `Numeric(24,8)`**, strictly wider than today, with per-kind formatting so stock and fund outputs don't change.
2. **CoinDCX is a `broker` account**, not a new "exchange" type.
3. **`amount` is entered** for crypto, as for funds.
4. **TDS counts as a sell charge.** Realised P&L is after TDS.
5. **Trades don't record a price** (stock behaviour). Prices come from "Update price".
6. **History is imported as one opening lot per coin**, dated 14 Apr 2026, at CoinDCX's invested figure; the past ₹500 transfers aren't recreated.
7. **The ₹1.00 consistency check** applies to crypto buys and sells.
8. Three follow-ups are folded in (account page lists investment trades, the NAV test, the archive lock order). The SIP bank-move one isn't.
