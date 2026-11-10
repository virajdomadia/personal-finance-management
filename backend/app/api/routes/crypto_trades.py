"""Crypto buys and sells. Each moves its exchange account's cash by its `amount` (see
`balances.load_movements`), except existing coins (`opening`), which move none.

Unlike fund trades, these record no price: a coin's price is only what the owner enters.
"""

from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import TradeRow, fmt_coin, fmt_price, load_trade_rows, replay
from app.api.routes.accounts import MAX_ID, MAX_MONEY, Flag, Money, field_error, fmt
from app.api.routes.coins import (
    CRYPTO,
    MAX_PRICE,
    PRICE_RULE,
    QTY_RULE,
    CoinPrice,
    CoinQty,
    get_owned_coin,
)
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

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

_CHOOSE_COIN = "Choose a coin."
_CHOOSE_ACCOUNT = "Choose a broker or exchange account."
_CHOOSE_SIDE = "Choose buy or sell."
# Quantity × price may differ from what was invested (buy) or received (sell) by ₹1.00, or by
# quantity × ₹0.00005 when that is more: a price has at most 4 decimals, so rounding it can move
# quantity × price by up to that much.
_MATCH_TOLERANCE = Decimal("1.00")
_PRICE_ROUNDING = Decimal("0.00005")
COIN_SHORT = ShortMessages(
    kind=CRYPTO,
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


def _side(value: Any) -> str | None:
    if value is not None and value not in ("buy", "sell"):
        raise PydanticCustomError("side", _CHOOSE_SIDE)
    return value


CoinRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_COIN))]
AccountRef = Annotated[int | None, BeforeValidator(_id(_CHOOSE_ACCOUNT))]
Side = Annotated[str | None, BeforeValidator(_side)]


class CryptoTradeCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    coin_id: CoinRef = None
    account_id: AccountRef = None
    side: Side = None
    date: Day = None
    quantity: CoinQty = None
    price: CoinPrice = None  # required unless `opening`, and ignored when it is
    charges: Money = None
    amount: Money = None
    opening: Flag = False
    note: Note = None


class CryptoTradeUpdate(BaseModel):
    """Create's fields, all optional, minus `side` and `opening`, which can't change."""

    model_config = ConfigDict(extra="forbid")

    coin_id: CoinRef = None
    account_id: AccountRef = None
    date: Day = None
    quantity: CoinQty = None
    price: CoinPrice = None
    charges: Money = None
    amount: Money = None
    note: Note = None


class CryptoTrade(BaseModel):
    id: int
    coin_id: int
    symbol: str
    account_id: int
    account_name: str
    side: str
    date: str
    quantity: str
    price: str  # for existing coins, the average purchase price
    charges: str
    amount: str  # what left the account (buy) or came into it (sell)
    opening: bool
    note: str | None
    realised: str | None  # sells only


class CryptoTradeList(BaseModel):
    trades: list[CryptoTrade]


def _columns(values: dict[str, Any], price: Decimal) -> dict[str, Any]:
    return {
        "instrument_id": values["coin_id"],
        "account_id": values["account_id"],
        "side": values["side"],
        "date": values["date"],
        "quantity": values["quantity"],
        "price": price,
        "charges": values["charges"],
        "amount": values["amount"],
        "opening": values["opening"],
        "note": values["note"],
    }


def _response(
    t: InvestmentTrade, coin: Instrument, account: Account, realised: dict[int, Decimal]
) -> CryptoTrade:
    gain = realised.get(t.id) if t.side == "sell" else None
    return CryptoTrade(
        id=t.id,
        coin_id=t.instrument_id,
        symbol=coin.symbol,
        account_id=t.account_id,
        account_name=account.name,
        side=t.side,
        date=t.date.isoformat(),
        quantity=fmt_coin(t.quantity),
        price=fmt_price(t.price),
        charges=fmt(t.charges),
        amount=fmt(t.amount),
        opening=t.opening,
        note=t.note,
        realised=None if gain is None else fmt(gain),
    )


def _saved_response(db: Session, user_id: int, t: InvestmentTrade, account: Account) -> CryptoTrade:
    realised = replay(load_trade_rows(db, user_id)).realised_by_sell
    coin = db.get(Instrument, t.instrument_id)
    assert coin is not None
    return _response(t, coin, account, realised)


def _validate_fields(values: dict[str, Any]) -> None:
    errors = []
    if values["coin_id"] is None:
        errors.append(field_error("coin_id", _CHOOSE_COIN))
    if values["account_id"] is None:
        errors.append(field_error("account_id", _CHOOSE_ACCOUNT))
    if values["side"] is None:
        errors.append(field_error("side", _CHOOSE_SIDE))
    day = values["date"]
    if day is None:
        errors.append(field_error("date", "Choose a date."))
    elif day > today_india():
        errors.append(field_error("date", "The date can't be in the future."))
    if values["quantity"] is None:
        errors.append(field_error("quantity", QTY_RULE))
    if values["price"] is None and not values["opening"]:
        errors.append(field_error("price", PRICE_RULE))
    amount, charges = values["amount"], values["charges"]
    if amount is None:
        errors.append(field_error("amount", "Enter the amount."))
    elif amount <= 0:
        errors.append(field_error("amount", "Amount must be greater than 0."))
    if charges < 0:
        errors.append(field_error("charges", "Charges can't be negative."))
    elif amount is not None and amount > 0 and charges >= amount:
        errors.append(field_error("charges", "Charges can't be more than the amount."))
    if errors:
        raise RequestValidationError(errors)


def _coin_and_account(
    db: Session, user_id: int, values: dict[str, Any], accounts: dict[int, Account]
) -> tuple[Instrument, Account]:
    errors = []
    coin = None
    try:
        coin = get_owned_coin(db, user_id, values["coin_id"])
    except HTTPException:  # someone else's coin, or a stock or fund, is reported like a missing one
        errors.append(field_error("coin_id", _CHOOSE_COIN))
    account = accounts.get(values["account_id"])
    if account is None or account.type != "broker":
        errors.append(field_error("account_id", _CHOOSE_ACCOUNT))
    elif account.archived_at is not None:
        errors.append(
            field_error("account_id", f"{account.name} is archived. Restore it to use it.")
        )
    if errors:
        raise RequestValidationError(errors)
    assert coin is not None and account is not None
    return coin, account


def _check_amounts(values: dict[str, Any]) -> Decimal:
    """The quantity, price and amount fit together and can be stored. Returns the price to store.

    For existing coins that is the average, amount ÷ quantity.
    """
    quantity = values["quantity"]
    if values["opening"]:
        price = (values["amount"] / quantity).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        if price == 0:
            message = "That's too little for that many coins."
            raise RequestValidationError([field_error("amount", message)])
        if price >= MAX_PRICE:
            message = "That's too few coins for that amount."
            raise RequestValidationError([field_error("quantity", message)])
        return price
    price = values["price"]
    worth = quantity * price
    if worth >= MAX_MONEY:
        raise RequestValidationError([field_error("price", "This trade is too large.")])
    if values["side"] == "buy":
        net = values["amount"] - values["charges"]  # a buy's amount includes its charges
    else:
        net = values["amount"] + values["charges"]  # a sell's amount is after them
    if abs(worth - net) > max(_MATCH_TOLERANCE, quantity * _PRICE_ROUNDING):
        message = "Quantity × price doesn't match the amount. Check the quantity and price."
        raise RequestValidationError([field_error("quantity", message)])
    return price


def _save_checks(
    db: Session,
    user_id: int,
    accounts: dict[int, Account],
    values: dict[str, Any],
    existing_id: int | None,
) -> tuple[Account, Decimal]:
    """Checks for a create or an edit, in order. `values` is the whole trade after the change.

    Returns the exchange account and the price to store.
    """
    _validate_fields(values)
    coin, account = _coin_and_account(db, user_id, values, accounts)
    if values["side"] == "sell" and values["opening"]:
        message = "Only a buy can be existing coins."
        raise RequestValidationError([field_error("opening", message)])
    price = _check_amounts(values)
    row = TradeRow(
        existing_id or NEW_ID,
        coin.id,
        account.id,
        values["side"],
        values["date"],
        values["quantity"],
        price,
        values["charges"],
        values["opening"],
        values["amount"],
    )
    check_cash_and_holdings(db, user_id, accounts, row, existing_id, "amount", COIN_SHORT)
    return account, price


@router.get("/crypto-trades")
def list_crypto_trades(
    user: CurrentUser,
    db: DbSession,
    coin_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
    account_id: Annotated[int | None, Query(ge=1, le=MAX_ID)] = None,
) -> CryptoTradeList:
    query = (
        select(InvestmentTrade)
        .join(Instrument, Instrument.id == InvestmentTrade.instrument_id)
        .where(InvestmentTrade.user_id == user.id, Instrument.kind == CRYPTO)
    )
    if coin_id is not None:
        query = query.where(InvestmentTrade.instrument_id == coin_id)
    if account_id is not None:
        query = query.where(InvestmentTrade.account_id == account_id)
    found = db.scalars(query.order_by(InvestmentTrade.date.desc(), InvestmentTrade.id.desc())).all()
    # Realised P&L depends on every earlier trade of the holding, so replay them all.
    realised = replay(load_trade_rows(db, user.id)).realised_by_sell
    coins = {
        c.id: c
        for c in db.scalars(
            select(Instrument).where(Instrument.user_id == user.id, Instrument.kind == CRYPTO)
        )
    }
    accounts = {a.id: a for a in db.scalars(select(Account).where(Account.user_id == user.id))}
    return CryptoTradeList(
        trades=[
            _response(t, coins[t.instrument_id], accounts[t.account_id], realised) for t in found
        ]
    )


def _defaults(values: dict[str, Any]) -> dict[str, Any]:
    if values.get("charges") is None:
        values["charges"] = Decimal(0)
    return values


@router.post("/crypto-trades", status_code=status.HTTP_201_CREATED)
def create_crypto_trade(body: CryptoTradeCreate, user: CurrentUser, db: DbSession) -> CryptoTrade:
    values = _defaults(body.model_dump())
    accounts = lock_accounts(db, user.id, [values["account_id"]])
    account, price = _save_checks(db, user.id, accounts, values, existing_id=None)
    trade = InvestmentTrade(user_id=user.id, **_columns(values, price))
    db.add(trade)
    db.commit()
    return _saved_response(db, user.id, trade, account)


@router.patch("/crypto-trades/{id}")
def update_crypto_trade(
    id: int, body: CryptoTradeUpdate, user: CurrentUser, db: DbSession
) -> CryptoTrade:
    changes = body.model_dump(exclude_unset=True)
    # The old account is locked too, because moving a trade changes its cash as well.
    moved_to = [changes["account_id"]] if changes.get("account_id") is not None else []
    trade, accounts = lock_trade(db, user.id, id, CRYPTO, moved_to)
    if "charges" in changes:
        _defaults(changes)
    values: dict[str, Any] = {
        "coin_id": trade.instrument_id,
        "account_id": trade.account_id,
        "side": trade.side,
        "date": trade.date,
        "quantity": trade.quantity,
        "price": trade.price,
        "charges": trade.charges,
        "amount": trade.amount,
        "opening": trade.opening,
        "note": trade.note,
        **changes,
    }
    require_active(accounts, [trade.account_id, values["account_id"]])
    account, price = _save_checks(db, user.id, accounts, values, existing_id=trade.id)
    for field, value in _columns(values, price).items():
        setattr(trade, field, value)
    db.commit()
    return _saved_response(db, user.id, trade, account)


@router.delete("/crypto-trades/{id}")
def delete_crypto_trade(id: int, user: CurrentUser, db: DbSession) -> dict[str, int]:
    trade, accounts = lock_trade(db, user.id, id, CRYPTO)
    check_delete(db, user.id, accounts, trade, COIN_SHORT)
    db.delete(trade)
    db.commit()
    return {"id": id}
