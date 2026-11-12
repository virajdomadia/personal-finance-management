"""Linking holdings to shared market codes, and the routes that serve that screen."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator
from pydantic_core import PydanticCustomError
from sqlalchemy import case, delete, func, or_, select
from sqlalchemy.exc import IntegrityError

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import fmt_nav, fmt_price
from app.api.routes.accounts import field_error
from app.db.session import DbSession
from app.models.investment import Instrument, InstrumentPrice
from app.models.market import MarketCode
from app.prices.fetch import default_fetcher
from app.prices.parse import Quote, parse_coin_search
from app.prices.refresh import _upsert_quotes, apply_to_users, refresh_market, sync_user_prices

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)
log = logging.getLogger("app.prices")

PICK_A_MATCH = "Pick a match from the search."
MIN_QUERY = 2
MAX_QUERY = 60
RESULT_LIMIT = 20
COIN_MAX_AGE = timedelta(hours=6)


def _source_code(value: Any) -> str | None:
    """Blank or null means "no link"; anything else must be a code, checked against the table."""
    if value is None:
        return None
    if not isinstance(value, str) or len(value.strip()) > 40:
        raise PydanticCustomError("source_code", PICK_A_MATCH)
    return value.strip() or None


# For the create and update bodies of stocks, funds and coins.
SourceCode = Annotated[str | None, BeforeValidator(_source_code)]


def check_source_code(db: DbSession, kind: str, code: str | None) -> list[dict[str, Any]]:
    """Errors (none, or one on `source_code`) for linking an instrument of `kind` to `code`."""
    if code is None:
        return []
    found = db.scalar(
        select(MarketCode.id).where(MarketCode.kind == kind, MarketCode.code == code).limit(1)
    )
    return [] if found is not None else [field_error("source_code", PICK_A_MATCH)]


def set_link(db: DbSession, inst: Instrument, code: str | None) -> None:
    """Point a holding at `code`. Moving it to a different code drops the old code's auto
    prices, so the two never mix; unlinking (None) keeps them. Manual prices always stay."""
    if code is not None and inst.source_code is not None and code != inst.source_code:
        db.execute(
            delete(InstrumentPrice).where(
                InstrumentPrice.instrument_id == inst.id, InstrumentPrice.source == "auto"
            )
        )
    inst.source_code = code


def apply_link(db: DbSession, kind: str, user_id: int) -> None:
    """After a link: give the user's holding the market price right away. Flushes; caller
    commits. Other users' holdings wait for the nightly job."""
    db.flush()
    apply_to_users(db, only_kind=kind, user_id=user_id)


class MarketCodeResponse(BaseModel):
    code: str
    name: str
    isin: str | None
    price: str | None
    price_date: str | None


class MarketCodeList(BaseModel):
    results: list[MarketCodeResponse]


class Linkable(BaseModel):
    id: int
    symbol: str
    name: str


class UnlinkedResponse(BaseModel):
    stocks: list[Linkable]
    funds: list[Linkable]
    coins: list[Linkable]


class RefreshedResponse(BaseModel):
    refreshed: bool


class SyncResponse(BaseModel):
    synced_at: str
    updated: dict[str, int]
    failed: dict[str, str]


def _market_response(row: MarketCode) -> MarketCodeResponse:
    shown = None
    if row.price is not None:
        shown = (fmt_nav if row.kind == "mutual_fund" else fmt_price)(row.price)
    return MarketCodeResponse(
        code=row.code,
        name=row.name,
        isin=row.isin,
        price=shown,
        price_date=None if row.price_date is None else row.price_date.isoformat(),
    )


def _search_table(db: DbSession, kind: str, q: str) -> list[MarketCode]:
    """Exact code first, then names starting with `q`, then any other match; ties by name."""
    low = q.lower()
    name, code = func.lower(MarketCode.name), func.lower(MarketCode.code)
    rank = case((code == low, 0), (name.startswith(low, autoescape=True), 1), else_=2)
    return list(
        db.scalars(
            select(MarketCode)
            .where(
                MarketCode.kind == kind,
                or_(name.contains(low, autoescape=True), code.contains(low, autoescape=True)),
            )
            .order_by(rank, name, MarketCode.code)
            .limit(RESULT_LIMIT)
        )
    )


def save_coin_quotes(db: DbSession, quotes: list[Quote]) -> None:
    """Remember searched coins. Two searches at once can both add the same new coin; the loser
    rolls back and tries again, now seeing the other's rows, then settles for what is stored."""
    for _ in range(2):
        try:
            _upsert_quotes(db, "crypto", quotes)
            db.commit()
            return
        except IntegrityError:
            db.rollback()
    log.warning("coin search could not save its results; using what is stored")


def _search_coins(db: DbSession, q: str) -> list[MarketCode]:
    try:
        with default_fetcher() as fetcher:
            quotes = parse_coin_search(fetcher.coin_search(q))
    except Exception:  # a source error, or anything the reply throws at the parser
        log.exception("coin search failed")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Couldn't search coins right now."
        ) from None
    save_coin_quotes(db, quotes)
    codes = [quote.code for quote in quotes]
    rows = {
        m.code: m
        for m in db.scalars(
            select(MarketCode).where(MarketCode.kind == "crypto", MarketCode.code.in_(codes))
        )
    }
    return [rows[c] for c in dict.fromkeys(codes) if c in rows][:RESULT_LIMIT]


@router.get("/market-codes")
def search_market_codes(
    db: DbSession,
    kind: Annotated[Literal["mutual_fund", "stock", "crypto"], Query()],
    q: Annotated[str, Query()] = "",
) -> MarketCodeList:
    q = q.strip()
    if len(q) > MAX_QUERY:
        message = f"Search for {MAX_QUERY} characters or fewer."
        raise RequestValidationError(
            [{"loc": ("query", "q"), "msg": message, "type": "value_error"}]
        )
    if len(q) < MIN_QUERY:
        return MarketCodeList(results=[])
    rows = _search_coins(db, q) if kind == "crypto" else _search_table(db, kind, q)
    return MarketCodeList(results=[_market_response(r) for r in rows])


@router.get("/unlinked")
def list_unlinked(user: CurrentUser, db: DbSession) -> UnlinkedResponse:
    rows = db.scalars(
        select(Instrument)
        .where(Instrument.user_id == user.id, Instrument.source_code.is_(None))
        .order_by(func.lower(Instrument.name), Instrument.id)
    ).all()

    def of(kind: str) -> list[Linkable]:
        return [Linkable(id=i.id, symbol=i.symbol, name=i.name) for i in rows if i.kind == kind]

    return UnlinkedResponse(stocks=of("stock"), funds=of("mutual_fund"), coins=of("crypto"))


def _coins_stale(db: DbSession, user_id: int) -> bool:
    """Whether the user's linked coins need a fresh quote: unpriced, or last updated long ago."""
    rows = db.execute(
        select(MarketCode.price, MarketCode.updated_at)
        .join(
            Instrument,
            (Instrument.kind == MarketCode.kind) & (Instrument.source_code == MarketCode.code),
        )
        .where(Instrument.user_id == user_id, Instrument.kind == "crypto")
    ).all()
    if not rows:
        return False
    if any(price is None for price, _ in rows):
        return True
    newest = max(updated for _, updated in rows)
    if newest.tzinfo is None:  # SQLite hands back naive UTC
        newest = newest.replace(tzinfo=UTC)
    return datetime.now(UTC) - newest > COIN_MAX_AGE


@router.post("/coins/refresh")
def refresh_coins(user: CurrentUser, db: DbSession) -> RefreshedResponse:
    """Coin prices move all day, so opening the app tops them up. Never an error: a source that
    is down just means the last stored price stays."""
    if not _coins_stale(db, user.id):
        return RefreshedResponse(refreshed=False)
    with default_fetcher() as fetcher:
        report = refresh_market(db, fetcher, today_india(), kinds={"crypto"})
    if "crypto" in report.failed:
        log.warning("coin refresh failed: %s", report.failed["crypto"])
        db.rollback()
        return RefreshedResponse(refreshed=False)
    apply_to_users(db, only_kind="crypto", user_id=user.id)
    db.commit()
    return RefreshedResponse(refreshed=True)


@router.post("/prices/sync")
def sync_prices(user: CurrentUser, db: DbSession) -> SyncResponse:
    """The Sync prices button. Only this user's holdings; a source that is down is reported in
    `failed`, never as an error, and what is stored stays."""
    now = datetime.now(UTC)
    with default_fetcher() as fetcher:
        report = sync_user_prices(db, fetcher, user.id, today_india(), now)
    return SyncResponse(
        synced_at=now.isoformat().replace("+00:00", "Z"),
        updated=report.updated,
        failed=report.failed,
    )
