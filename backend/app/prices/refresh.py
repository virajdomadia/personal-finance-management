"""The nightly job: refresh the shared market_codes prices, then copy them to linked holdings.

Each source runs on its own, so one being down never blocks the others, and a failure never
clears anything already stored. Manual prices are never overwritten or deleted.
"""

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.investment import Instrument, InstrumentPrice
from app.models.market import MarketCode
from app.prices.fetch import Fetcher, SourceError
from app.prices.parse import (
    Quote,
    parse_bhavcopy,
    parse_equity_list,
    parse_navall,
    parse_simple_price,
    parse_yahoo_close,
)

log = logging.getLogger("app.prices")

KINDS = ("mutual_fund", "stock", "crypto")
NAME_MAX = 160  # MarketCode.name
CODE_MAX = 40  # MarketCode.code


@dataclass
class RefreshReport:
    # Per kind: how many market_codes got a price this run, and why a source failed.
    updated: dict[str, int] = field(default_factory=dict)
    failed: dict[str, str] = field(default_factory=dict)


def _existing(db: Session, kind: str) -> dict[str, MarketCode]:
    return {m.code: m for m in db.scalars(select(MarketCode).where(MarketCode.kind == kind))}


def _upsert_quotes(db: Session, kind: str, quotes: Iterable[Quote]) -> int:
    """Add or refresh names and prices in bulk. A quote without a price never clears one."""
    known = _existing(db, kind)
    priced = 0
    for q in quotes:
        if len(q.code) > CODE_MAX:
            continue  # never store a truncated code
        name = q.name[:NAME_MAX]
        row = known.get(q.code)
        if row is None:
            row = known[q.code] = MarketCode(kind=kind, code=q.code, name=name, isin=q.isin)
            db.add(row)
        else:
            if row.name != name:
                row.name = name
            if q.isin and row.isin != q.isin:
                row.isin = q.isin
        if q.price is not None and q.price_date is not None:
            if (row.price, row.price_date) != (q.price, q.price_date):
                row.price, row.price_date = q.price, q.price_date
            priced += 1
    db.flush()
    return priced


def _set_prices(
    db: Session, kind: str, prices: dict[str, tuple[Decimal, date]], create_missing: bool
) -> int:
    known = _existing(db, kind)
    count = 0
    for code, (price, day) in prices.items():
        row = known.get(code)
        if row is None:
            if not create_missing:
                continue
            row = MarketCode(kind=kind, code=code, name=code)
            db.add(row)
        if (row.price, row.price_date) != (price, day):
            row.price, row.price_date = price, day
        count += 1
    db.flush()
    return count


def _linked_codes(db: Session, kind: str) -> list[str]:
    return list(
        db.scalars(
            select(Instrument.source_code)
            .where(Instrument.kind == kind, Instrument.source_code.is_not(None))
            .distinct()
            .order_by(Instrument.source_code)
        )
    )


def _refresh_funds(db: Session, fetcher: Fetcher) -> int:
    return _upsert_quotes(db, "mutual_fund", parse_navall(fetcher.navall()))


def _yahoo_closes(db: Session, fetcher: Fetcher) -> dict[str, tuple[Decimal, date]]:
    closes: dict[str, tuple[Decimal, date]] = {}
    errors: list[str] = []
    for symbol in _linked_codes(db, "stock"):
        try:
            close = parse_yahoo_close(fetcher.yahoo_chart(symbol))
        except SourceError as exc:
            errors.append(str(exc))
            continue
        if close is not None:
            closes[symbol] = close
    if errors and not closes:
        raise SourceError(errors[0])
    return closes


def _refresh_stocks(db: Session, fetcher: Fetcher, today: date) -> int:
    errors: list[str] = []
    try:
        _upsert_quotes(db, "stock", parse_equity_list(fetcher.equity_list()))
    except SourceError as exc:
        errors.append(str(exc))
    try:
        text = fetcher.bhavcopy(today)
    except SourceError:
        text = None  # NSE answers 403 on some holidays; treat it like "no file today"
    try:
        closes = parse_bhavcopy(text) if text is not None else {}
        if not closes:  # no file, or one we can no longer read: fall back to linked stocks
            closes = _yahoo_closes(db, fetcher)
        count = _set_prices(db, "stock", closes, create_missing=False)
    except SourceError as exc:
        errors.append(str(exc))
        count = 0
    if errors and not count:
        raise SourceError("; ".join(errors))
    return count


def _refresh_crypto(db: Session, fetcher: Fetcher, today: date) -> int:
    ids = _linked_codes(db, "crypto")
    if not ids:
        return 0
    prices = parse_simple_price(fetcher.simple_price(ids))
    return _set_prices(db, "crypto", {c: (p, today) for c, p in prices.items()}, True)


def refresh_market(
    db: Session, fetcher: Fetcher, today: date, kinds: set[str] | None = None
) -> RefreshReport:
    """Pull each wanted source into market_codes. Flushes; the caller commits."""
    report = RefreshReport()
    jobs = {
        "mutual_fund": lambda: _refresh_funds(db, fetcher),
        "stock": lambda: _refresh_stocks(db, fetcher, today),
        "crypto": lambda: _refresh_crypto(db, fetcher, today),
    }
    for kind in KINDS:
        if kinds is not None and kind not in kinds:
            continue
        try:
            with db.begin_nested():
                report.updated[kind] = jobs[kind]()
        except SourceError as exc:
            report.failed[kind] = str(exc)
        except Exception as exc:
            log.exception("price source %s crashed", kind)
            report.failed[kind] = f"unexpected {exc.__class__.__name__}"
    return report


def apply_to_users(db: Session, only_kind: str | None = None) -> int:
    """Copy market prices onto linked instruments as "auto" rows; return how many were written.

    A date that already has any row for the instrument (manual, or a fund trade's NAV) is left
    alone. The one exception is an auto row that is the only row for its date: it follows the
    market price, so a coin moves through the day.
    """
    query = (
        select(Instrument, MarketCode)
        .join(
            MarketCode,
            (MarketCode.kind == Instrument.kind) & (MarketCode.code == Instrument.source_code),
        )
        .where(MarketCode.price.is_not(None), MarketCode.price_date.is_not(None))
    )
    if only_kind is not None:
        query = query.where(Instrument.kind == only_kind)
    pairs = db.execute(query).all()
    if not pairs:
        return 0

    on_date: dict[tuple[int, date], list[InstrumentPrice]] = {}
    for row in db.scalars(
        select(InstrumentPrice).where(
            InstrumentPrice.instrument_id.in_({inst.id for inst, _ in pairs})
        )
    ):
        on_date.setdefault((row.instrument_id, row.date), []).append(row)

    written = 0
    for inst, code in pairs:
        existing = on_date.get((inst.id, code.price_date), [])
        if not existing:
            db.add(
                InstrumentPrice(
                    user_id=inst.user_id,
                    instrument_id=inst.id,
                    date=code.price_date,
                    price=code.price,
                    source="auto",
                )
            )
            written += 1
        elif (
            len(existing) == 1 and existing[0].source == "auto" and existing[0].price != code.price
        ):
            existing[0].price = code.price
            written += 1
    db.flush()
    return written


def run_nightly(db: Session, fetcher: Fetcher, today: date) -> RefreshReport:
    report = refresh_market(db, fetcher, today)
    written = apply_to_users(db)
    db.commit()
    for kind, message in report.failed.items():
        log.warning("price source %s failed: %s", kind, message)
    log.info("nightly prices: updated=%s written=%d", report.updated, written)
    return report
