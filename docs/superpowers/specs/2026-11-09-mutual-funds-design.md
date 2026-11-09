# Mutual funds: design

## Why

The owner invests in mutual funds through monthly SIPs debited from their bank account. Today the app doesn't show any of it: the bank balance drops each month and nothing records what that money became. This is the second investment type in Milestone 4, after [stocks](2026-11-08-stocks-design.md), and it settles the general investment model that the stocks design left open.

The owner's funds today, from their account statements (9 Nov 2026):

| Fund | SIP | Instalments | Invested | Units | NAV (05-Nov) |
|---|---|---|---|---|---|
| Parag Parikh Flexi Cap – Regular Growth | ₹3,000 on the 5th | 7, May–Nov 2026 | ₹21,000.00 | 253.462 | 84.3793 |
| SBI Large & Midcap – Regular Growth | ₹2,000 on the 5th | 7, May–Nov 2026 | ₹14,000.00 | 21.984 | 635.0943 |

Both are paid from the same bank savings account. Each instalment's statement line is: gross amount, less stamp duty (0.005%), net amount, NAV, and units allotted. For example, 3,000.00 − 0.15 = 2,999.85, and 2,999.85 ÷ 84.3793 = 35.552 units. When the 5th is a holiday, the instalment lands on the next working day (06-Jul, 07-Sep).

## Decided with the owner

- Mutual funds come next, as their own type with their own calculations.
- SIPs are debited **directly from the bank account**, not through a broker.
- Everything is still entered by hand. Automatic NAVs and statement (CAS) import stay out of scope for now.
- The owner left the rest to Claude ("do what's best"). Those calls are listed at the end.

## Model

### One investment model for every type

Stocks were built with their own tables, "until the second investment type arrives." That time has come. The three tables become general, matching the names already planned in the [database design](../../architecture/database-design.md):

| Today | Becomes | Change |
|---|---|---|
| `stocks` | `instruments` | gains `kind`: `stock` or `mutual_fund`. Unique per user on (`kind`, `symbol`). |
| `stock_trades` | `investment_trades` | `quantity` becomes `Numeric(18,3)`, `price` becomes `Numeric(14,4)`, and it gains `amount Numeric(14,2)` |
| `stock_prices` | `instrument_prices` | `price` becomes `Numeric(14,4)` |

The migration renames the tables and widens the columns in place. It backfills `amount` for the existing stock trades: buy = q × p + charges, sell = q × p − charges. **Production already holds the owner's 9 stock holdings, so the migration must keep every row and every figure unchanged.** A test checks that the stock figures from before the migration still come out the same after it.

**`amount` is now the source of truth for money.** It is a buy's cost, and a sell's proceeds. For stocks the server still computes it from quantity, price and charges, so stocks behave exactly as before. For funds the owner enters it, because units × NAV is never exactly the amount: 35.552 × 84.3793 = 2,999.81, not 2,999.85. The FIFO replay uses `amount` instead of recomputing it.

### Mutual fund

An instrument of kind `mutual_fund`:

| Field | Meaning |
|---|---|
| `name` | e.g. "Parag Parikh Flexi Cap – Regular Growth". 1–60 characters, required. |
| `symbol` | Optional short code the owner picks, e.g. `PPFCF`. If it's left blank, the server derives one from the name. It is unique per user among funds. Shown wherever space is short. |

### Fund transactions

A mutual fund trade uses the same row as a stock trade. Its rules differ in these ways:

| | Stock | Mutual fund |
|---|---|---|
| Account | an active `broker` | an active `bank` account |
| Quantity | whole shares | units, more than 0, at most 3 decimals |
| Price | ≤ 2 decimals | NAV, more than 0, at most 4 decimals |
| `charges` | brokerage and taxes | buy: stamp duty. Sell: exit load, STT and any TDS together. |
| `amount` | computed | entered. Buy: the gross amount paid (₹3,000.00). Sell: the amount received in the bank. |
| Opening (existing holdings) | yes | yes ("Add existing units": total units, amount invested, rough date) |

**Cash and cost.** A buy takes `amount` out of the bank account, and `amount` is the lot's cost. A sell puts `amount` into the bank account. Its realised P&L is `amount` minus the FIFO cost of the units sold. Stamp duty is part of the cost, so "invested" equals what left the bank and matches the statement's "Cost of Investment".

**Add existing units** (an opening purchase) stores `price = round(amount ÷ units, 4)`, the average purchase NAV. The consistency check below is skipped for it, and it never records a NAV, so a fund with only opening purchases shows "at cost" until a real NAV is entered.

**Consistency check on a buy:** units × NAV must be within ₹1.00 of `amount − charges`. That catches a typo, such as a misplaced decimal, without rejecting the statement's own rounding. The error goes on `quantity`: "Units × NAV doesn't match the amount. Check the units and NAV."

**Fractional FIFO.** A partial sale takes units from the oldest lots. Its cost share is `round_paise(cost × taken ÷ lot_units)`, and the remainder stays with the units left, exactly as for stocks. Unit sums are exact `Decimal` arithmetic, never floats.

### NAV

NAVs go in `instrument_prices`, with 4 decimals. **Recording a fund purchase or redemption that isn't an opening one also records its NAV as that day's price**, unless a NAV already exists for that fund and date. This differs from stocks on purpose: every SIP instalment comes with an official NAV, so the fund's value stays current without an extra step. "Update NAV" works like "Update price".

An auto-recorded NAV is linked to its trade by a nullable `instrument_prices.trade_id`, and it follows that trade:
- Editing the trade's NAV or date updates the NAV row, unless another NAV already exists for the new date, in which case the linked row is removed.
- Deleting the trade deletes its NAV row.

NAVs entered with Update NAV have no `trade_id` and are only deleted by hand. This keeps a mistyped NAV from lingering, and lets a fund be deleted once its trades are gone.

A fund's current value is `round_paise(units × latest NAV)`. On 05-Nov the Parag Parikh fund was 253.462 × 84.3793 = ₹21,386.95, which matches its statement.

### SIP

A new table, `sips`. One SIP is one standing monthly instruction:

| Field | Meaning |
|---|---|
| `instrument_id` | a mutual fund of the owner's |
| `account_id` | the active bank account it's debited from |
| `amount` | > 0, 2 decimals |
| `day` | 1–31. Debit day of the month, clamped to the month's length. |
| `start_date` | first instalment month |
| `active` | the owner can pause or stop a SIP. Its past instalments stay. |

**A SIP never posts on its own.** This is the project's rule for anything recurring. Instead:

- **Due:** every month from the SIP's `start_date` month up to the current month is checked. A month is due when its debit day (clamped) is on or before today (India's date), and no purchase for that SIP is recorded in that calendar month.
  - "Purchase for that SIP" means a trade with this `sip_id`, opening or not. Trades without a `sip_id` count only if they are for the same fund and account and are not opening.
  - So imported past instalments (opening, linked to the SIP) settle their months and are never debited again.
  - Missed months stay due until recorded, so the bank balance and holdings can't drift silently. The API returns the list of due months, oldest first.
  - The screens show one line per SIP: "Parag Parikh Flexi Cap: ₹3,000 SIP due since 5 Nov. Record it." If more than one month is due, the line adds "(2 months)", and recording fills the oldest first.
  - A stopped SIP (`active` false) is never due.
- **Record SIP** opens the purchase form pre-filled with:
  - date: this month's debit day
  - bank account and amount: from the SIP
  - stamp duty: `round_paise(amount × 0.00005)`
  - units: `round((amount − stamp duty) ÷ NAV, 3)`, half up, worked out as soon as a NAV is typed

  The owner types the NAV from the allotment email and checks that the units match it. They can change any field. For the owner's funds, these suggestions reproduce every statement line exactly (35.552 and 3.149).
- A SIP purchase is an ordinary fund purchase with `sip_id` set. A nullable `sip_id` on `investment_trades` links the instalment to its SIP for the "due" check and the history. The due check uses `sip_id` when it's present, and otherwise falls back to fund + account + month.

## Net worth and dashboard

- Funds count in investments exactly as stocks do: current value in "You have" and in net worth, and in the dashboard's investments figure (value, unrealised ₹ and %).
- Buying a fund moves money from the bank into investments, so net worth doesn't change on the day.
- A bank account can't be archived while it holds fund units or has an active SIP. The message names the reason.

## API

These are the builder's to shape, in the style of the stocks routes. They need to cover:

- Funds: list, create, rename and delete, as for stocks, with `kind`.
- Fund transactions: create, edit and delete, with the rules above.
- NAVs: record, list and delete.
- SIPs: list (with `due` and `due_date`), create, edit (amount, day, account, active) and delete. Deleting a SIP is allowed only when it has no instalments. Otherwise the owner stops it.
- Portfolio: **the existing response stays stock-only and unchanged**, so the Android app already installed keeps working: `holdings`, `by_stock`, `closed` and `totals`. Funds go in a new `funds` object (holdings, closed, totals, due SIPs), and the combined figures go in a new `overall` totals object.
- `GET /investments/stocks` and `GET /investments/trades` stay stock-only, with the same shapes, including integer `quantity`. Funds get their own routes, for example `/investments/funds` and `/investments/fund-trades`.
- The dashboard's `investments` figure becomes the overall one (stocks + funds), which the old app shows correctly as "Investments".
- Stock money and quantity fields keep their current formats (2 decimals, whole numbers) even though the columns widen.

## Clients

Each platform gets its own UI on the shared backend, never a copy of the other.

- **Web:** the Investments page gains a **Mutual funds** section beside Stocks, with its own summary (invested, value, unrealised, realised), fund rows and "SIP due" banners. The fund page shows units, average NAV, holdings per bank account, transactions, NAV history and the fund's SIPs. Actions: Record SIP, Buy (lump sum), Redeem, Add existing units, Update NAV, Add/stop SIP.
- **Android:** the Investments tab gains the same split (segmented Stocks | Mutual funds), due-SIP cards at the top, a fund screen, and phone forms. Record SIP needs as few taps as possible: open, type the NAV, check the units, save.
- Amounts and units are displayed with their statement precision: units to 3 decimals, NAV to 4.

## Importing the owner's history

After deployment, the owner's 14 past instalments go in through a reviewed SQL script, as the stocks import did. It covers both funds, their two SIPs, and the 05-Nov NAVs, with exact dates, amounts, stamp duty, NAVs and units from the statements. The script isn't part of the build. It is written once the migration is live, checked on the dev database first, and run by the owner.

**The import must not touch the bank balance for the past.** The owner's bank balance already reflects those debits. So past instalments are entered as **opening** purchases (no cash effect), keeping their real dates, NAVs and units. From December on, SIPs are recorded normally and do move the bank balance.

## Non-goals (for now)

- Automatic NAVs; CAS/PDF import inside the app; XIRR (both statements show it, and it's the most likely next addition).
- IDCW/dividend plans; switches, STP and SWP; ELSS lock-in; exit-load calculation (the owner enters the amount received).
- Capital gains tax; direct vs regular plan comparison.
- Phone notifications for SIP dates.
- Funds held in a demat or broker account.

## Design calls made by Claude ("do what's best"), not yet confirmed by the owner

1. **Generalise the tables.** Stocks and funds share one investment model with a `kind`, rather than separate fund tables. The FIFO, cash and net worth code stays single.
2. **`amount` is stored for every trade.** For stocks it is computed as before; for funds it is entered.
3. **Stamp duty counts in the cost.** "Invested" equals what left the bank, which matches the statements.
4. **Recording a fund transaction also records its NAV.** This differs from stocks, where a trade's price doesn't count as a recorded price.
5. **SIPs remind instead of posting.** A "SIP due" marker shows in the app, and Record SIP is pre-filled so only the NAV needs typing. There are no phone notifications.
6. **Past instalments are imported as opening purchases**, so the bank balance isn't debited twice.
7. **Funds are paid from bank accounts only**, not broker, wallet or cash.
8. **The units × NAV check allows ₹1.00** of difference from amount − stamp duty.
9. **Imported instalments settle their SIP months.** Opening purchases linked to a SIP count as recorded, so November isn't debited twice.
10. **The portfolio API stays backward-compatible.** Stock fields are unchanged, and funds and overall totals are added alongside.
11. **Add existing units** stores the average NAV as its price, skips the units × NAV check, and doesn't record a NAV.
12. **Auto-recorded NAVs are linked to their trade** and follow its edits and deletes.
13. **Missed SIP months stay due** until recorded, oldest first.
