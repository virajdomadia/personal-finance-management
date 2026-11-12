import re
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import fmt_price, latest_prices
from app.api.routes.accounts import MAX_ID, clean_text, field_error
from app.api.routes.funds import decimal_input
from app.api.routes.market import SourceCode, apply_link, check_source_code
from app.api.routes.stocks import Deleted
from app.api.routes.transactions import Day
from app.db.session import DbSession
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

CRYPTO = "crypto"
_SYMBOL = re.compile(r"[A-Z0-9]{1,20}")
_NO_NAME = "Enter a name."
TICKER_RULE = "Enter the coin's ticker, like BTC."
QTY_RULE = "Enter a quantity above 0, with up to 8 decimals, like 0.00014067."
PRICE_RULE = "Enter a price above 0, with up to 4 decimals, like 7504827.5."
MAX_PRICE = Decimal(10) ** 10


def _symbol(value: Any) -> str | None:
    if value is None:
        return None
    text = value.strip().upper() if isinstance(value, str) else ""
    if not _SYMBOL.fullmatch(text):
        raise PydanticCustomError("symbol", TICKER_RULE)
    return text


CoinQty = Annotated[Decimal | None, BeforeValidator(decimal_input(8, Decimal(10) ** 16, QTY_RULE))]
CoinPrice = Annotated[Decimal | None, BeforeValidator(decimal_input(4, MAX_PRICE, PRICE_RULE))]
CoinSymbol = Annotated[str | None, BeforeValidator(_symbol)]
CoinName = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, _NO_NAME, 60))]


class CoinCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    symbol: CoinSymbol = None
    name: CoinName = None
    source_code: SourceCode = None


class CoinUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: CoinSymbol = None
    name: CoinName = None
    source_code: SourceCode = None


class CoinPriceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: Day = None
    price: CoinPrice = None


class CoinResponse(BaseModel):
    id: int
    symbol: str
    name: str
    price: str | None
    price_date: str | None
    source_code: str | None


class CoinList(BaseModel):
    coins: list[CoinResponse]


class CoinPriceResponse(BaseModel):
    id: int
    date: str
    price: str
    source: str


class CoinPriceList(BaseModel):
    prices: list[CoinPriceResponse]


def get_owned_coin(db: DbSession, user_id: int, id: int) -> Instrument:
    """The user's coin with this id. A stock or fund is not found, like a stranger's coin."""
    coin = None
    if 1 <= id <= MAX_ID:
        coin = db.scalar(
            select(Instrument).where(
                Instrument.id == id, Instrument.user_id == user_id, Instrument.kind == CRYPTO
            )
        )
    if coin is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Coin not found.")
    return coin


def _response(coin: Instrument, prices: dict[int, tuple[Any, Decimal]]) -> CoinResponse:
    current = prices.get(coin.id)
    return CoinResponse(
        id=coin.id,
        symbol=coin.symbol,
        name=coin.name,
        price=None if current is None else fmt_price(current[1]),
        price_date=None if current is None else current[0].isoformat(),
        source_code=coin.source_code,
    )


def _symbols(db: DbSession, user_id: int, except_id: int | None = None) -> set[str]:
    query = select(Instrument.symbol).where(
        Instrument.user_id == user_id, Instrument.kind == CRYPTO
    )
    if except_id is not None:
        query = query.where(Instrument.id != except_id)
    return {s.upper() for s in db.scalars(query)}


def _duplicate(symbol: str) -> RequestValidationError:
    return RequestValidationError([field_error("symbol", f"You already have {symbol}.")])


def _in_use() -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, "This coin has trades. Delete them first.")


@router.get("/coins")
def list_coins(user: CurrentUser, db: DbSession) -> CoinList:
    coins = db.scalars(
        select(Instrument)
        .where(Instrument.user_id == user.id, Instrument.kind == CRYPTO)
        .order_by(func.lower(Instrument.name), Instrument.id)
    ).all()
    prices = latest_prices(db, user.id)
    return CoinList(coins=[_response(c, prices) for c in coins])


@router.post("/coins", status_code=status.HTTP_201_CREATED)
def create_coin(body: CoinCreate, user: CurrentUser, db: DbSession) -> CoinResponse:
    errors = []
    if body.symbol is None:
        errors.append(field_error("symbol", TICKER_RULE))
    if body.name is None:
        errors.append(field_error("name", _NO_NAME))
    errors += check_source_code(db, CRYPTO, body.source_code)
    if errors:
        raise RequestValidationError(errors)
    assert body.symbol is not None and body.name is not None
    if body.symbol in _symbols(db, user.id):
        raise _duplicate(body.symbol)
    coin = Instrument(
        user_id=user.id,
        kind=CRYPTO,
        symbol=body.symbol,
        name=body.name,
        source_code=body.source_code,
    )
    db.add(coin)
    try:
        if body.source_code is not None:
            apply_link(db, CRYPTO)
        db.commit()
    except IntegrityError:  # a concurrent request took the symbol first
        db.rollback()
        raise _duplicate(body.symbol) from None
    return _response(coin, latest_prices(db, user.id) if body.source_code else {})


@router.patch("/coins/{id}")
def update_coin(id: int, body: CoinUpdate, user: CurrentUser, db: DbSession) -> CoinResponse:
    coin = get_owned_coin(db, user.id, id)
    changes = body.model_dump(exclude_unset=True)
    errors = []
    if "symbol" in changes and changes["symbol"] is None:
        errors.append(field_error("symbol", TICKER_RULE))
    if "name" in changes and changes["name"] is None:
        errors.append(field_error("name", _NO_NAME))
    errors += check_source_code(db, CRYPTO, changes.get("source_code"))
    if errors:
        raise RequestValidationError(errors)
    symbol = changes.get("symbol")
    if symbol is not None and symbol != coin.symbol.upper():
        if symbol in _symbols(db, user.id, except_id=coin.id):
            raise _duplicate(symbol)
    if symbol is not None:
        coin.symbol = symbol
    if "name" in changes:
        coin.name = changes["name"]
    if "source_code" in changes:
        coin.source_code = changes["source_code"]
    try:
        if changes.get("source_code") is not None:
            apply_link(db, CRYPTO)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _duplicate(symbol or coin.symbol) from None
    return _response(coin, latest_prices(db, user.id))


@router.delete("/coins/{id}")
def delete_coin(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    """A coin with no trades can be deleted; its prices go with it."""
    coin = get_owned_coin(db, user.id, id)
    trade = select(InvestmentTrade.id).where(InvestmentTrade.instrument_id == coin.id).limit(1)
    if db.scalar(trade) is not None:
        raise _in_use()
    db.execute(delete(InstrumentPrice).where(InstrumentPrice.instrument_id == coin.id))
    db.delete(coin)
    try:
        db.commit()
    except IntegrityError:  # a trade, or a price, was saved for it meanwhile
        db.rollback()
        raise _in_use() from None
    return Deleted(id=id)


@router.get("/coins/{id}/prices")
def list_coin_prices(id: int, user: CurrentUser, db: DbSession) -> CoinPriceList:
    coin = get_owned_coin(db, user.id, id)
    rows = db.scalars(
        select(InstrumentPrice)
        .where(InstrumentPrice.instrument_id == coin.id)
        .order_by(InstrumentPrice.date.desc(), InstrumentPrice.id.desc())
    ).all()
    return CoinPriceList(
        prices=[
            CoinPriceResponse(
                id=p.id, date=p.date.isoformat(), price=fmt_price(p.price), source=p.source
            )
            for p in rows
        ]
    )


@router.post("/coins/{id}/prices", status_code=status.HTTP_201_CREATED)
def create_coin_price(
    id: int, body: CoinPriceCreate, user: CurrentUser, db: DbSession
) -> CoinPriceResponse:
    coin = get_owned_coin(db, user.id, id)
    errors = []
    if body.date is None:
        errors.append(field_error("date", "Choose a date."))
    elif body.date > today_india():
        errors.append(field_error("date", "The date can't be in the future."))
    if body.price is None:
        errors.append(field_error("price", PRICE_RULE))
    if errors:
        raise RequestValidationError(errors)
    assert body.date is not None and body.price is not None
    row = InstrumentPrice(user_id=user.id, instrument_id=coin.id, date=body.date, price=body.price)
    db.add(row)
    db.commit()
    return CoinPriceResponse(
        id=row.id, date=row.date.isoformat(), price=fmt_price(row.price), source="manual"
    )


@router.delete("/coin-prices/{id}")
def delete_coin_price(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    price = None
    if 1 <= id <= MAX_ID:
        # Only a coin's price; a stock's price or a fund's NAV is not found here.
        price = db.scalar(
            select(InstrumentPrice)
            .join(Instrument, Instrument.id == InstrumentPrice.instrument_id)
            .where(
                InstrumentPrice.id == id,
                InstrumentPrice.user_id == user.id,
                Instrument.kind == CRYPTO,
            )
        )
    if price is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Price not found.")
    db.delete(price)
    db.commit()
    return Deleted(id=id)
