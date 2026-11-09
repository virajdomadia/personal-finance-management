import re
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import fmt_nav, latest_prices
from app.api.routes.accounts import MAX_ID, clean_text, field_error
from app.api.routes.dashboard import today_india
from app.api.routes.stocks import Deleted, check_symbol
from app.api.routes.transactions import Day
from app.db.session import DbSession
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade, Sip

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)

MUTUAL_FUND = "mutual_fund"
_NUMBER = re.compile(r"[0-9]+(\.[0-9]+)?")
_MAX_NUMBER_TEXT = 40
_NO_NAME = "Enter a name."


def _decimal(places: int, upper: Decimal, message: str):  # noqa: ANN202
    def check(value: Any) -> Decimal | None:
        # Text only: a JSON number would already be a binary float by the time it reaches us.
        if value is None:
            return None
        text = value.strip() if isinstance(value, str) else ""
        match = _NUMBER.fullmatch(text) if len(text) <= _MAX_NUMBER_TEXT else None
        if match is None:
            raise PydanticCustomError("number", message)
        fraction = (match.group(1) or ".")[1:].rstrip("0")
        number = Decimal(text)
        if len(fraction) > places or not 0 < number < upper:
            raise PydanticCustomError("number", message)
        return number

    return check


Units = Annotated[
    Decimal | None,
    BeforeValidator(
        _decimal(3, Decimal(10) ** 15, "Enter units above 0, with up to 3 decimals, like 35.552.")
    ),
]
_BAD_NAV = "Enter a NAV above 0, with up to 4 decimals, like 84.3793."
Nav = Annotated[Decimal | None, BeforeValidator(_decimal(4, Decimal(10) ** 10, _BAD_NAV))]
# Blank means "none given": a new fund gets a derived symbol, an edit keeps the current one.
FundSymbol = Annotated[
    str | None,
    BeforeValidator(
        lambda v: None if v is None or (isinstance(v, str) and not v.strip()) else check_symbol(v)
    ),
]
FundName = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, _NO_NAME, 60))]


class FundCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    name: FundName = None
    symbol: FundSymbol = None


class FundUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: FundName = None
    symbol: FundSymbol = None


class NavCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: Day = None
    nav: Nav = None


class FundResponse(BaseModel):
    id: int
    symbol: str
    name: str
    nav: str | None
    nav_date: str | None


class FundList(BaseModel):
    funds: list[FundResponse]


class NavResponse(BaseModel):
    id: int
    date: str
    nav: str
    trade_id: int | None


class NavList(BaseModel):
    navs: list[NavResponse]


def get_owned_fund(db: DbSession, user_id: int, id: int) -> Instrument:
    """The user's fund with this id. A stock is not found, like a stranger's fund."""
    fund = None
    if 1 <= id <= MAX_ID:
        fund = db.scalar(
            select(Instrument).where(
                Instrument.id == id, Instrument.user_id == user_id, Instrument.kind == MUTUAL_FUND
            )
        )
    if fund is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fund not found.")
    return fund


def derive_symbol(name: str, taken: set[str]) -> str:
    """The initials of the name's words, made unique among `taken` with a number."""
    letters = []
    for word in name.split():
        first = next((c.upper() for c in word if c.isalnum()), "")
        if re.fullmatch(r"[A-Z0-9]", first):
            letters.append(first)
    base = "".join(letters)[:20] or "FUND"
    symbol, n = base, 1
    while symbol in taken:
        n += 1
        symbol = base[: 20 - len(str(n))] + str(n)
    return symbol


def _response(fund: Instrument, prices: dict[int, tuple[Any, Decimal]]) -> FundResponse:
    current = prices.get(fund.id)
    return FundResponse(
        id=fund.id,
        symbol=fund.symbol,
        name=fund.name,
        nav=None if current is None else fmt_nav(current[1]),
        nav_date=None if current is None else current[0].isoformat(),
    )


def _symbols(db: DbSession, user_id: int, except_id: int | None = None) -> set[str]:
    query = select(Instrument.symbol).where(
        Instrument.user_id == user_id, Instrument.kind == MUTUAL_FUND
    )
    if except_id is not None:
        query = query.where(Instrument.id != except_id)
    return {s.upper() for s in db.scalars(query)}


def _duplicate(symbol: str) -> RequestValidationError:
    return RequestValidationError([field_error("symbol", f"You already have {symbol}.")])


def _in_use() -> HTTPException:
    return HTTPException(
        status.HTTP_409_CONFLICT, "This fund has transactions, NAVs or SIPs. Delete them first."
    )


@router.get("/funds")
def list_funds(user: CurrentUser, db: DbSession) -> FundList:
    funds = db.scalars(
        select(Instrument)
        .where(Instrument.user_id == user.id, Instrument.kind == MUTUAL_FUND)
        .order_by(func.lower(Instrument.name), Instrument.id)
    ).all()
    prices = latest_prices(db, user.id)
    return FundList(funds=[_response(f, prices) for f in funds])


@router.post("/funds", status_code=status.HTTP_201_CREATED)
def create_fund(body: FundCreate, user: CurrentUser, db: DbSession) -> FundResponse:
    if body.name is None:
        raise RequestValidationError([field_error("name", _NO_NAME)])
    taken = _symbols(db, user.id)
    symbol = body.symbol
    if symbol is None:
        symbol = derive_symbol(body.name, taken)
    elif symbol in taken:
        raise _duplicate(symbol)
    fund = Instrument(user_id=user.id, kind=MUTUAL_FUND, symbol=symbol, name=body.name)
    db.add(fund)
    try:
        db.commit()
    except IntegrityError:  # a concurrent request took the symbol first
        db.rollback()
        raise _duplicate(symbol) from None
    return _response(fund, {})


@router.patch("/funds/{id}")
def update_fund(id: int, body: FundUpdate, user: CurrentUser, db: DbSession) -> FundResponse:
    fund = get_owned_fund(db, user.id, id)
    changes = body.model_dump(exclude_unset=True)
    errors = []
    if "name" in changes and changes["name"] is None:
        errors.append(field_error("name", _NO_NAME))
    if errors:
        raise RequestValidationError(errors)
    symbol = changes.get("symbol")
    if symbol is not None and symbol != fund.symbol.upper():
        if symbol in _symbols(db, user.id, except_id=fund.id):
            raise _duplicate(symbol)
    if symbol is not None:
        fund.symbol = symbol
    if "name" in changes:
        fund.name = changes["name"]
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _duplicate(symbol or fund.symbol) from None
    return _response(fund, latest_prices(db, user.id))


@router.delete("/funds/{id}")
def delete_fund(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    fund = get_owned_fund(db, user.id, id)
    for table in (InstrumentPrice, InvestmentTrade, Sip):
        if db.scalar(select(table.id).where(table.instrument_id == fund.id).limit(1)) is not None:
            raise _in_use()
    db.delete(fund)
    try:
        db.commit()
    except IntegrityError:  # a trade, NAV or SIP was saved for it meanwhile
        db.rollback()
        raise _in_use() from None
    return Deleted(id=id)


@router.get("/funds/{id}/navs")
def list_navs(id: int, user: CurrentUser, db: DbSession) -> NavList:
    fund = get_owned_fund(db, user.id, id)
    rows = db.scalars(
        select(InstrumentPrice)
        .where(InstrumentPrice.instrument_id == fund.id)
        .order_by(InstrumentPrice.date.desc(), InstrumentPrice.id.desc())
    ).all()
    return NavList(
        navs=[
            NavResponse(id=n.id, date=n.date.isoformat(), nav=fmt_nav(n.price), trade_id=n.trade_id)
            for n in rows
        ]
    )


@router.post("/funds/{id}/navs", status_code=status.HTTP_201_CREATED)
def create_nav(id: int, body: NavCreate, user: CurrentUser, db: DbSession) -> NavResponse:
    fund = get_owned_fund(db, user.id, id)
    errors = []
    if body.date is None:
        errors.append(field_error("date", "Choose a date."))
    elif body.date > today_india():
        errors.append(field_error("date", "The date can't be in the future."))
    if body.nav is None:
        errors.append(field_error("nav", _BAD_NAV))
    if errors:
        raise RequestValidationError(errors)
    assert body.date is not None and body.nav is not None
    row = InstrumentPrice(user_id=user.id, instrument_id=fund.id, date=body.date, price=body.nav)
    db.add(row)
    db.commit()
    return NavResponse(id=row.id, date=row.date.isoformat(), nav=fmt_nav(row.price), trade_id=None)


@router.delete("/navs/{id}")
def delete_nav(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    nav = None
    if 1 <= id <= MAX_ID:
        # Only a fund's NAV; a stock's price is not found here.
        nav = db.scalar(
            select(InstrumentPrice)
            .join(Instrument, Instrument.id == InstrumentPrice.instrument_id)
            .where(
                InstrumentPrice.id == id,
                InstrumentPrice.user_id == user.id,
                Instrument.kind == MUTUAL_FUND,
            )
        )
    if nav is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "NAV not found.")
    db.delete(nav)
    db.commit()
    return Deleted(id=id)
