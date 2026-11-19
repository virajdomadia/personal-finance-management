"""FIFO portfolio maths for investment holdings (stocks, mutual funds and crypto coins), pure
apart from the database-aware functions at the bottom.

Rules:
- Positions are per (instrument_id, account_id), i.e. per broker or bank. Trades are
  replayed in the order (date, buys before sells, id).
- A buy adds a lot of `quantity` shares, units or coins costing its `amount`. For a stock,
  `amount` is quantity * price + charges (see `stock_amount`). For a fund or a coin it is
  what was paid, charges included.
- A sell consumes lots oldest first. A whole lot gives its whole cost; a
  partial take gives round_paise(cost * taken / lot_quantity) and the lot keeps
  the remaining cost, so no paisa is lost to rounding.
- Realised P&L of a sell = its `amount` - cost taken. For a stock, `amount` is
  quantity * price - charges. For a fund or a coin it is what was received, after charges.
- A sell for more than is held is a shortfall: the first one in order is
  reported, and the sell takes whatever is held.
- Quantities are exact Decimals. Money is rounded to paise with ROUND_HALF_UP.
- Corporate actions run in the same date-ordered stream, before that day's trades, on
  every account's lots of their instrument whose basis date is before the ex-date. A
  split or consolidation multiplies each lot's quantity by new/old, keeping its cost. A
  bonus adds one zero-cost lot, dated the ex-date, of floor(eligible position * new/old).
  A merger moves each eligible lot to the target instrument in the same account, quantity
  * new/old, cost and basis date kept. A demerger gives each eligible lot a child lot in the
  target of quantity * new/old costing round_paise(lot cost * pct / 100), taken off the
  parent lot. For both, the position total is floored by taking the fraction off the
  newest lots, and moved lots keep their original FIFO order in the target.
- A dividend pays round_paise(eligible shares at the eve of the ex-date * amount) per
  account holding any; it changes no lot.
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


def fmt_units(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))


def fmt_nav(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


fmt_price = fmt_nav


def fmt_coin(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP), "f")


def stamp_duty(amount: Decimal) -> Decimal:
    return round_paise(amount * Decimal("0.00005"))


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
    # India date the quantity and price were last entered; None means the trade's `date`.
    basis_date: date | None = None


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


class ActionRow(NamedTuple):
    id: int
    instrument_id: int
    kind: str
    ex_date: date
    ratio_new: Decimal | None
    ratio_old: Decimal | None
    amount_per_share: Decimal | None
    target_instrument_id: int | None
    cost_share_pct: Decimal | None


class Replay(NamedTuple):
    positions: dict[tuple[int, int], Position]
    realised_by_sell: dict[int, Decimal]
    shortfall: TradeRow | None
    # Gross dividend in rupees by (action id, account id).
    dividends: dict[tuple[int, int], Decimal]
    # Ids of the actions that changed at least one lot.
    touched: set[int]


# [quantity, cost, basis_date, order]. `order` is the sort key of the event that created
# the lot; a lot moved by a merger or split off by a demerger keeps its parent's, so FIFO
# in the target instrument stays in original lot order.
Lot = list


def _eligible(lots: Iterable[Lot], ex_date: date) -> list[Lot]:
    """The lots an action on `ex_date` applies to: those entered at a basis before it."""
    return [lot for lot in lots if lot[0] > 0 and lot[2] < ex_date]


QTY = Decimal("0.00000001")


def _qty(value: Decimal) -> Decimal:
    """A ratio-adjusted quantity: exact when it fits 8 decimals, else rounded to 8."""
    if value.as_tuple().exponent >= -8:
        return value
    return value.quantize(QTY, rounding=ROUND_HALF_UP)


def _scaled(lots: list[Lot], new: Decimal, old: Decimal) -> tuple[list[Decimal], Decimal]:
    """Each lot's quantity x new/old (via `_qty`) and the position's unrounded total.

    The total is computed once from the exact sum, multiplying before dividing, so a
    position of 3 x 10 shares at 1:3 is exactly 10, not 3 x 3.333... summed.
    """
    held = sum((lot[0] for lot in lots), Decimal("0"))
    return [_qty(lot[0] * new / old) for lot in lots], held * new / old


def _settle(lots: list[Lot], total: Decimal) -> None:
    """Make `lots` (oldest first) add up to exactly `total`.

    Any excess is taken off the newest lots. A lot trimmed to nothing hands its cost to
    the newest lot that still has shares, so no paisa is lost; if every lot is trimmed
    away, one zero-quantity lot is left carrying all the cost. The last lot then absorbs
    the per-lot rounding, so the lots sum to `total` exactly.
    """
    excess = sum((lot[0] for lot in lots), Decimal("0")) - total
    for lot in reversed(lots):
        if excess <= 0:
            break
        take = min(excess, lot[0])
        lot[0] -= take
        excess -= take
    while len(lots) > 1 and lots[-1][0] <= 0:
        lots[-2][1] += lots.pop()[1]
    lots[-1][0] = total - sum((lot[0] for lot in lots[:-1]), Decimal("0"))


def _apply_split(lots: deque[Lot], action: ActionRow) -> bool:
    """Split or consolidation: each eligible lot's quantity x new/old, cost and date kept."""
    if not action.ratio_new or not action.ratio_old:
        return False
    eligible = _eligible(lots, action.ex_date)
    if not eligible:
        return False
    quantities, total = _scaled(eligible, action.ratio_new, action.ratio_old)
    quantities[-1] = _qty(total) - sum(quantities[:-1], Decimal("0"))  # last lot absorbs rounding
    changed = False
    for lot, quantity in zip(eligible, quantities, strict=True):
        if quantity != lot[0]:
            lot[0] = quantity
            changed = True
    return changed


def _apply_bonus(lots: deque[Lot], action: ActionRow) -> bool:
    """Bonus: one new zero-cost lot of floor(eligible position x new/old), dated the ex-date."""
    if not action.ratio_new or not action.ratio_old:
        return False
    held = sum((lot[0] for lot in _eligible(lots, action.ex_date)), Decimal("0"))
    extra = Decimal(int(held * action.ratio_new / action.ratio_old))  # floor, as held >= 0
    if extra <= 0:
        return False
    lots.append([extra, Decimal("0"), action.ex_date, _action_order(action)])
    return True


def _action_order(action: ActionRow) -> tuple[date, int, int]:
    return (action.ex_date, 0, action.id)


def _split_off(lots: deque[Lot], action: ActionRow) -> tuple[list[Lot], Decimal] | None:
    """A merger or demerger's new lots in the target from one position's eligible lots.

    Each eligible lot gives a lot of quantity x new/old with its basis date and order, the
    position total floored once and settled by `_settle`. A merger moves the whole lot (it leaves
    `lots`, cost and all); a demerger leaves the parent lot in place, its cost reduced by
    the child's round_paise(cost x pct / 100). Returns the new lots and the cost they
    carry, or None if the action can't apply or would create nothing.
    """
    merger = action.kind == "merger"
    if not action.ratio_new or not action.ratio_old:
        return None
    if not merger and action.cost_share_pct is None:
        return None
    eligible = _eligible(lots, action.ex_date)
    if not eligible:
        return None
    quantities, total = _scaled(eligible, action.ratio_new, action.ratio_old)
    whole = Decimal(int(total))  # floor per position, as total >= 0
    if not merger and whole <= 0:
        return None  # a demerger giving no whole share: the parent keeps everything
    if merger:
        costs = [lot[1] for lot in eligible]
    else:
        costs = [round_paise(lot[1] * action.cost_share_pct / 100) for lot in eligible]
    new = [
        [quantity, cost, lot[2], lot[3]]
        for lot, quantity, cost in zip(eligible, quantities, costs, strict=True)
    ]
    _settle(new, whole)
    if merger:
        moved = {id(lot) for lot in eligible}
        kept = [lot for lot in lots if id(lot) not in moved]
        lots.clear()
        lots.extend(kept)
    else:
        for lot, cost in zip(eligible, costs, strict=True):
            lot[1] -= cost
    return new, sum(costs, Decimal("0"))


_ACTION_HANDLERS = {
    "split": _apply_split,
    "consolidation": _apply_split,
    "bonus": _apply_bonus,
}


def replay(trades: Iterable[TradeRow], actions: Iterable[ActionRow] = ()) -> Replay:
    """Replay every trade and corporate action in one date-ordered stream.

    Events sort by (date, actions before buys before sells, id), so an action on its ex-date
    runs before that day's trades. An action applies to every account's lots of its
    instrument, but only to lots whose basis date is before the ex-date.
    """
    events: list[tuple[tuple[date, int, int], TradeRow | ActionRow]] = []
    for t in trades:
        events.append(((t.date, 1 if t.side == "buy" else 2, t.id), t))
    for act in actions:
        events.append(((act.ex_date, 0, act.id), act))
    events.sort(key=lambda e: e[0])

    positions: dict[tuple[int, int], Position] = {}
    lots_by_key: dict[tuple[int, int], deque[Lot]] = {}
    keys_by_instrument: dict[int, list[tuple[int, int]]] = defaultdict(list)
    realised_by_sell: dict[int, Decimal] = {}
    dividends: dict[tuple[int, int], Decimal] = {}
    touched: set[int] = set()
    shortfall: TradeRow | None = None

    def position(instrument_id: int, account_id: int) -> Position:
        key = (instrument_id, account_id)
        pos = positions.get(key)
        if pos is None:
            pos = positions[key] = Position(*key)
            lots_by_key[key] = deque()
            keys_by_instrument[instrument_id].append(key)
        return pos

    def recount(key: tuple[int, int]) -> None:
        positions[key].quantity = sum((lot[0] for lot in lots_by_key[key]), Decimal("0"))

    for order, event in events:
        if isinstance(event, ActionRow):
            keys = list(keys_by_instrument.get(event.instrument_id, ()))
            if event.kind == "dividend":
                if event.amount_per_share is None:
                    continue
                for key in keys:
                    held = sum(
                        (lot[0] for lot in _eligible(lots_by_key[key], event.ex_date)), Decimal("0")
                    )
                    if held > 0:
                        dividends[(event.id, key[1])] = round_paise(held * event.amount_per_share)
                continue
            if event.kind in ("merger", "demerger"):
                target = event.target_instrument_id
                if target is None or target == event.instrument_id:
                    continue
                for key in keys:
                    split = _split_off(lots_by_key[key], event)
                    if split is None:
                        continue
                    new_lots, cost = split
                    touched.add(event.id)
                    dst = position(target, key[1])
                    dst_key = (target, key[1])
                    lots_by_key[dst_key] = deque(
                        sorted([*lots_by_key[dst_key], *new_lots], key=lambda lot: lot[3])
                    )
                    positions[key].invested -= cost
                    dst.invested += cost
                    recount(key)
                    recount(dst_key)
                continue
            handler = _ACTION_HANDLERS.get(event.kind)
            if handler is None:
                continue  # "other": recorded for history only
            for key in keys:
                if handler(lots_by_key[key], event):
                    touched.add(event.id)
                    recount(key)
            continue

        t = event
        key = (t.instrument_id, t.account_id)
        pos = position(*key)
        lots = lots_by_key[key]
        if t.side == "buy":
            cost = t.amount
            lots.append([t.quantity, cost, t.basis_date or t.date, order])
            pos.quantity += t.quantity
            pos.invested += cost
            continue
        need = t.quantity
        if need > pos.quantity and shortfall is None:
            shortfall = t  # events run in order, so the first one seen is the first in order
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
    return Replay(positions, realised_by_sell, shortfall, dividends, touched)


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


def holds_units(db: Session, user_id: int, account_id: int, kind: str) -> bool:
    """Whether the account holds any instrument of `kind` ("stock", "mutual_fund" or "crypto")."""
    kinds = load_kinds(db, user_id)
    result = replay(r for r in load_trade_rows(db, user_id) if r.account_id == account_id)
    return any(
        pos.quantity > 0 and kinds.get(pos.instrument_id) == kind
        for pos in result.positions.values()
    )
