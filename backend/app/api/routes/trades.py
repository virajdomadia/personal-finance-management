"""Stock buys and sells. Each moves its broker account's cash (see `balances.load_movements`).

Every save (create, edit, delete) replays all of the user's trades with the change applied, and
is refused if any sell would then sell more shares than were held on its date.
"""

from datetime import date
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.balances import Movement, load_movements
from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import TradeRow, load_trade_rows, replay, trade_cash, trade_value
from app.api.routes.accounts import MAX_ID, MAX_MONEY, Flag, Money, field_error, fmt
from app.api.routes.dashboard import today_india
from app.api.routes.stocks import get_owned_stock
from app.api.routes.transactions import Day, Note, balance_problem, lock_accounts
from app.db.session import DbSession
from app.models.account import Account
from app.models.stock import Stock, StockTrade

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

MAX_QUANTITY = 100_000_000
_QUANTITY_RULE = "Enter a whole number of shares, from 1 to 10,00,00,000."
_CHOOSE_STOCK = "Choose a stock."
_CHOOSE_BROKER = "Choose a broker account."
_CHOOSE_SIDE = "Choose buy or sell."
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# A trade being created has no id yet. This one sorts after every real id on the same date.
NEW_ID = MAX_ID + 1


def _id(message: str) -> Any:
    def check(value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise PydanticCustomError("ref", message)
        return value

    return check


def _quantity(value: Any) -> int | None:
    # A JSON integer only: no bool, no float (even 3.0), no numeric text.
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_QUANTITY:
        raise PydanticCustomError("quantity", _QUANTITY_RULE)
    return value


def _side(value: Any) -> str | None:
    if value is not None and value not in ("buy", "sell"):
        raise PydanticCustomError("side", _CHOOSE_SIDE)
    return value


StockRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_STOCK))]
BrokerRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_BROKER))]
Quantity = Annotated[int | None, BeforeValidator(_quantity)]
Side = Annotated[str | None, BeforeValidator(_side)]


class TradeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    stock_id: StockRef = None
    account_id: BrokerRef = None
    side: Side = None
    date: Day = None
    quantity: Quantity = None
    price: Money = None
    charges: Money = None
    opening: Flag = False
    note: Note = None


class TradeUpdate(BaseModel):
    """Create's fields, all optional, minus `side` and `opening`, which can't change."""

    model_config = ConfigDict(extra="forbid")

    stock_id: StockRef = None
    account_id: BrokerRef = None
    date: Day = None
    quantity: Quantity = None
    price: Money = None
    charges: Money = None
    note: Note = None


class TradeResponse(BaseModel):
    id: int
    stock_id: int
    symbol: str
    account_id: int
    account_name: str
    side: str
    date: str
    quantity: int
    price: str
    charges: str
    opening: bool
    note: str | None
    amount: str  # what the trade cost (buy) or brought in (sell), charges included
    realised: str | None  # sells only


class TradeList(BaseModel):
    trades: list[TradeResponse]


def _row(t: StockTrade) -> TradeRow:
    return TradeRow(
        t.id, t.stock_id, t.account_id, t.side, t.date, t.quantity, t.price, t.charges, t.opening
    )


def _response(
    t: StockTrade, stock: Stock, account: Account, realised: dict[int, Decimal]
) -> TradeResponse:
    gain = realised.get(t.id) if t.side == "sell" else None
    return TradeResponse(
        id=t.id,
        stock_id=t.stock_id,
        symbol=stock.symbol,
        account_id=t.account_id,
        account_name=account.name,
        side=t.side,
        date=t.date.isoformat(),
        quantity=t.quantity,
        price=fmt(t.price),
        charges=fmt(t.charges),
        opening=t.opening,
        note=t.note,
        amount=fmt(trade_value(_row(t))),
        realised=None if gain is None else fmt(gain),
    )


def _saved_response(db: Session, user_id: int, t: StockTrade, account: Account) -> TradeResponse:
    realised = replay(load_trade_rows(db, user_id)).realised_by_sell
    stock = db.get(Stock, t.stock_id)
    assert stock is not None
    return _response(t, stock, account, realised)


def _day(d: date) -> str:
    return f"{d.day} {_MONTHS[d.month - 1]} {d.year}"


def _get_owned(db: Session, user_id: int, id: int) -> StockTrade:
    # Ids outside the column's range can't exist; asking the database would be a 500.
    trade = None
    if 1 <= id <= MAX_ID:
        trade = db.scalar(
            select(StockTrade).where(StockTrade.id == id, StockTrade.user_id == user_id)
        )
    if trade is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trade not found.")
    return trade


def _lock_trade(
    db: Session, user_id: int, id: int, other_ids: list[int] | None = None
) -> tuple[StockTrade, dict[int, Account]]:
    """The trade, re-read after its account (and `other_ids`) are locked.

    Read before the lock, the trade could have been moved to another account meanwhile, and that
    account's balance would then be checked unlocked. If it moved, start over with the new one.
    """
    others = other_ids or []
    account_id = _get_owned(db, user_id, id).account_id
    while True:
        accounts = lock_accounts(db, user_id, [account_id, *others])
        trade = db.scalar(
            select(StockTrade)
            .where(StockTrade.id == id, StockTrade.user_id == user_id)
            .execution_options(populate_existing=True)
        )
        if trade is None:  # deleted meanwhile
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Trade not found.")
        if trade.account_id == account_id:
            return trade, accounts
        account_id = trade.account_id
        db.rollback()  # nothing is written yet; this only lets go of the locks taken above


def _require_active(accounts: dict[int, Account], ids: list[int | None]) -> None:
    for account_id in ids:
        account = None if account_id is None else accounts.get(account_id)
        if account is not None and account.archived_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, f"Restore {account.name} before changing this trade."
            )


def _validate_fields(values: dict[str, Any]) -> None:
    errors = []
    if values["stock_id"] is None:
        errors.append(field_error("stock_id", _CHOOSE_STOCK))
    if values["account_id"] is None:
        errors.append(field_error("account_id", _CHOOSE_BROKER))
    if values["side"] is None:
        errors.append(field_error("side", _CHOOSE_SIDE))
    day = values["date"]
    if day is None:
        errors.append(field_error("date", "Choose a date."))
    elif day > today_india():
        errors.append(field_error("date", "The date can't be in the future."))
    if values["quantity"] is None:
        errors.append(field_error("quantity", _QUANTITY_RULE))
    price = values["price"]
    if price is None:
        errors.append(field_error("price", "Enter a price, like 1234.50."))
    elif price <= 0:
        errors.append(field_error("price", "Price must be greater than 0."))
    if values["charges"] < 0:
        errors.append(field_error("charges", "Charges can't be negative."))
    if errors:
        raise RequestValidationError(errors)


def _stock_and_account(
    db: Session, user_id: int, values: dict[str, Any], accounts: dict[int, Account]
) -> tuple[Stock, Account]:
    errors = []
    stock = None
    try:
        stock = get_owned_stock(db, user_id, values["stock_id"])
    except HTTPException:  # someone else's stock is reported the same as one that doesn't exist
        errors.append(field_error("stock_id", _CHOOSE_STOCK))
    account = accounts.get(values["account_id"])
    if account is None or account.type != "broker":
        errors.append(field_error("account_id", _CHOOSE_BROKER))
    elif account.archived_at is not None:
        errors.append(
            field_error("account_id", f"{account.name} is archived. Restore it to use it.")
        )
    if errors:
        raise RequestValidationError(errors)
    assert stock is not None and account is not None
    return stock, account


def _shortfall_check(
    db: Session, user_id: int, rows: list[TradeRow], saving_id: int | None
) -> None:
    """Refuse the change if, with it applied (`rows`), any sell sells more than was held."""
    short = replay(rows).shortfall
    if short is None:
        return
    symbol = db.scalar(select(Stock.symbol).where(Stock.id == short.stock_id))
    if short.id == saving_id:
        message = f"You'd be selling more {symbol} than you held on {_day(short.date)}."
        raise RequestValidationError([field_error("quantity", message)])
    raise HTTPException(
        status.HTTP_409_CONFLICT,
        f"This would leave the sale of {symbol} on {_day(short.date)} selling more than was held.",
    )


def _save_checks(
    db: Session,
    user_id: int,
    accounts: dict[int, Account],
    values: dict[str, Any],
    existing_id: int | None,
) -> tuple[Stock, Account]:
    """Checks for a create or an edit, in order. `values` is the whole trade after the change."""
    _validate_fields(values)
    stock, account = _stock_and_account(db, user_id, values, accounts)
    if values["side"] == "sell" and values["opening"]:
        raise RequestValidationError([field_error("opening", "Only a buy can be existing shares.")])
    gross = values["quantity"] * values["price"]
    if values["side"] == "sell" and values["charges"] > gross:
        raise RequestValidationError(
            [field_error("charges", "Charges can't be more than the sale value.")]
        )
    if gross + values["charges"] >= MAX_MONEY:
        raise RequestValidationError([field_error("price", "This trade is too large.")])

    row = TradeRow(
        existing_id or NEW_ID,
        stock.id,
        account.id,
        values["side"],
        values["date"],
        values["quantity"],
        values["price"],
        values["charges"],
        values["opening"],
    )
    before = load_movements(db, user_id)
    after = [m for m in before if existing_id is None or m.id != -existing_id]
    if not row.opening:
        after.append(Movement(-row.id, row.side, abs(trade_cash(row)), row.account_id, None))
    problem = balance_problem(accounts, before, after)
    if problem:
        raise RequestValidationError([field_error("price", problem)])

    rows = [r for r in load_trade_rows(db, user_id) if r.id != existing_id]
    _shortfall_check(db, user_id, [*rows, row], row.id)
    return stock, account


@router.get("/trades")
def list_trades(
    user: CurrentUser,
    db: DbSession,
    stock_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
    account_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
) -> TradeList:
    query = select(StockTrade).where(StockTrade.user_id == user.id)
    if stock_id is not None:
        query = query.where(StockTrade.stock_id == stock_id)
    if account_id is not None:
        query = query.where(StockTrade.account_id == account_id)
    found = db.scalars(query.order_by(StockTrade.date.desc(), StockTrade.id.desc())).all()
    # Realised P&L depends on every earlier trade of the holding, so replay them all.
    realised = replay(load_trade_rows(db, user.id)).realised_by_sell
    stocks = {s.id: s for s in db.scalars(select(Stock).where(Stock.user_id == user.id))}
    accounts = {a.id: a for a in db.scalars(select(Account).where(Account.user_id == user.id))}
    return TradeList(
        trades=[_response(t, stocks[t.stock_id], accounts[t.account_id], realised) for t in found]
    )


@router.post("/trades", status_code=status.HTTP_201_CREATED)
def create_trade(body: TradeCreate, user: CurrentUser, db: DbSession) -> TradeResponse:
    values = body.model_dump()
    values["charges"] = values["charges"] if values["charges"] is not None else Decimal(0)
    accounts = lock_accounts(db, user.id, [values["account_id"]])
    _, account = _save_checks(db, user.id, accounts, values, existing_id=None)
    trade = StockTrade(user_id=user.id, **values)
    db.add(trade)
    db.commit()
    return _saved_response(db, user.id, trade, account)


@router.patch("/trades/{id}")
def update_trade(id: int, body: TradeUpdate, user: CurrentUser, db: DbSession) -> TradeResponse:
    changes = body.model_dump(exclude_unset=True)
    # The old account is locked too, because moving a trade changes its cash as well.
    moved_to = [changes["account_id"]] if changes.get("account_id") is not None else []
    trade, accounts = _lock_trade(db, user.id, id, moved_to)
    if "charges" in changes and changes["charges"] is None:
        changes["charges"] = Decimal(0)
    values = {
        "stock_id": trade.stock_id,
        "account_id": trade.account_id,
        "side": trade.side,
        "date": trade.date,
        "quantity": trade.quantity,
        "price": trade.price,
        "charges": trade.charges,
        "opening": trade.opening,
        "note": trade.note,
        **changes,
    }
    _require_active(accounts, [trade.account_id, values["account_id"]])
    _, account = _save_checks(db, user.id, accounts, values, existing_id=trade.id)
    for field, value in values.items():
        setattr(trade, field, value)
    db.commit()
    return _saved_response(db, user.id, trade, account)


@router.delete("/trades/{id}")
def delete_trade(id: int, user: CurrentUser, db: DbSession) -> dict[str, int]:
    trade, accounts = _lock_trade(db, user.id, id)
    _require_active(accounts, [trade.account_id])
    rows = [r for r in load_trade_rows(db, user.id) if r.id != trade.id]
    _shortfall_check(db, user.id, rows, None)
    before = load_movements(db, user.id)
    problem = balance_problem(accounts, before, [m for m in before if m.id != -trade.id])
    if problem:
        raise HTTPException(status.HTTP_409_CONFLICT, problem)
    db.delete(trade)
    db.commit()
    return {"id": id}
