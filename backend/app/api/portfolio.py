"""FIFO portfolio maths for investment holdings (stocks and funds), pure apart from the
database-aware functions at the bottom.

Rules:
- Trades are grouped per (instrument_id, account_id), i.e. per broker or bank, and
  replayed in the order (date, buys before sells, id).
- A buy adds a lot of `quantity` shares or units costing its `amount`. For a stock,
  `amount` is quantity * price + charges (see `stock_amount`).
- A sell consumes lots oldest first. A whole lot gives its whole cost; a
  partial take gives round_paise(cost * taken / lot_quantity) and the lot keeps
  the remaining cost, so no paisa is lost to rounding.
- Realised P&L of a sell = its `amount` - cost taken. For a stock, `amount` is
  quantity * price - charges.
- A sell for more than is held is a shortfall: the first one in order is
  reported, and the sell takes whatever is held.
- Quantities are exact Decimals. Money is rounded to paise with ROUND_HALF_UP.
"""

from collections import defaultdict, deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade

PAISE = Decimal("0.01")


def round_paise(value: Decimal) -> Decimal:
    return value.quantize(PAISE, rounding=ROUND_HALF_UP)


class TradeRow(NamedTuple):
    id: int
    instrument_id: int
    account_id: int
    side: str
    date: date
    quantity: Decimal
    price: Decimal
    charges: Decimal
    opening: bool
    amount: Decimal


def stock_amount(side: str, quantity: Decimal | int, price: Decimal, charges: Decimal) -> Decimal:
    """A stock trade's cost (buy) or proceeds (sell), charges included."""
    gross = quantity * price
    return round_paise(gross + charges if side == "buy" else gross - charges)


def trade_value(t: TradeRow) -> Decimal:
    return t.amount


def trade_cash(t: TradeRow) -> Decimal:
    if t.side == "buy":
        return Decimal("0.00") if t.opening else -trade_value(t)
    return trade_value(t)


@dataclass
class Position:
    instrument_id: int
    account_id: int
    quantity: Decimal = field(default_factory=lambda: Decimal("0"))
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
        groups[(t.instrument_id, t.account_id)].append(t)

    positions: dict[tuple[int, int], Position] = {}
    realised_by_sell: dict[int, Decimal] = {}
    shortfall: TradeRow | None = None
    shortfall_key: tuple[date, int, int] | None = None

    for key, rows in groups.items():
        pos = Position(*key)
        positions[key] = pos
        lots: deque[list] = deque()  # [quantity, cost]
        for t in sorted(rows, key=lambda r: (r.date, 0 if r.side == "buy" else 1, r.id)):
            if t.side == "buy":
                cost = t.amount
                lots.append([t.quantity, cost])
                pos.quantity += t.quantity
                pos.invested += cost
                continue
            need = t.quantity
            if need > pos.quantity:
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
            realised = round_paise(t.amount - cost_taken)
            realised_by_sell[t.id] = realised
            pos.quantity -= taken
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


def holding_value(quantity: Decimal | int, invested: Decimal, price: Decimal | None) -> Decimal:
    """Current value of a holding; with no recorded price it is held at cost."""
    return invested if price is None else round_paise(quantity * price)


def summarise(
    replay: Replay, prices: dict[int, tuple[date, Decimal]], only: set[int] | None = None
) -> PortfolioTotals:
    """Totals over open holdings (invested, value) and over every position (realised).

    With `only`, just the positions of those instrument ids count.
    """
    invested = value = realised = Decimal("0.00")
    for pos in replay.positions.values():
        if only is not None and pos.instrument_id not in only:
            continue
        realised += pos.realised
        if pos.quantity > 0:
            current = prices.get(pos.instrument_id)
            invested += pos.invested
            value += holding_value(pos.quantity, pos.invested, current[1] if current else None)
    return PortfolioTotals(invested, value, value - invested, realised)


# Database-aware from here on. The rows `replay` works on, for all of a user's trades.
def load_trade_rows(db: Session, user_id: int) -> list[TradeRow]:
    rows = db.execute(
        select(
            InvestmentTrade.id,
            InvestmentTrade.instrument_id,
            InvestmentTrade.account_id,
            InvestmentTrade.side,
            InvestmentTrade.date,
            InvestmentTrade.quantity,
            InvestmentTrade.price,
            InvestmentTrade.charges,
            InvestmentTrade.opening,
            InvestmentTrade.amount,
        ).where(InvestmentTrade.user_id == user_id)
    )
    return [TradeRow(*row) for row in rows]


def load_kinds(db: Session, user_id: int) -> dict[int, str]:
    """The kind of each of the user's instruments, by id."""
    rows = db.execute(select(Instrument.id, Instrument.kind).where(Instrument.user_id == user_id))
    return {id_: kind for id_, kind in rows}


def latest_prices(db: Session, user_id: int) -> dict[int, tuple[date, Decimal]]:
    """Each instrument's current price: the latest date, and on that date the last one recorded."""
    rows = db.execute(
        select(InstrumentPrice.instrument_id, InstrumentPrice.date, InstrumentPrice.price)
        .where(InstrumentPrice.user_id == user_id)
        .order_by(InstrumentPrice.date, InstrumentPrice.id)
    )
    # Ascending order, so the last row seen for an instrument is its current price.
    return {instrument_id: (day, price) for instrument_id, day, price in rows}


def unrealised_percent(unrealised: Decimal, invested: Decimal) -> Decimal:
    """Shown from the rounded figures, so the percent matches the numbers beside it."""
    invested, unrealised = round_paise(invested), round_paise(unrealised)
    if invested == 0:
        return Decimal("0.00")
    return round_paise(unrealised * 100 / invested)


def investments_totals(db: Session, user_id: int, kind: str | None = None) -> PortfolioTotals:
    """Totals over every kind of instrument, or just `kind`."""
    only = None
    if kind is not None:
        only = {id_ for id_, k in load_kinds(db, user_id).items() if k == kind}
    return summarise(replay(load_trade_rows(db, user_id)), latest_prices(db, user_id), only)


def holds_shares(db: Session, user_id: int, account_id: int) -> bool:
    """Whether the account holds any stock."""
    kinds = load_kinds(db, user_id)
    result = replay(r for r in load_trade_rows(db, user_id) if r.account_id == account_id)
    return any(
        pos.quantity > 0 and kinds.get(pos.instrument_id) == "stock"
        for pos in result.positions.values()
    )
