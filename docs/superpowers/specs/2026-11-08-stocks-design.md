# Stocks: design

## Why

The owner holds Indian shares through a broker and wants to see, in the app, what they put in, what it's worth now, and the profit or loss. Today the only trace of stocks is the broker account's cash balance. This is the first piece of Milestone 4 (Investments) in the [roadmap](../../product/roadmap.md). Mutual funds, ETFs, gold, FDs, PPF and the rest each need their own calculations and come later, one at a time. Stocks set the pattern they will follow.

## Decided with the owner

- **Stocks first**, on their own. Other investment types come later.
- **Everything is entered by hand**: trades and current prices. Broker import and automatic prices may come later, and nothing here should block them.
- **Money flows through the broker account**, which already exists as account type `broker`:
  - Bank → broker: an ordinary transfer (already works).
  - Buy: the cost comes out of the broker account's cash.
  - Sell: the proceeds go into the broker account's cash.
  - Broker → bank: an ordinary transfer (already works).
- **A broker account's balance is its cash only.** Shares are not part of it. They live in a separate Investments section. Net worth counts both, and nothing is counted twice ([vision](../../product/vision.md): an account is not an investment).
- **Shares bought before using the app** are entered with an "Add existing shares" form: stock, broker, quantity, average buy price, and an approximate buy date. It doesn't touch the broker's cash. Entering the real past trades one by one instead is still possible.

## Model

### Stock

A stock the owner has traded, owned by the user. Shared across broker accounts.

| Field | Meaning |
|---|---|
| `symbol` | NSE/BSE trading symbol, e.g. `INFY`. Upper-cased, 1 to 20 characters of `A-Z 0-9 & - .`. Unique per user. |
| `name` | Company name, e.g. "Infosys". 1 to 60 characters. |

### Trade

One buy or sell of one stock in one broker account.

| Field | Meaning |
|---|---|
| `stock_id` | The stock |
| `account_id` | An active `broker` account of the owner's |
| `side` | `buy` or `sell` |
| `date` | Trade date. Not in the future (India's date). |
| `quantity` | Whole shares, 1 to 10,00,00,000 |
| `price` | Price per share, > 0, at most 2 decimals |
| `charges` | Brokerage, STT, GST, stamp duty and exchange charges together, ≥ 0, at most 2 decimals. Default 0. |
| `opening` | Buys only. True for "Add existing shares": the shares were bought before the app was used, so the broker's cash doesn't move. |
| `note` | Optional, up to 200 characters |

| Trade | Broker cash | Holding |
|---|---|---|
| Buy | − (quantity × price + charges) | + quantity, cost = quantity × price + charges |
| Opening buy | no change | + quantity, cost = quantity × price + charges |
| Sell | + (quantity × price − charges) | − quantity, cost taken from the oldest shares first |

Charges on a buy go into the cost, as already proposed in the [ledger design](../../architecture/ledger-design.md#decisions-taken). The app makes no tax-compliance claim from it.

The broker cash change joins the existing balance engine (`backend/app/api/balances.py`), so the broker's balance, "You have" and net worth stay right without trades being transactions. A broker account can already go below ₹0 (`CAN_BE_NEGATIVE`), so a buy is not refused for lack of cash.

### Holding

Derived, never stored: one stock in one broker account with shares still held. Computed from that pair's trades in date order (same date: buys before sells, then by id), selling the oldest shares first (FIFO):

| Figure | How |
|---|---|
| Shares held | Bought − sold |
| Invested (cost basis) | Cost of the shares still held |
| Average cost | Invested ÷ shares held, rounded half up to paise, for display |
| Current price | The latest recorded price for the stock |
| Current value | Shares held × current price. With no price recorded yet, it equals invested and is labelled "at cost". |
| Unrealised P&L | Current value − invested, in ₹ and as % of invested |
| Realised P&L | For each sell: proceeds (quantity × price − charges) − cost of the shares it took. Summed per holding. |

When a lot is only partly sold, its cost is split in proportion to the shares taken. The rounding remainder stays with the shares that are left, so the costs always add up exactly.

The portfolio total is the sum over all holdings, and also grouped by stock across brokers.

**Fully sold positions** (a stock in a broker account with 0 shares left but at least one sell) are "closed". They're not in the holdings list, but their realised P&L counts in the portfolio's realised total. The portfolio response lists them separately, and both clients show them in a collapsed "Sold" section under the holdings. A stock's page always shows its full trade history.

**Rules a trade change must keep:** at no point in date order can a holding's shares go below 0. A sell that sells more than is held on its date is refused, and so is an edit or delete of a buy that would leave a later sell short. Errors name the stock and the date.

### Price

An append-only list of prices per stock: `date` (not in the future), `price` (> 0, at most 2 decimals) and when it was recorded. The current price is the one with the latest date, and the latest recorded on that date. Recording a price is one action ("Update price"), and the price history can be viewed. A wrong price can be deleted.

A trade's price does **not** count as a recorded price. The owner updates prices on purpose.

### Archived broker accounts

A broker account with holdings can't be archived until its shares are sold. (Its cash follows the existing rules.) Its trades stay. They can't be created, edited or deleted while the account is archived ("Restore this account before editing it", as for transactions). Its realised P&L still counts in the portfolio's realised total.

## Net worth and dashboard

- **Net worth** = accounts (including broker cash) + investments at current value − what's owed.
- "You have" includes investments at current value.
- The dashboard gains an **Investments** figure: current value, with unrealised P&L in ₹ and %.
- Realised P&L is shown in the Investments section only. It is not income and does not appear in spending or income totals.

## API

New routes under `/investments`, all scoped to the signed-in user, in the style of the existing routes (money as strings, field errors in the existing format):

- Stocks: list, create, rename (symbol and name), delete when the stock has no trades and no prices.
- Trades: list (filter by stock and by broker account), create, edit, delete.
- Prices: list for a stock, record, delete.
- Portfolio: holdings with every figure above, plus portfolio totals.
- Dashboard: adds the investments figure. Accounts: `total_have` includes investments.

Storage: new tables `stocks`, `stock_trades` and `stock_prices`, in one Alembic migration. The [database design](../../architecture/database-design.md) names these `instruments`, `investment_trades` and `instrument_prices` for all investment types; the doc is updated to say stocks got their own tables first, and the general model is decided when the second investment type arrives. The [ledger design](../../architecture/ledger-design.md) gets a short note too: holdings still map to ledger accounts at cost when the ledger arrives, and whether realised gains become an income account is settled then. Until then they're not income.

## Clients

Each platform gets its own UI on the shared backend, never a copy of the other.

- **Web:** an "Investments" page in the sidebar. A portfolio summary at the top (invested, current value, unrealised P&L, realised P&L), then a table of holdings. A stock's page shows its holdings per broker, its trades and its price history. Actions: Buy, Sell, Add existing shares, Update price. Profit is green and loss red, always with a + or − sign so colour isn't the only signal.
- **Android:** an "Investments" tab with the summary and a list of holdings. Tapping a holding opens its trades and price history. Forms for buy/sell, add existing shares and update price, built for the phone.
- The dashboard on both shows the new investments figure.

Testing order, as for loans: the website on the local backend first, then the app against the deployed API.

## Non-goals (for now)

Automatic prices, broker contract-note or CSV import, mutual funds and every other investment type, dividends linked to a stock (a dividend is recorded as ordinary income with a "Dividends" category), bonus issues, splits and other corporate actions, choosing which lots a sale takes, tax (short or long term gains, grandfathering), XIRR, F&O, intraday, short selling, fractional shares, and foreign stocks.

## Design calls made by Claude, not yet confirmed by the owner

- A stock is entered once and shared across broker accounts; a holding is one stock in one broker account.
- All charges on a trade are one number, not split into brokerage, STT and the rest.
- A buy isn't refused when the broker's cash would go below ₹0, matching how broker accounts already behave.
- Trades are their own table, not transactions, so the transactions list doesn't show them. They appear in the stock's trade history, and the Investments page can list trades filtered by broker account, so a broker's cash movements can be traced. Broker cash still reflects them. (The owner left this to Claude: "do what's best".)
- Investments are included in "You have", and the dashboard shows them as their own figure.
- Holdings with no recorded price are valued at cost and labelled "at cost".
- Realised P&L is not counted as income.
- Bonus issues and splits are out for now.
- Whole shares only.
- Fully sold positions sit in a collapsed "Sold" section, and their realised P&L counts in the total.
- Trades in an archived broker account are locked until the account is restored.
