"""Linking holdings to shared market codes, and the routes that serve that screen."""

import logging
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, BeforeValidator
from pydantic_core import PydanticCustomError
from sqlalchemy import case, func, or_, select

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.portfolio import fmt_nav, fmt_price
from app.api.routes.accounts import field_error
from app.db.session import DbSession
from app.models.investment import Instrument
from app.models.market import MarketCode
from app.prices.fetch import SourceError, default_fetcher
from app.prices.parse import parse_coin_search
from app.prices.refresh import _upsert_quotes, apply_to_users, refresh_market

router = APIRouter(
    prefix="/investments", tags=["investments"], dependencies=[Depends(get_current_user)]
)
log = logging.getLogger("app.prices")

PICK_A_MATCH = "Pick a match from the search."
MIN_QUERY = 2
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


def apply_link(db: DbSession, kind: str) -> None:
    """After a link: give the holding the market price right away. Flushes; caller commits."""
    db.flush()
    apply_to_users(db, only_kind=kind)


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


def _search_coins(db: DbSession, q: str) -> list[MarketCode]:
    try:
        quotes = parse_coin_search(default_fetcher().coin_search(q))
    except SourceError as exc:
        log.warning("coin search failed: %s", exc)
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Couldn't search coins right now."
        ) from None
    _upsert_quotes(db, "crypto", quotes)
    db.commit()
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
    report = refresh_market(db, default_fetcher(), today_india(), kinds={"crypto"})
    if "crypto" in report.failed:
        log.warning("coin refresh failed: %s", report.failed["crypto"])
        db.rollback()
        return RefreshedResponse(refreshed=False)
    apply_to_users(db, only_kind="crypto")
    db.commit()
    return RefreshedResponse(refreshed=True)
