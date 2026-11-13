import re
from datetime import date
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
from app.api.portfolio import latest_prices
from app.api.routes.accounts import MAX_ID, Money, clean_text, field_error, fmt
from app.api.routes.market import SourceCode, apply_link, check_source_code, set_link
from app.api.routes.transactions import Day
from app.db.session import DbSession
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

STOCK = "stock"
_SYMBOL = re.compile(r"[A-Z0-9&.\-]{1,20}")
_BAD_SYMBOL = "Use 1 to 20 letters, digits, &, - or ."


def _symbol(value: Any) -> str | None:
    if value is None:
        return None
    text = value.strip().upper() if isinstance(value, str) else ""
    if not _SYMBOL.fullmatch(text):
        raise PydanticCustomError("symbol", _BAD_SYMBOL)
    return text


BAD_SYMBOL = _BAD_SYMBOL
check_symbol = _symbol
Symbol = Annotated[str | None, BeforeValidator(_symbol)]
StockName = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, "Enter a name.", 60))]


class StockCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    symbol: Symbol = None
    name: StockName = None
    source_code: SourceCode = None


class StockUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    symbol: Symbol = None
    name: StockName = None
    source_code: SourceCode = None


class PriceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: Day = None
    price: Money = None


class StockResponse(BaseModel):
    id: int
    symbol: str
    name: str
    price: str | None
    price_date: str | None
    source_code: str | None


class StockList(BaseModel):
    stocks: list[StockResponse]


class PriceResponse(BaseModel):
    id: int
    date: str
    price: str
    source: str


class PriceList(BaseModel):
    prices: list[PriceResponse]


class Deleted(BaseModel):
    id: int


def get_owned_stock(db: DbSession, user_id: int, id: int) -> Instrument:
    """The user's stock with this id. Another kind of instrument is not found, like a stranger's."""
    # Ids outside the column's range can't exist; asking the database would be a 500.
    stock = None
    if 1 <= id <= MAX_ID:
        stock = db.scalar(
            select(Instrument).where(
                Instrument.id == id, Instrument.user_id == user_id, Instrument.kind == STOCK
            )
        )
    if stock is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Stock not found.")
    return stock


def _response(stock: Instrument, prices: dict[int, tuple[date, Decimal]]) -> StockResponse:
    current = prices.get(stock.id)
    return StockResponse(
        id=stock.id,
        symbol=stock.symbol,
        name=stock.name,
        price=None if current is None else fmt(current[1]),
        price_date=None if current is None else current[0].isoformat(),
        source_code=stock.source_code,
    )


def _taken(db: DbSession, user_id: int, symbol: str, except_id: int | None = None) -> bool:
    query = select(Instrument.id).where(
        Instrument.user_id == user_id,
        Instrument.kind == STOCK,
        func.upper(Instrument.symbol) == symbol,
    )
    if except_id is not None:
        query = query.where(Instrument.id != except_id)
    return db.scalar(query.limit(1)) is not None


def _duplicate(symbol: str) -> RequestValidationError:
    return RequestValidationError([field_error("symbol", f"You already have {symbol}.")])


def _in_use() -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT, "This stock has trades or prices. Delete them first."
    )


@router.get("/stocks")
def list_stocks(user: CurrentUser, db: DbSession) -> StockList:
    stocks = db.scalars(
        select(Instrument)
        .where(Instrument.user_id == user.id, Instrument.kind == STOCK)
        .order_by(Instrument.symbol)
    ).all()
    prices = latest_prices(db, user.id)
    return StockList(stocks=[_response(s, prices) for s in stocks])


def add_stock(db: DbSession, user_id: int, body: StockCreate) -> Instrument:
    """Validate and add a new stock, flushed so it has an id. The caller commits."""
    errors = []
    if body.symbol is None:
        errors.append(field_error("symbol", _BAD_SYMBOL))
    if body.name is None:
        errors.append(field_error("name", "Enter a name."))
    errors += check_source_code(db, STOCK, body.source_code)
    if errors:
        raise RequestValidationError(errors)
    assert body.symbol is not None and body.name is not None
    if _taken(db, user_id, body.symbol):
        raise _duplicate(body.symbol)
    stock = Instrument(
        user_id=user_id,
        kind=STOCK,
        symbol=body.symbol,
        name=body.name,
        source_code=body.source_code,
    )
    db.add(stock)
    try:
        db.flush()
        if body.source_code is not None:
            apply_link(db, STOCK, user_id)
    except IntegrityError:  # a concurrent request took the symbol first
        db.rollback()
        raise _duplicate(body.symbol) from None
    return stock


def stock_response(db: DbSession, user_id: int, stock: Instrument) -> StockResponse:
    return _response(stock, latest_prices(db, user_id))


@router.post("/stocks", status_code=status.HTTP_201_CREATED)
def create_stock(body: StockCreate, user: CurrentUser, db: DbSession) -> StockResponse:
    stock = add_stock(db, user.id, body)
    try:
        db.commit()
    except IntegrityError:  # a concurrent request took the symbol first
        db.rollback()
        raise _duplicate(stock.symbol) from None
    return _response(stock, latest_prices(db, user.id) if body.source_code else {})


@router.patch("/stocks/{id}")
def update_stock(id: int, body: StockUpdate, user: CurrentUser, db: DbSession) -> StockResponse:
    stock = get_owned_stock(db, user.id, id)
    changes = body.model_dump(exclude_unset=True)
    errors = []
    if "symbol" in changes and changes["symbol"] is None:
        errors.append(field_error("symbol", _BAD_SYMBOL))
    if "name" in changes and changes["name"] is None:
        errors.append(field_error("name", "Enter a name."))
    errors += check_source_code(db, STOCK, changes.get("source_code"))
    if errors:
        raise RequestValidationError(errors)
    symbol = changes.get("symbol")
    if symbol is not None and symbol != stock.symbol.upper():
        if _taken(db, user.id, symbol, except_id=stock.id):
            raise _duplicate(symbol)
    if symbol is not None:
        stock.symbol = symbol
    if "name" in changes:
        stock.name = changes["name"]
    if "source_code" in changes:
        set_link(db, stock, changes["source_code"])
    try:
        if changes.get("source_code") is not None:
            apply_link(db, STOCK, user.id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _duplicate(symbol or stock.symbol) from None
    return _response(stock, latest_prices(db, user.id))


@router.delete("/stocks/{id}")
def delete_stock(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    stock = get_owned_stock(db, user.id, id)
    has_price = db.scalar(
        select(InstrumentPrice.id)
        .where(InstrumentPrice.instrument_id == stock.id, InstrumentPrice.source != "auto")
        .limit(1)
    )
    has_trade = db.scalar(
        select(InvestmentTrade.id).where(InvestmentTrade.instrument_id == stock.id).limit(1)
    )
    if has_price is not None or has_trade is not None:
        raise _in_use()
    # Automatic prices are the market's, not the user's: they go with the stock.
    db.execute(
        delete(InstrumentPrice).where(
            InstrumentPrice.instrument_id == stock.id, InstrumentPrice.source == "auto"
        )
    )
    db.delete(stock)
    try:
        db.commit()
    except IntegrityError:  # a trade or price was saved for it meanwhile
        db.rollback()
        raise _in_use() from None
    return Deleted(id=id)


@router.get("/stocks/{id}/prices")
def list_prices(id: int, user: CurrentUser, db: DbSession) -> PriceList:
    stock = get_owned_stock(db, user.id, id)
    rows = db.scalars(
        select(InstrumentPrice)
        .where(InstrumentPrice.instrument_id == stock.id)
        .order_by(InstrumentPrice.date.desc(), InstrumentPrice.id.desc())
    ).all()
    return PriceList(
        prices=[
            PriceResponse(id=p.id, date=p.date.isoformat(), price=fmt(p.price), source=p.source)
            for p in rows
        ]
    )


@router.post("/stocks/{id}/prices", status_code=status.HTTP_201_CREATED)
def create_price(id: int, body: PriceCreate, user: CurrentUser, db: DbSession) -> PriceResponse:
    stock = get_owned_stock(db, user.id, id)
    errors = []
    if body.date is None:
        errors.append(field_error("date", "Choose a date."))
    elif body.date > today_india():
        errors.append(field_error("date", "The date can't be in the future."))
    if body.price is None:
        errors.append(field_error("price", "Enter a price, like 1234.50."))
    elif body.price <= 0:
        errors.append(field_error("price", "Price must be greater than 0."))
    if errors:
        raise RequestValidationError(errors)
    assert body.date is not None and body.price is not None
    price = InstrumentPrice(
        user_id=user.id, instrument_id=stock.id, date=body.date, price=body.price
    )
    db.add(price)
    db.commit()
    return PriceResponse(
        id=price.id, date=price.date.isoformat(), price=fmt(price.price), source="manual"
    )


@router.delete("/prices/{id}")
def delete_price(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    price = None
    if 1 <= id <= MAX_ID:
        # Only a stock's price; a fund's NAV is not found here.
        price = db.scalar(
            select(InstrumentPrice)
            .join(Instrument, Instrument.id == InstrumentPrice.instrument_id)
            .where(
                InstrumentPrice.id == id,
                InstrumentPrice.user_id == user.id,
                Instrument.kind == STOCK,
            )
        )
    if price is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Price not found.")
    db.delete(price)
    db.commit()
    return Deleted(id=id)
