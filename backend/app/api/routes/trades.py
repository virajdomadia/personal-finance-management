"""Stock buys and sells. Each moves its broker account's cash (see `balances.load_movements`).

Every save (create, edit, delete) replays the user's stock trades with the change applied, and
is refused if any sell would then sell more shares than were held on its date (`trade_checks`).
"""

from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import TradeRow, load_trade_rows, replay, stock_amount
from app.api.routes.accounts import MAX_ID, MAX_MONEY, Flag, Money, field_error, fmt
from app.api.routes.stocks import STOCK, get_owned_stock
from app.api.routes.transactions import Day, Note, lock_accounts
from app.api.trade_checks import (
    NEW_ID,
    ShortMessages,
    check_cash_and_holdings,
    check_delete,
    lock_trade,
    require_active,
)
from app.db.session import DbSession
from app.models.account import Account
from app.models.investment import Instrument, InvestmentTrade
from app.models.sms import SmsEntry

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

MAX_QUANTITY = 100_000_000
_QUANTITY_RULE = "Enter a whole number of shares, from 1 to 10,00,00,000."
_CHOOSE_STOCK = "Choose a stock."
_CHOOSE_BROKER = "Choose a broker account."
_CHOOSE_SIDE = "Choose buy or sell."
STOCK_SHORT = ShortMessages(
    kind=STOCK,
    field="quantity",
    own="You'd be selling more {symbol} than you held on {day}.",
    other="This would leave the sale of {symbol} on {day} selling more than was held.",
)


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


def stock_columns(values: dict[str, Any]) -> dict[str, Any]:
    """A stock trade's API fields as model columns, with the amount it moved worked out."""
    columns = {k: v for k, v in values.items() if k != "stock_id"}
    columns["instrument_id"] = values["stock_id"]
    columns["amount"] = stock_amount(
        values["side"], values["quantity"], values["price"], values["charges"]
    )
    return columns


def _response(
    t: InvestmentTrade, stock: Instrument, account: Account, realised: dict[int, Decimal]
) -> TradeResponse:
    gain = realised.get(t.id) if t.side == "sell" else None
    return TradeResponse(
        id=t.id,
        stock_id=t.instrument_id,
        symbol=stock.symbol,
        account_id=t.account_id,
        account_name=account.name,
        side=t.side,
        date=t.date.isoformat(),
        quantity=int(t.quantity),  # whole shares
        price=fmt(t.price),
        charges=fmt(t.charges),
        opening=t.opening,
        note=t.note,
        amount=fmt(t.amount),
        realised=None if gain is None else fmt(gain),
    )


def _saved_response(
    db: Session, user_id: int, t: InvestmentTrade, account: Account
) -> TradeResponse:
    realised = replay(load_trade_rows(db, user_id)).realised_by_sell
    stock = db.get(Instrument, t.instrument_id)
    assert stock is not None
    return _response(t, stock, account, realised)


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
) -> tuple[Instrument, Account]:
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


def stock_save_checks(
    db: Session,
    user_id: int,
    accounts: dict[int, Account],
    values: dict[str, Any],
    existing_id: int | None,
) -> tuple[Instrument, Account]:
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
        stock_amount(values["side"], values["quantity"], values["price"], values["charges"]),
    )
    check_cash_and_holdings(db, user_id, accounts, row, existing_id, "price", STOCK_SHORT)
    return stock, account


@router.get("/trades")
def list_trades(
    user: CurrentUser,
    db: DbSession,
    stock_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
    account_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
) -> TradeList:
    query = (
        select(InvestmentTrade)
        .join(Instrument, Instrument.id == InvestmentTrade.instrument_id)
        .where(InvestmentTrade.user_id == user.id, Instrument.kind == STOCK)
    )
    if stock_id is not None:
        query = query.where(InvestmentTrade.instrument_id == stock_id)
    if account_id is not None:
        query = query.where(InvestmentTrade.account_id == account_id)
    found = db.scalars(query.order_by(InvestmentTrade.date.desc(), InvestmentTrade.id.desc())).all()
    # Realised P&L depends on every earlier trade of the holding, so replay them all.
    realised = replay(load_trade_rows(db, user.id)).realised_by_sell
    stocks = {
        s.id: s
        for s in db.scalars(
            select(Instrument).where(Instrument.user_id == user.id, Instrument.kind == STOCK)
        )
    }
    accounts = {a.id: a for a in db.scalars(select(Account).where(Account.user_id == user.id))}
    return TradeList(
        trades=[
            _response(t, stocks[t.instrument_id], accounts[t.account_id], realised) for t in found
        ]
    )


@router.post("/trades", status_code=status.HTTP_201_CREATED)
def create_trade(body: TradeCreate, user: CurrentUser, db: DbSession) -> TradeResponse:
    values = body.model_dump()
    values["charges"] = values["charges"] if values["charges"] is not None else Decimal(0)
    accounts = lock_accounts(db, user.id, [values["account_id"]])
    _, account = stock_save_checks(db, user.id, accounts, values, existing_id=None)
    trade = InvestmentTrade(user_id=user.id, **stock_columns(values))
    db.add(trade)
    db.commit()
    return _saved_response(db, user.id, trade, account)


@router.patch("/trades/{id}")
def update_trade(id: int, body: TradeUpdate, user: CurrentUser, db: DbSession) -> TradeResponse:
    changes = body.model_dump(exclude_unset=True)
    # The old account is locked too, because moving a trade changes its cash as well.
    moved_to = [changes["account_id"]] if changes.get("account_id") is not None else []
    trade, accounts = lock_trade(db, user.id, id, STOCK, moved_to)
    if "charges" in changes and changes["charges"] is None:
        changes["charges"] = Decimal(0)
    values = {
        "stock_id": trade.instrument_id,
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
    require_active(accounts, [trade.account_id, values["account_id"]])
    _, account = stock_save_checks(db, user.id, accounts, values, existing_id=trade.id)
    for field, value in stock_columns(values).items():
        setattr(trade, field, value)
    db.commit()
    return _saved_response(db, user.id, trade, account)


@router.delete("/trades/{id}")
def delete_trade(id: int, user: CurrentUser, db: DbSession) -> dict[str, int]:
    trade, accounts = lock_trade(db, user.id, id, STOCK)
    check_delete(db, user.id, accounts, trade, STOCK_SHORT)
    # The SMS it came from stays known, so sending that message again doesn't bring it back.
    db.execute(
        update(SmsEntry)
        .where(SmsEntry.user_id == user.id, SmsEntry.trade_id == trade.id)
        .values(status="ignored", trade_id=None)
    )
    db.delete(trade)
    db.commit()
    return {"id": id}
