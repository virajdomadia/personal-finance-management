"""The nightly job: refresh the shared market_codes prices, then copy them to linked holdings.

Each source runs on its own, so one being down never blocks the others, and a failure never
clears anything already stored. Manual prices are never overwritten or deleted. Each kind is
committed as soon as it is done, so a slow source killed by the platform loses only itself.
"""

import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.investment import Instrument, InstrumentPrice
from app.models.market import MarketCode
from app.prices.fetch import Fetcher, SourceError, SourceTimeout
from app.prices.parse import (
    Quote,
    parse_bhavcopy,
    parse_equity_list,
    parse_navall,
    parse_simple_price,
    parse_yahoo_close,
)

log = logging.getLogger("app.prices")

BHAVCOPY_LOOKBACK_DAYS = 3  # weekdays tried before today's
STOCK_BUDGET_SECONDS = 45  # the Yahoo fallback stops once the stock source has run this long
# Quick, reliable sources first: stocks (NSE, then Yahoo per holding) are the slow, flaky one.
KINDS = ("crypto", "mutual_fund", "stock")
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
        # Fetched just now, even if unchanged: a steady price is fresh, not stale.
        row.updated_at = func.now()
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
    quotes = parse_navall(fetcher.navall())
    if not quotes:
        raise SourceError("AMFI file format not recognised")
    return _upsert_quotes(db, "mutual_fund", quotes)


Clock = Callable[[], float]


def _yahoo_closes(
    db: Session, fetcher: Fetcher, deadline: float, clock: Clock, notes: list[str]
) -> dict[str, tuple[Decimal, date]]:
    closes: dict[str, tuple[Decimal, date]] = {}
    errors: list[str] = []
    symbols = _linked_codes(db, "stock")
    for i, symbol in enumerate(symbols):
        if clock() >= deadline:
            skipped = symbols[i:]
            notes.append(
                f"time ran out; skipped Yahoo for {len(skipped)} stock(s): {', '.join(skipped)}"
            )
            break
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


def _latest_bhavcopy(fetcher: Fetcher, today: date, notes: list[str]) -> str | None:
    """Today's file, or the last one NSE published: it posts the day's file after the close.

    A timeout ends the search at once: NSE hanging on one day will hang on the others too.
    """
    day, tried = today, 0
    while tried <= BHAVCOPY_LOOKBACK_DAYS:
        if day.weekday() < 5:
            tried += 1
            try:
                text = fetcher.bhavcopy(day)
            except SourceTimeout as exc:
                log.warning("bhavcopy for %s timed out: %s", day, exc)
                notes.append(f"NSE timed out on the {day} price file; stopped looking further back")
                return None
            except SourceError as exc:
                # NSE answers 403 on some holidays; treat it like "no file", but leave a trace.
                log.warning("bhavcopy for %s unavailable: %s", day, exc)
                text = None
            if text is not None:
                return text
        day -= timedelta(days=1)
    notes.append(f"no NSE price file found for the last {BHAVCOPY_LOOKBACK_DAYS + 1} weekdays")
    return None


def _refresh_stocks(
    db: Session, fetcher: Fetcher, today: date, report: RefreshReport, clock: Clock
) -> int:
    deadline = clock() + STOCK_BUDGET_SECONDS
    errors: list[str] = []
    try:
        listed = parse_equity_list(fetcher.equity_list())
        if not listed:
            raise SourceError("NSE equity list format not recognised")
        _upsert_quotes(db, "stock", listed)
    except SourceError as exc:
        errors.append(str(exc))
    lookback: list[str] = []  # why no price file was used; only worth saying in some cases
    text = _latest_bhavcopy(fetcher, today, lookback)
    timed_out = any(note.startswith("NSE timed out") for note in lookback)
    try:
        closes = parse_bhavcopy(text) if text is not None else {}
        if not closes:  # no file, or one we can no longer read: fall back to linked stocks
            skipped: list[str] = []
            closes = _yahoo_closes(db, fetcher, deadline, clock, skipped)
            if timed_out or not closes:
                errors += lookback
            errors += skipped
        count = _set_prices(db, "stock", closes, create_missing=False)
    except SourceError as exc:
        errors += lookback
        errors.append(str(exc))
        count = 0
    if errors and not count:
        raise SourceError("; ".join(errors))
    if errors:  # prices still apply, but what failed or was skipped must not pass unnoticed
        report.failed["stock"] = "; ".join(errors)
        log.warning("stock source partly failed: %s", report.failed["stock"])
    return count


def _refresh_crypto(db: Session, fetcher: Fetcher, today: date) -> int:
    ids = _linked_codes(db, "crypto")
    if not ids:
        return 0
    prices = parse_simple_price(fetcher.simple_price(ids))
    return _set_prices(db, "crypto", {c: (p, today) for c, p in prices.items()}, True)


def refresh_market(
    db: Session,
    fetcher: Fetcher,
    today: date,
    kinds: set[str] | None = None,
    report: RefreshReport | None = None,
    clock: Clock = time.monotonic,
) -> RefreshReport:
    """Pull each wanted source into market_codes. Flushes; the caller commits."""
    report = RefreshReport() if report is None else report
    jobs = {
        "mutual_fund": lambda: _refresh_funds(db, fetcher),
        "stock": lambda: _refresh_stocks(db, fetcher, today, report, clock),
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


def apply_to_users(db: Session, only_kind: str | None = None, user_id: int | None = None) -> int:
    """Copy market prices onto linked instruments as "auto" rows; return how many were written.

    `only_kind` and `user_id` narrow it to one kind and to one user's holdings.

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
    if user_id is not None:
        query = query.where(Instrument.user_id == user_id)
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


def run_nightly(
    db: Session, fetcher: Fetcher, today: date, clock: Clock = time.monotonic
) -> RefreshReport:
    """Refresh and apply one kind at a time, committing each, in the order of KINDS."""
    report = RefreshReport()
    written = 0
    for kind in KINDS:
        refresh_market(db, fetcher, today, {kind}, report=report, clock=clock)
        written += apply_to_users(db, only_kind=kind)
        db.commit()
    for kind, message in report.failed.items():
        log.warning("price source %s failed: %s", kind, message)
    log.info("nightly prices: updated=%s written=%d", report.updated, written)
    return report
