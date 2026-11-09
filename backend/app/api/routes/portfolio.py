from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import (
    holding_value,
    latest_prices,
    load_trade_rows,
    replay,
    summarise,
    unrealised_percent,
)
from app.api.routes.accounts import fmt
from app.db.session import DbSession
from app.models.account import Account
from app.models.investment import Instrument

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

ZERO = Decimal("0.00")


class Figures(BaseModel):
    stock_id: int
    symbol: str
    name: str
    shares: int
    invested: str
    average_cost: str
    price: str | None
    price_date: str | None
    value: str
    at_cost: bool
    unrealised: str
    unrealised_percent: str


class Holding(Figures):
    account_id: int
    account_name: str


class StockTotal(Figures):
    pass


class Closed(BaseModel):
    stock_id: int
    symbol: str
    name: str
    account_id: int
    account_name: str
    realised: str


class Totals(BaseModel):
    invested: str
    value: str
    unrealised: str
    unrealised_percent: str
    realised: str


class Portfolio(BaseModel):
    holdings: list[Holding]
    by_stock: list[StockTotal]
    closed: list[Closed]
    totals: Totals


def _percent(unrealised: Decimal, invested: Decimal) -> str:
    return fmt(unrealised_percent(unrealised, invested))


def _figures(stock: Instrument, shares: int, invested: Decimal, current: tuple | None) -> dict:
    price = None if current is None else current[1]
    value = holding_value(shares, invested, price)
    unrealised = value - invested
    return {
        "stock_id": stock.id,
        "symbol": stock.symbol,
        "name": stock.name,
        "shares": shares,
        "invested": fmt(invested),
        "average_cost": fmt((invested / shares).quantize(ZERO, rounding=ROUND_HALF_UP)),
        "price": None if price is None else fmt(price),
        "price_date": None if current is None else current[0].isoformat(),
        "value": fmt(value),
        "at_cost": price is None,
        "unrealised": fmt(unrealised),
        "unrealised_percent": _percent(unrealised, invested),
    }


@router.get("/portfolio")
def get_portfolio(user: CurrentUser, db: DbSession) -> Portfolio:
    result = replay(load_trade_rows(db, user.id))
    prices = latest_prices(db, user.id)
    # Only stocks here; other kinds of instrument have their own screens.
    stocks = {
        s.id: s
        for s in db.scalars(
            select(Instrument).where(Instrument.user_id == user.id, Instrument.kind == "stock")
        )
    }
    rows = db.execute(select(Account.id, Account.name).where(Account.user_id == user.id))
    names = {id_: name for id_, name in rows}

    holdings: list[Holding] = []
    closed: list[Closed] = []
    combined: dict[int, list] = {}  # stock_id -> [shares, invested]
    for (stock_id, account_id), pos in result.positions.items():
        stock = stocks.get(stock_id)
        if stock is None:
            continue
        shares = int(pos.quantity)
        if shares > 0:
            figures = _figures(stock, shares, pos.invested, prices.get(stock_id))
            holdings.append(
                Holding(**figures, account_id=account_id, account_name=names[account_id])
            )
            total = combined.setdefault(stock_id, [0, ZERO])
            total[0] += shares
            total[1] += pos.invested
        elif pos.sold_any:
            closed.append(
                Closed(
                    stock_id=stock_id,
                    symbol=stock.symbol,
                    name=stock.name,
                    account_id=account_id,
                    account_name=names[account_id],
                    realised=fmt(pos.realised),
                )
            )
    holdings.sort(key=lambda h: (h.symbol, h.account_name))
    closed.sort(key=lambda c: (c.symbol, c.account_name))
    by_stock = [
        StockTotal(**_figures(stocks[stock_id], shares, invested, prices.get(stock_id)))
        for stock_id, (shares, invested) in combined.items()
    ]
    by_stock.sort(key=lambda s: s.symbol)

    totals = summarise(result, prices, only=set(stocks))
    return Portfolio(
        holdings=holdings,
        by_stock=by_stock,
        closed=closed,
        totals=Totals(
            invested=fmt(totals.invested),
            value=fmt(totals.value),
            unrealised=fmt(totals.unrealised),
            unrealised_percent=_percent(totals.unrealised, totals.invested),
            realised=fmt(totals.realised),
        ),
    )
