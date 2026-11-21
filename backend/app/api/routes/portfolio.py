from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.deposits import deposit_rows, with_deposits
from app.api.deps import CurrentUser, get_current_user
from app.api.goals import GoalTags, load_goal_tags
from app.api.loans import load_book
from app.api.portfolio import (
    ActionRow,
    Replay,
    fmt_coin,
    fmt_nav,
    fmt_price,
    fmt_units,
    holding_value,
    latest_prices,
    load_action_rows,
    load_trade_rows,
    replay,
    round_paise,
    summarise,
    unrealised_percent,
)
from app.api.routes.accounts import GoalTag, fmt, goal_tag, list_sort_key
from app.api.routes.coins import CRYPTO
from app.api.routes.funds import MUTUAL_FUND
from app.api.routes.sips import SipResponse, due_sip_list
from app.db.session import DbSession
from app.models.account import Account
from app.models.corporate_action import DividendLink
from app.models.investment import Instrument
from app.models.transaction import Transaction

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
    dividends: str  # every applied dividend received, all time (see `DividendTotals`)


class Holding(Figures):
    account_id: int
    account_name: str
    in_goal: GoalTag | None  # the active goal the instrument is in


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
    # Applied dividends received (stocks only), all time and this Indian financial year
    # (1 Apr-31 Mar, by ex-date): see `DividendTotals`. Never in the ledger or net worth.
    dividends: str
    dividends_fy: str
    total_return: str  # unrealised + realised + dividends received


class FundFigures(BaseModel):
    fund_id: int
    symbol: str
    name: str
    units: str
    invested: str
    average_nav: str
    nav: str | None
    nav_date: str | None
    value: str
    at_cost: bool
    unrealised: str
    unrealised_percent: str


class FundHolding(FundFigures):
    account_id: int
    account_name: str
    in_goal: GoalTag | None  # the active goal the instrument is in


class FundTotal(FundFigures):
    pass


class FundClosed(BaseModel):
    fund_id: int
    symbol: str
    name: str
    account_id: int
    account_name: str
    realised: str


class FundPortfolio(BaseModel):
    holdings: list[FundHolding]
    by_fund: list[FundTotal]
    closed: list[FundClosed]
    totals: Totals
    due_sips: list[SipResponse]


class CoinFigures(BaseModel):
    coin_id: int
    symbol: str
    name: str
    quantity: str
    invested: str
    average_price: str
    price: str | None
    price_date: str | None
    value: str
    at_cost: bool
    unrealised: str
    unrealised_percent: str


class CoinHolding(CoinFigures):
    account_id: int
    account_name: str
    in_goal: GoalTag | None  # the active goal the instrument is in


class CoinTotal(CoinFigures):
    pass


class CoinClosed(BaseModel):
    coin_id: int
    symbol: str
    name: str
    account_id: int
    account_name: str
    realised: str


class CryptoPortfolio(BaseModel):
    holdings: list[CoinHolding]
    by_coin: list[CoinTotal]
    closed: list[CoinClosed]
    totals: Totals


class DepositAccount(BaseModel):
    account_id: int
    name: str
    type: str
    balance: str
    maturity_date: str
    interest_estimate: str


class Deposits(BaseModel):
    value: str
    interest_estimate: str
    accounts: list[DepositAccount]


class Portfolio(BaseModel):
    holdings: list[Holding]
    by_stock: list[StockTotal]
    closed: list[Closed]
    totals: Totals
    funds: FundPortfolio
    crypto: CryptoPortfolio
    overall: Totals
    deposits: Deposits


def _percent(unrealised: Decimal, invested: Decimal) -> str:
    return fmt(unrealised_percent(unrealised, invested))


def _figures(
    stock: Instrument, shares: int, invested: Decimal, current: tuple | None, dividends: Decimal
) -> dict:
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
        "dividends": fmt(dividends),
    }


def _fund_figures(
    fund: Instrument, units: Decimal, invested: Decimal, current: tuple | None
) -> dict:
    nav = None if current is None else current[1]
    value = holding_value(units, invested, nav)
    unrealised = value - invested
    return {
        "fund_id": fund.id,
        "symbol": fund.symbol,
        "name": fund.name,
        "units": fmt_units(units),
        "invested": fmt(invested),
        "average_nav": fmt_nav(invested / units),
        "nav": None if nav is None else fmt_nav(nav),
        "nav_date": None if current is None else current[0].isoformat(),
        "value": fmt(value),
        "at_cost": nav is None,
        "unrealised": fmt(unrealised),
        "unrealised_percent": _percent(unrealised, invested),
    }


def _coin_figures(
    coin: Instrument, quantity: Decimal, invested: Decimal, current: tuple | None
) -> dict:
    price = None if current is None else current[1]
    value = holding_value(quantity, invested, price)
    unrealised = value - invested
    return {
        "coin_id": coin.id,
        "symbol": coin.symbol,
        "name": coin.name,
        "quantity": fmt_coin(quantity),
        "invested": fmt(invested),
        "average_price": fmt_price(invested / quantity),
        "price": None if price is None else fmt_price(price),
        "price_date": None if current is None else current[0].isoformat(),
        "value": fmt(value),
        "at_cost": price is None,
        "unrealised": fmt(unrealised),
        "unrealised_percent": _percent(unrealised, invested),
    }


def linked_received(db: Session, user_id: int) -> dict[int, Decimal]:
    """What the bank received for each dividend (by action id) linked to its credits."""
    rows = db.execute(
        select(DividendLink.stock_action_id, func.coalesce(func.sum(Transaction.amount), 0))
        .join(Transaction, Transaction.id == DividendLink.transaction_id)
        .where(DividendLink.user_id == user_id, Transaction.user_id == user_id)
        .group_by(DividendLink.stock_action_id)
    )
    return {action_id: Decimal(amount) for action_id, amount in rows}


class DividendTotals:
    """Applied dividends received, by (stock, account), all time and this financial year. Only
    those whose ex-date has come count; an upcoming one isn't received yet.

    A dividend linked to the bank credits that paid it counts what they paid, after TDS, shared
    across its accounts by their gross. One not linked counts its gross: its TDS isn't known."""

    def __init__(
        self,
        result: Replay,
        actions: list[ActionRow],
        today: date,
        received: dict[int, Decimal] | None = None,
    ) -> None:
        start = date(today.year if today.month >= 4 else today.year - 1, 4, 1)
        end = date(start.year + 1, 3, 31)
        by_id = {a.id: a for a in actions}
        received = received or {}
        gross_of: dict[int, Decimal] = {}
        for (action_id, _), gross in result.dividends.items():
            gross_of[action_id] = gross_of.get(action_id, ZERO) + gross
        self.by_position: dict[tuple[int, int], Decimal] = {}
        self.all = self.fy = ZERO
        for (action_id, account_id), gross in result.dividends.items():
            action = by_id[action_id]
            if action.ex_date > today:
                continue
            paid = gross
            if action_id in received and gross_of[action_id] > 0:
                paid = round_paise(received[action_id] * gross / gross_of[action_id])
            key = (action.instrument_id, account_id)
            self.by_position[key] = self.by_position.get(key, ZERO) + paid
            self.all += paid
            if start <= action.ex_date <= end:
                self.fy += paid


NO_DIVIDENDS = (ZERO, ZERO)


def _totals(summary, dividends: tuple[Decimal, Decimal] = NO_DIVIDENDS) -> Totals:
    all_time, fy = dividends
    return Totals(
        invested=fmt(summary.invested),
        value=fmt(summary.value),
        unrealised=fmt(summary.unrealised),
        unrealised_percent=_percent(summary.unrealised, summary.invested),
        realised=fmt(summary.realised),
        dividends=fmt(all_time),
        dividends_fy=fmt(fy),
        total_return=fmt(summary.unrealised + summary.realised + all_time),
    )


def _fund_portfolio(
    db: DbSession, user_id: int, result, prices: dict, names: dict[int, str], tags: GoalTags
) -> FundPortfolio:
    funds = {
        f.id: f
        for f in db.scalars(
            select(Instrument).where(Instrument.user_id == user_id, Instrument.kind == MUTUAL_FUND)
        )
    }
    holdings: list[FundHolding] = []
    closed: list[FundClosed] = []
    combined: dict[int, list] = {}  # fund_id -> [units, invested]
    for (fund_id, account_id), pos in result.positions.items():
        fund = funds.get(fund_id)
        if fund is None:
            continue
        if pos.quantity > 0:
            figures = _fund_figures(fund, pos.quantity, pos.invested, prices.get(fund_id))
            holdings.append(
                FundHolding(
                    **figures,
                    account_id=account_id,
                    account_name=names[account_id],
                    in_goal=goal_tag(tags, ("instrument", fund_id)),
                )
            )
            total = combined.setdefault(fund_id, [Decimal("0"), ZERO])
            total[0] += pos.quantity
            total[1] += pos.invested
        elif pos.sold_any:
            closed.append(
                FundClosed(
                    fund_id=fund_id,
                    symbol=fund.symbol,
                    name=fund.name,
                    account_id=account_id,
                    account_name=names[account_id],
                    realised=fmt(pos.realised),
                )
            )
    holdings.sort(key=lambda h: (h.symbol, h.account_name))
    closed.sort(key=lambda c: (c.symbol, c.account_name))
    by_fund = [
        FundTotal(**_fund_figures(funds[fund_id], units, invested, prices.get(fund_id)))
        for fund_id, (units, invested) in combined.items()
    ]
    by_fund.sort(key=lambda f: f.symbol)
    return FundPortfolio(
        holdings=holdings,
        by_fund=by_fund,
        closed=closed,
        totals=_totals(summarise(result, prices, only=set(funds))),
        due_sips=due_sip_list(db, user_id),
    )


def _crypto_portfolio(
    db: DbSession, user_id: int, result, prices: dict, names: dict[int, str], tags: GoalTags
) -> CryptoPortfolio:
    coins = {
        c.id: c
        for c in db.scalars(
            select(Instrument).where(Instrument.user_id == user_id, Instrument.kind == CRYPTO)
        )
    }
    holdings: list[CoinHolding] = []
    closed: list[CoinClosed] = []
    combined: dict[int, list] = {}  # coin_id -> [quantity, invested]
    for (coin_id, account_id), pos in result.positions.items():
        coin = coins.get(coin_id)
        if coin is None:
            continue
        if pos.quantity > 0:
            figures = _coin_figures(coin, pos.quantity, pos.invested, prices.get(coin_id))
            holdings.append(
                CoinHolding(
                    **figures,
                    account_id=account_id,
                    account_name=names[account_id],
                    in_goal=goal_tag(tags, ("instrument", coin_id)),
                )
            )
            total = combined.setdefault(coin_id, [Decimal("0"), ZERO])
            total[0] += pos.quantity
            total[1] += pos.invested
        elif pos.sold_any:
            closed.append(
                CoinClosed(
                    coin_id=coin_id,
                    symbol=coin.symbol,
                    name=coin.name,
                    account_id=account_id,
                    account_name=names[account_id],
                    realised=fmt(pos.realised),
                )
            )
    holdings.sort(key=lambda h: (h.symbol, h.account_name))
    closed.sort(key=lambda c: (c.symbol, c.account_name))
    by_coin = [
        CoinTotal(**_coin_figures(coins[coin_id], quantity, invested, prices.get(coin_id)))
        for coin_id, (quantity, invested) in combined.items()
    ]
    by_coin.sort(key=lambda c: c.symbol)
    return CryptoPortfolio(
        holdings=holdings,
        by_coin=by_coin,
        closed=closed,
        totals=_totals(summarise(result, prices, only=set(coins))),
    )


@router.get("/portfolio")
def get_portfolio(user: CurrentUser, db: DbSession) -> Portfolio:
    actions = load_action_rows(db, user.id)
    result = replay(load_trade_rows(db, user.id), actions)
    prices = latest_prices(db, user.id)
    # Only stocks here; other kinds of instrument have their own screens.
    stocks = {
        s.id: s
        for s in db.scalars(
            select(Instrument).where(Instrument.user_id == user.id, Instrument.kind == "stock")
        )
    }
    accounts = list(db.scalars(select(Account).where(Account.user_id == user.id)).all())
    names = {a.id: a.name for a in accounts}
    active = sorted((a for a in accounts if a.archived_at is None), key=list_sort_key)
    book = load_book(db, user.id, accounts)
    today = today_india()
    deposits = deposit_rows(active, book, today)
    tags = load_goal_tags(db, user.id)
    dividends = DividendTotals(result, actions, today, linked_received(db, user.id))
    stock_dividends = (dividends.all, dividends.fy)

    holdings: list[Holding] = []
    closed: list[Closed] = []
    combined: dict[int, list] = {}  # stock_id -> [shares, invested, dividends]
    for (stock_id, account_id), pos in result.positions.items():
        stock = stocks.get(stock_id)
        if stock is None:
            continue
        shares = int(pos.quantity)
        paid = dividends.by_position.get((stock_id, account_id), ZERO)
        if shares > 0:
            figures = _figures(stock, shares, pos.invested, prices.get(stock_id), paid)
            holdings.append(
                Holding(
                    **figures,
                    account_id=account_id,
                    account_name=names[account_id],
                    in_goal=goal_tag(tags, ("instrument", stock_id)),
                )
            )
            total = combined.setdefault(stock_id, [0, ZERO, ZERO])
            total[0] += shares
            total[1] += pos.invested
            total[2] += paid
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
        StockTotal(**_figures(stocks[stock_id], shares, invested, prices.get(stock_id), paid))
        for stock_id, (shares, invested, paid) in combined.items()
    ]
    by_stock.sort(key=lambda s: s.symbol)

    return Portfolio(
        holdings=holdings,
        by_stock=by_stock,
        closed=closed,
        totals=_totals(summarise(result, prices, only=set(stocks)), stock_dividends),
        funds=_fund_portfolio(db, user.id, result, prices, names, tags),
        crypto=_crypto_portfolio(db, user.id, result, prices, names, tags),
        overall=_totals(with_deposits(summarise(result, prices), deposits), stock_dividends),
        deposits=Deposits(
            value=fmt(sum((d.balance for d in deposits), ZERO)),
            interest_estimate=fmt(sum((d.interest_estimate for d in deposits), ZERO)),
            accounts=[
                DepositAccount(
                    account_id=d.account.id,
                    name=d.account.name,
                    type=d.account.type,
                    balance=fmt(d.balance),
                    maturity_date=d.figures.maturity_date,
                    interest_estimate=fmt(d.interest_estimate),
                )
                for d in deposits
            ],
        ),
    )
