"""Pure FIFO portfolio maths for stock holdings (no database, no models).

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
