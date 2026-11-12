"""The nightly job: refresh the shared market_codes prices, then copy them to linked holdings.

Each source runs on its own, so one being down never blocks the others, and a failure never
clears anything already stored. Manual prices are never overwritten or deleted. Each kind is
committed as soon as it is done, so a slow source killed by the platform loses only itself.
"""

import logging
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from datetime import time as clock_time
from decimal import Decimal
from typing import NamedTuple

from sqlalchemy import case, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.investment import Instrument, InstrumentPrice
from app.models.market import MarketCode
from app.prices.fetch import Fetcher, SourceError, SourceTimeout
from app.prices.parse import (
    IST,
    Quote,
    parse_bhavcopy,
    parse_coindcx_ticker,
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


class _Known(NamedTuple):
    name: str
    isin: str | None
    price: Decimal | None
    price_date: date | None


def _existing(db: Session, kind: str) -> dict[str, _Known]:
    """What is stored for each code of `kind`, as plain tuples (no ORM objects to track)."""
    m = MarketCode
    rows = db.execute(select(m.code, m.name, m.isin, m.price, m.price_date).where(m.kind == kind))
    return {code: _Known(name, isin, price, day) for code, name, isin, price, day in rows}


UPSERT_CHUNK = 500  # rows per statement: well under SQLite's and PostgreSQL's parameter limits


def _upsert(db: Session, kind: str, rows: dict[str, dict]) -> None:
    """Write many market codes in a few statements: INSERT ... ON CONFLICT DO UPDATE in chunks.

    Thousands of rows one at a time took minutes once the database was a long round trip away
    (the API in one region, Neon in another). A row whose price is None keeps the stored price
    and date; a None isin keeps the stored isin. Every written row gets a fresh updated_at.
    """
    if not rows:
        return
    db.flush()
    values = [
        {
            "kind": kind,
            "code": code,
            "name": row["name"],
            "isin": row.get("isin"),
            "price": row.get("price"),
            "price_date": row.get("price_date"),
        }
        for code, row in rows.items()
    ]
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    for start in range(0, len(values), UPSERT_CHUNK):
        stmt = insert(MarketCode).values(values[start : start + UPSERT_CHUNK])
        new = stmt.excluded
        keep_price = new.price.is_(None)
        db.execute(
            stmt.on_conflict_do_update(
                index_elements=[MarketCode.kind, MarketCode.code],
                set_={
                    "name": new.name,
                    "isin": func.coalesce(new.isin, MarketCode.isin),
                    "price": case((keep_price, MarketCode.price), else_=new.price),
                    "price_date": case((keep_price, MarketCode.price_date), else_=new.price_date),
                    "updated_at": func.now(),
                },
            )
        )
    # Market codes loaded as ORM objects earlier in this session would now be stale.
    db.expire_all()


def _upsert_quotes(db: Session, kind: str, quotes: Iterable[Quote]) -> int:
    """Add or refresh names and prices in bulk. A quote without a price never clears one."""
    known = _existing(db, kind)
    changed: dict[str, dict] = {}
    priced = 0
    for q in quotes:
        if len(q.code) > CODE_MAX:
            continue  # never store a truncated code
        name = q.name[:NAME_MAX]
        has_price = q.price is not None and q.price_date is not None
        if has_price:
            priced += 1
        row = known.get(q.code)
        price, day = (q.price, q.price_date) if has_price else (None, None)
        if (
            row is None
            or row.name != name
            or (q.isin and row.isin != q.isin)
            or (has_price and (row.price, row.price_date) != (price, day))
        ):
            changed[q.code] = {"name": name, "isin": q.isin, "price": price, "price_date": day}
    _upsert(db, kind, changed)
    return priced


def _set_prices(
    db: Session, kind: str, prices: dict[str, tuple[Decimal, date]], create_missing: bool
) -> int:
    known = _existing(db, kind)
    rows: dict[str, dict] = {}
    for code, (price, day) in prices.items():
        row = known.get(code)
        if row is None and not create_missing:
            continue
        # Written even if unchanged: a steady price was fetched just now, so it is fresh.
        rows[code] = {
            "name": code if row is None else row.name,
            "isin": None,
            "price": price,
            "price_date": day,
        }
    _upsert(db, kind, rows)
    return len(rows)


def _linked_codes(db: Session, kind: str, user_id: int | None = None) -> list[str]:
    query = (
        select(Instrument.source_code)
        .where(Instrument.kind == kind, Instrument.source_code.is_not(None))
        .distinct()
        .order_by(Instrument.source_code)
    )
    if user_id is not None:
        query = query.where(Instrument.user_id == user_id)
    return list(db.scalars(query))


def _refresh_funds(db: Session, fetcher: Fetcher) -> int:
    quotes = parse_navall(fetcher.navall())
    if not quotes:
        raise SourceError("AMFI file format not recognised")
    return _upsert_quotes(db, "mutual_fund", quotes)


Clock = Callable[[], float]


def _yahoo_closes(
    db: Session,
    fetcher: Fetcher,
    deadline: float,
    clock: Clock,
    notes: list[str],
    user_id: int | None = None,
) -> dict[str, tuple[Decimal, date]]:
    closes: dict[str, tuple[Decimal, date]] = {}
    errors: list[str] = []
    symbols = _linked_codes(db, "stock", user_id)
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


def _crypto_prices(db: Session, fetcher: Fetcher, ids: list[str]) -> dict[str, Decimal]:
    """Rupee prices for these CoinGecko ids: CoinDCX's last traded INR price where it lists the
    coin, CoinGecko's global price for the rest (or for all, when CoinDCX is down).

    Indian exchanges trade several percent above the global price (1% TDS, thin INR markets),
    so CoinDCX's price is what a holder there would actually get.
    """
    if not ids:
        return {}
    tickers = dict(
        db.execute(
            select(Instrument.source_code, Instrument.symbol)
            .where(Instrument.kind == "crypto", Instrument.source_code.in_(ids))
            .order_by(Instrument.id)
        ).all()
    )
    try:
        inr = parse_coindcx_ticker(fetcher.coindcx_ticker())
    except SourceError as exc:
        log.warning("CoinDCX prices unavailable, using CoinGecko: %s", exc)
        inr = {}
    prices: dict[str, Decimal] = {}
    for coin_id in ids:
        price = inr.get(f"{(tickers.get(coin_id) or '').upper()}INR")
        if price is not None:
            prices[coin_id] = price
    rest = [c for c in ids if c not in prices]
    if rest:
        prices.update(parse_simple_price(fetcher.simple_price(rest)))
    return prices


def _refresh_crypto(db: Session, fetcher: Fetcher, today: date) -> int:
    prices = _crypto_prices(db, fetcher, _linked_codes(db, "crypto"))
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
        elif all(row.source == "auto" for row in existing):
            # Follow the market price on the newest auto row; overlapping runs can leave extras
            # for a date, which would freeze its price, so they go. Manual rows never get here.
            keep = max(existing, key=lambda row: row.id)
            for extra in existing:
                if extra is not keep:
                    db.delete(extra)
                    written += 1
            if keep.price != code.price:
                keep.price = code.price
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


SYNC_FRESH = timedelta(seconds=60)  # a kind synced this recently is not fetched again
FUNDS_MAX_AGE = timedelta(hours=6)  # AMFI's big file is daily
SYNC_BUDGET_SECONDS = 45


def _newest_update(db: Session, kind: str, user_id: int) -> datetime | None:
    """When the newest of the user's linked codes of `kind` was last fetched."""
    newest = db.scalar(
        select(func.max(MarketCode.updated_at))
        .join(
            Instrument,
            (Instrument.kind == MarketCode.kind) & (Instrument.source_code == MarketCode.code),
        )
        .where(Instrument.user_id == user_id, Instrument.kind == kind)
    )
    if newest is not None and newest.tzinfo is None:  # SQLite hands back naive UTC
        newest = newest.replace(tzinfo=UTC)
    return newest


def _sync_crypto(db: Session, fetcher: Fetcher, today: date, user_id: int) -> int:
    prices = _crypto_prices(db, fetcher, _linked_codes(db, "crypto", user_id))
    return _set_prices(db, "crypto", {c: (p, today) for c, p in prices.items()}, True)


MARKET_CLOSE_IST = clock_time(16, 0)  # NSE closes 15:30; after 16:00 the stored close is final


def _sync_stocks(
    db: Session,
    fetcher: Fetcher,
    user_id: int,
    deadline: float,
    clock: Clock,
    report: RefreshReport,
    now: datetime,
) -> int:
    notes: list[str] = []
    quotes = _yahoo_closes(db, fetcher, deadline, clock, notes, user_id)
    known = _existing(db, "stock")
    now_ist = now.astimezone(IST)

    def acceptable(code: str, day: date) -> bool:
        row = known.get(code)
        if row is None:
            return False
        if row.price_date is None or day > row.price_date:
            return True
        # The same date is the stored price: accept only while that day's market may still be
        # open; after it, the stored one is the official close and a quote must not replace it.
        return day == row.price_date and now_ist < datetime.combine(day, MARKET_CLOSE_IST, IST)

    fresh = {c: q for c, q in quotes.items() if acceptable(c, q[1])}
    count = _set_prices(db, "stock", fresh, create_missing=False)
    # Queried codes count as fetched even when their quote was dropped, so a repeat tap within
    # the minute does not ask Yahoo again.
    dropped = [c for c in quotes if c in known and c not in fresh]
    if dropped:
        db.execute(
            update(MarketCode)
            .where(MarketCode.kind == "stock", MarketCode.code.in_(dropped))
            .values(updated_at=func.now())
        )
    if notes:
        report.failed["stock"] = "; ".join(notes)
    return count


def _sync_funds(db: Session, fetcher: Fetcher, user_id: int) -> int:
    count = _refresh_funds(db, fetcher)
    codes = _linked_codes(db, "mutual_fund", user_id)
    # The file is fetched, even if a NAV did not change: those funds are fresh now.
    db.execute(
        update(MarketCode)
        .where(MarketCode.kind == "mutual_fund", MarketCode.code.in_(codes))
        .values(updated_at=func.now())
    )
    return count


def sync_user_prices(
    db: Session,
    fetcher: Fetcher,
    user_id: int,
    today: date,
    now: datetime,
    clock: Clock = time.monotonic,
) -> RefreshReport:
    """The Sync button: fetch the latest for one user's linked holdings, and write only theirs.

    A kind fetched under a minute ago is skipped (funds: under six hours, as the file is large
    and daily). Stocks use Yahoo's latest quote, which is intraday while the market is open; the
    nightly official close replaces it. Commits each kind. What time ran out on goes in `failed`.
    """
    report = RefreshReport()
    deadline = clock() + SYNC_BUDGET_SECONDS
    for kind in KINDS:
        if not _linked_codes(db, kind, user_id):
            continue
        newest = _newest_update(db, kind, user_id)
        max_age = FUNDS_MAX_AGE if kind == "mutual_fund" else SYNC_FRESH
        if newest is not None and now - newest < max_age:
            # Fresh enough to skip the fetch, but this user may not hold the price yet.
            apply_to_users(db, only_kind=kind, user_id=user_id)
            db.commit()
            continue
        if clock() >= deadline:
            report.failed[kind] = "time ran out before this could be fetched"
            continue
        jobs = {
            "crypto": lambda: _sync_crypto(db, fetcher, today, user_id),
            "stock": lambda: _sync_stocks(db, fetcher, user_id, deadline, clock, report, now),
            "mutual_fund": lambda: _sync_funds(db, fetcher, user_id),
        }
        try:
            with db.begin_nested():
                report.updated[kind] = jobs[kind]()
        except SourceError as exc:
            report.failed[kind] = str(exc)
        except Exception as exc:
            log.exception("price sync of %s crashed", kind)
            report.failed[kind] = f"unexpected {exc.__class__.__name__}"
        apply_to_users(db, only_kind=kind, user_id=user_id)
        db.commit()
    return report
