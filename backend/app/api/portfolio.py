"""FIFO portfolio maths for stock holdings, pure apart from `load_trade_rows` at the bottom.

Rules:
- Trades are grouped per (stock_id, account_id), i.e. per broker, and replayed
  in the order (date, buys before sells, id).
- A buy adds a lot of `quantity` shares costing quantity * price + charges.
- A sell consumes lots oldest first. A whole lot gives its whole cost; a
  partial take gives round_paise(cost * taken / lot_shares) and the lot keeps
  the remaining cost, so no paisa is lost to rounding.
- Realised P&L of a sell = (quantity * price - charges) - cost taken.
- A sell for more shares than held is a shortfall: the first one in order is
  reported, and the sell takes whatever is held.
- Money is rounded to paise with ROUND_HALF_UP.
"""

from collections import defaultdict, deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.stock import StockPrice, StockTrade

PAISE = Decimal("0.01")


def round_paise(value: Decimal) -> Decimal:
    return value.quantize(PAISE, rounding=ROUND_HALF_UP)


class TradeRow(NamedTuple):
    id: int
    stock_id: int
    account_id: int
    side: str
    date: date
    quantity: int
    price: Decimal
    charges: Decimal
    opening: bool


def trade_value(t: TradeRow) -> Decimal:
    gross = t.quantity * t.price
    return round_paise(gross + t.charges if t.side == "buy" else gross - t.charges)


def trade_cash(t: TradeRow) -> Decimal:
    if t.side == "buy":
        return Decimal("0.00") if t.opening else -trade_value(t)
    return trade_value(t)


@dataclass
class Position:
    stock_id: int
    account_id: int
    shares: int = 0
    invested: Decimal = field(default_factory=lambda: Decimal("0"))
    realised: Decimal = field(default_factory=lambda: Decimal("0"))
    sold_any: bool = False


class Replay(NamedTuple):
    positions: dict[tuple[int, int], Position]
    realised_by_sell: dict[int, Decimal]
    shortfall: TradeRow | None


def replay(trades: Iterable[TradeRow]) -> Replay:
    groups: dict[tuple[int, int], list[TradeRow]] = defaultdict(list)
    for t in trades:
        groups[(t.stock_id, t.account_id)].append(t)

    positions: dict[tuple[int, int], Position] = {}
    realised_by_sell: dict[int, Decimal] = {}
    shortfall: TradeRow | None = None
    shortfall_key: tuple[date, int, int] | None = None

    for key, rows in groups.items():
        pos = Position(*key)
        positions[key] = pos
        lots: deque[list] = deque()  # [shares, cost]
        for t in sorted(rows, key=lambda r: (r.date, 0 if r.side == "buy" else 1, r.id)):
            if t.side == "buy":
                cost = t.quantity * t.price + t.charges
                lots.append([t.quantity, cost])
                pos.shares += t.quantity
                pos.invested += cost
                continue
            need = t.quantity
            if need > pos.shares:
                order = (t.date, 1, t.id)
                if shortfall_key is None or order < shortfall_key:
                    shortfall, shortfall_key = t, order
            cost_taken = Decimal("0")
            while need > 0 and lots:
                lot = lots[0]
                if lot[0] <= need:
                    cost_taken += lot[1]
                    need -= lot[0]
                    lots.popleft()
                else:
                    part = round_paise(lot[1] * need / lot[0])
                    cost_taken += part
                    lot[0] -= need
                    lot[1] -= part
                    need = 0
            taken = t.quantity - need
            realised = round_paise(t.quantity * t.price - t.charges - cost_taken)
            realised_by_sell[t.id] = realised
            pos.shares -= taken
            pos.invested -= cost_taken
            pos.realised += realised
            pos.sold_any = True

    for pos in positions.values():
        pos.invested = round_paise(pos.invested)
        pos.realised = round_paise(pos.realised)
    return Replay(positions, realised_by_sell, shortfall)


class PortfolioTotals(NamedTuple):
    invested: Decimal
    value: Decimal
    unrealised: Decimal
    realised: Decimal


def holding_value(shares: int, invested: Decimal, price: Decimal | None) -> Decimal:
    """Current value of a holding; with no recorded price it is held at cost."""
    return invested if price is None else round_paise(shares * price)


def summarise(replay: Replay, prices: dict[int, tuple[date, Decimal]]) -> PortfolioTotals:
    """Totals over open holdings (invested, value) and over every position (realised)."""
    invested = value = realised = Decimal("0.00")
    for pos in replay.positions.values():
        realised += pos.realised
        if pos.shares > 0:
            current = prices.get(pos.stock_id)
            invested += pos.invested
            value += holding_value(pos.shares, pos.invested, current[1] if current else None)
    return PortfolioTotals(invested, value, value - invested, realised)


# The one database-aware function here: the rows `replay` works on, for all of a user's trades.
def load_trade_rows(db: Session, user_id: int) -> list[TradeRow]:
    rows = db.execute(
        select(
            StockTrade.id,
            StockTrade.stock_id,
            StockTrade.account_id,
            StockTrade.side,
            StockTrade.date,
            StockTrade.quantity,
            StockTrade.price,
            StockTrade.charges,
            StockTrade.opening,
        ).where(StockTrade.user_id == user_id)
    )
    return [TradeRow(*row) for row in rows]


def latest_prices(db: Session, user_id: int) -> dict[int, tuple[date, Decimal]]:
    """Each stock's current price: the latest date, and on that date the last one recorded."""
    rows = db.execute(
        select(StockPrice.stock_id, StockPrice.date, StockPrice.price)
        .where(StockPrice.user_id == user_id)
        .order_by(StockPrice.date, StockPrice.id)
    )
    # Ascending order, so the last row seen for a stock is its current price.
    return {stock_id: (day, price) for stock_id, day, price in rows}


def unrealised_percent(unrealised: Decimal, invested: Decimal) -> Decimal:
    """Shown from the rounded figures, so the percent matches the numbers beside it."""
    invested, unrealised = round_paise(invested), round_paise(unrealised)
    if invested == 0:
        return Decimal("0.00")
    return round_paise(unrealised * 100 / invested)


def investments_totals(db: Session, user_id: int) -> PortfolioTotals:
    return summarise(replay(load_trade_rows(db, user_id)), latest_prices(db, user_id))


def holds_shares(db: Session, user_id: int, account_id: int) -> bool:
    result = replay(r for r in load_trade_rows(db, user_id) if r.account_id == account_id)
    return any(pos.shares > 0 for pos in result.positions.values())
