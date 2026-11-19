"""The nightly corporate-actions step: fetch the feed, store each event once, match it to holders.

Runs after stock prices in `run_nightly`, inside its own time budget. The window fetch (ex-dates
from a week ago to two months ahead) comes from NSE, or from BSE when NSE is down. Then, while
time remains, linked stocks whose history was never fetched are backfilled from NSE one symbol
at a time, back to their first trade. Every failure lands in `report.failed["actions"]`.
"""

import logging
import time
from collections import defaultdict
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import dates
from app.api.portfolio import ActionRow, TradeRow, load_action_rows, load_trade_rows, replay
from app.models.corporate_action import CorporateAction, StockAction, normalise_purpose
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade
from app.models.market import MarketCode
from app.prices.actions_parse import ParsedAction, parse_bse_actions, parse_nse_actions
from app.prices.fetch import Fetcher, SourceError, SourceTimeout

if TYPE_CHECKING:
    from app.prices.refresh import RefreshReport

log = logging.getLogger("app.prices")

ACTIONS_BUDGET_SECONDS = 15
WINDOW_BACK = timedelta(days=7)
WINDOW_AHEAD = timedelta(days=60)
SYMBOL_MAX = 20  # CorporateAction.symbol
PURPOSE_MAX = 300  # CorporateAction.purpose and purpose_key
SHARE_CHANGING = frozenset({"split", "consolidation", "bonus"})
# Hypothetical actions replayed to test a holding; negative so they never clash with real ids.
# The dividend probe sorts first on the ex-date, so it sees the lots before the other one runs.
_PROBE_DIVIDEND, _PROBE_ACTION = -2, -1

Clock = Callable[[], float]


# Storing: one CorporateAction per event, whichever source reported it.
def _isin_to_symbol(db: Session) -> dict[str, str]:
    rows = db.execute(
        select(MarketCode.isin, MarketCode.code).where(
            MarketCode.kind == "stock", MarketCode.isin.is_not(None)
        )
    )
    return {isin: code for isin, code in rows}


def store_actions(db: Session, parsed: Iterable[ParsedAction]) -> list[CorporateAction]:
    """Insert the events not stored yet; return the stored row of every parsed event, once each.

    An event is already stored if a row has the same symbol, kind, ex-date and purpose key (the
    normalised segment of the notice the action came from). NSE and
    BSE word the same event differently, so a row from the other source with the same symbol,
    kind and ex-date (and, for a dividend, the same amount) is the same event too. Flushes.
    """
    items = [p for p in parsed if len(p.symbol) <= SYMBOL_MAX]
    if not items:
        return []
    symbols = {p.symbol for p in items}
    query = select(CorporateAction).where(
        CorporateAction.ex_date >= min(p.ex_date for p in items),
        CorporateAction.ex_date <= max(p.ex_date for p in items),
    )
    if len(symbols) <= 100:  # a backfill: one symbol over years
        query = query.where(CorporateAction.symbol.in_(symbols))
    by_key: dict[tuple[str, str, date, str], CorporateAction] = {}
    by_event: dict[tuple[str, str, date], list[CorporateAction]] = defaultdict(list)

    def remember(row: CorporateAction) -> None:
        by_key[(row.symbol, row.kind, row.ex_date, row.purpose_key)] = row
        by_event[(row.symbol, row.kind, row.ex_date)].append(row)

    for row in db.scalars(query):
        remember(row)

    result: list[CorporateAction] = []
    seen: set[int] = set()  # id() of rows already in `result`
    for p in items:
        purpose = p.purpose[:PURPOSE_MAX]
        # Keyed by the action's own part of the notice, so two dividends in one notice are two.
        key = normalise_purpose(p.segment or p.purpose)[:PURPOSE_MAX]
        row = by_key.get((p.symbol, p.kind, p.ex_date, key))
        if row is None:
            row = next(
                (
                    other
                    for other in by_event[(p.symbol, p.kind, p.ex_date)]
                    if other.source != p.source
                    and (p.kind != "dividend" or other.amount_per_share == p.amount_per_share)
                ),
                None,
            )
        if row is None:
            row = CorporateAction(
                symbol=p.symbol,
                isin=p.isin,
                kind=p.kind,
                ex_date=p.ex_date,
                record_date=p.record_date,
                ratio_new=p.ratio_new,
                ratio_old=p.ratio_old,
                amount_per_share=p.amount_per_share,
                purpose=purpose,
                purpose_key=key,
                source=p.source,
            )
            db.add(row)
            remember(row)
        elif row.record_date is None and p.record_date is not None:
            row.record_date = p.record_date
        if id(row) not in seen:
            seen.add(id(row))
            result.append(row)
    db.flush()
    return result


# Matching: a stock_actions row for each user who held the stock.
def _status(
    trades: list[TradeRow],
    applied: list[ActionRow],
    instrument_id: int,
    action: CorporateAction,
) -> str | None:
    """The new row's status for this holding, or None if it was not held on the ex-date eve.

    Replays trades dated before the ex-date and applied actions before it, plus probes: a
    dividend probe tells whether any lot was entitled (basis before the ex-date), and for a
    split, consolidation or bonus a probe of the action itself tells whether it changes a lot.
    """
    ex = action.ex_date
    probes = [
        ActionRow(
            _PROBE_DIVIDEND, instrument_id, "dividend", ex, None, None, Decimal(1), None, None
        )
    ]
    if action.kind in SHARE_CHANGING:
        probes.append(
            ActionRow(
                _PROBE_ACTION,
                instrument_id,
                action.kind,
                ex,
                action.ratio_new,
                action.ratio_old,
                None,
                None,
                None,
            )
        )
    result = replay(
        [t for t in trades if t.date < ex], [*(a for a in applied if a.ex_date < ex), *probes]
    )
    if action.kind == "dividend":
        entitled = any(key[0] == _PROBE_DIVIDEND for key in result.dividends)
        return "applied" if entitled else None
    held = any(
        pos.quantity > 0 for pos in result.positions.values() if pos.instrument_id == instrument_id
    )
    if not held:
        return None
    if action.kind in SHARE_CHANGING:
        # Every lot was entered after the ex-date, already adjusted: nothing to review.
        return "pending" if _PROBE_ACTION in result.touched else "dismissed"
    return "pending"  # merger and demerger need a target; "other" needs reading


class _UserState:
    """One user's trades, applied actions and existing stock_actions, loaded once."""

    def __init__(self, db: Session, user_id: int) -> None:
        self.trades = load_trade_rows(db, user_id)
        self.applied = load_action_rows(db, user_id)
        self._current: dict[int, Decimal] | None = None
        self.linked: set[tuple[int, int]] = set()  # (instrument, corporate action)
        # Rows with no corporate action (restored from a backup, or entered by hand):
        # (instrument, kind, ex-date) -> their amounts per share.
        self.unlinked: dict[tuple[int, str, date], list[Decimal | None]] = defaultdict(list)
        rows = db.execute(
            select(
                StockAction.instrument_id,
                StockAction.corporate_action_id,
                StockAction.kind,
                StockAction.ex_date,
                StockAction.amount_per_share,
            ).where(StockAction.user_id == user_id)
        )
        for inst, cid, kind, ex, amount in rows:
            self.add(inst, cid, kind, ex, amount)

    def add(self, inst: int, cid: int | None, kind: str, ex: date, amount: Decimal | None) -> None:
        if cid is not None:
            self.linked.add((inst, cid))
        else:
            self.unlinked[(inst, kind, ex)].append(amount)

    def has(self, inst: int, action: CorporateAction) -> bool:
        """A row exists for this event: linked to it, or unlinked (as a restored backup or a
        hand entry leaves it) with the same kind and ex-date, and for a dividend the same
        amount. A row linked to another event never counts, so an interim and a special
        dividend on one day are two rows. Never re-create a dismissed one."""
        if (inst, action.id) in self.linked:
            return True
        return any(
            action.kind != "dividend" or amount == action.amount_per_share
            for amount in self.unlinked[(inst, action.kind, action.ex_date)]
        )

    def holds_now(self, inst: int) -> bool:
        if self._current is None:
            self._current = defaultdict(Decimal)
            for pos in replay(self.trades, self.applied).positions.values():
                self._current[pos.instrument_id] += pos.quantity
        return self._current.get(inst, Decimal(0)) > 0


def match_to_users(db: Session, actions: list[CorporateAction], today: date | None = None) -> int:
    """Create a stock_actions row for each holder of each action; return how many. Flushes.

    A holding is a user's stock instrument linked (`source_code`) to the action's symbol. Past
    and today's ex-dates go by the holding on the ex-date eve; upcoming ones need shares now.
    """
    if not actions:
        return 0
    today = today or dates.today_india()
    holdings: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for inst_id, user_id, code in db.execute(
        select(Instrument.id, Instrument.user_id, Instrument.source_code)
        .where(
            Instrument.kind == "stock",
            Instrument.source_code.in_({a.symbol for a in actions}),
        )
        .order_by(Instrument.id)
    ):
        holdings[code].append((user_id, inst_id))
    users: dict[int, _UserState] = {}
    created = 0
    for action in actions:
        for user_id, inst_id in holdings.get(action.symbol, ()):
            state = users.get(user_id)
            if state is None:
                state = users[user_id] = _UserState(db, user_id)
            if state.has(inst_id, action):
                continue
            if action.ex_date > today and not state.holds_now(inst_id):
                continue
            status = _status(state.trades, state.applied, inst_id, action)
            if status is None:
                continue
            db.add(
                StockAction(
                    user_id=user_id,
                    instrument_id=inst_id,
                    corporate_action_id=action.id,
                    kind=action.kind,
                    ex_date=action.ex_date,
                    ratio_new=action.ratio_new,
                    ratio_old=action.ratio_old,
                    amount_per_share=action.amount_per_share,
                    status=status,
                )
            )
            state.add(inst_id, action.id, action.kind, action.ex_date, action.amount_per_share)
            created += 1
    db.flush()
    return created


# The step itself.
def _window(db: Session, fetcher: Fetcher, today: date) -> tuple[list[ParsedAction], bool]:
    """The window's actions and whether NSE gave them. Raises SourceError if both are down."""
    start, end = today - WINDOW_BACK, today + WINDOW_AHEAD
    try:
        return parse_nse_actions(fetcher.nse_actions(start, end)), True
    except SourceError as nse:
        log.warning("NSE corporate actions unavailable, trying BSE: %s", nse)
        try:
            payload = fetcher.bse_actions(start, end)
        except SourceError as bse:
            raise SourceError(f"NSE: {nse}; BSE: {bse}") from bse
        return parse_bse_actions(payload, _isin_to_symbol(db)), False


def _backfill(
    db: Session,
    fetcher: Fetcher,
    today: date,
    deadline: float,
    clock: Clock,
    notes: list[str],
) -> int:
    """Fetch the history of linked stocks never fetched, oldest instrument first, while time
    remains. A stock with no trades waits: there is no first trade to go back to yet."""
    pending = db.execute(
        select(Instrument.id, Instrument.source_code, func.min(InvestmentTrade.date))
        .join(InvestmentTrade, InvestmentTrade.instrument_id == Instrument.id)
        .where(
            Instrument.kind == "stock",
            Instrument.source_code.is_not(None),
            Instrument.actions_backfilled_at.is_(None),
        )
        .group_by(Instrument.id, Instrument.source_code)
        .order_by(Instrument.id)
    ).all()
    created = 0
    for i, (inst_id, symbol, first_trade) in enumerate(pending):
        if clock() >= deadline:
            log.info("corporate actions backfill: time ran out, %d stock(s) wait", len(pending) - i)
            break
        try:
            payload = fetcher.nse_actions(min(first_trade, today), today, symbol)
        except SourceTimeout as exc:
            notes.append(f"backfill of {symbol} timed out: {exc}")
            break  # NSE hanging on one symbol will hang on the next too
        except SourceError as exc:
            notes.append(f"backfill of {symbol} failed: {exc}")
            continue  # stays queued for tomorrow
        parsed = [p for p in parse_nse_actions(payload) if p.symbol == symbol]
        created += match_to_users(db, store_actions(db, parsed), today)
        inst = db.get(Instrument, inst_id)
        if inst is not None:
            inst.actions_backfilled_at = datetime.now(UTC)
    return created


def refresh_actions(
    db: Session,
    fetcher: Fetcher,
    today: date,
    report: "RefreshReport",
    clock: Clock = time.monotonic,
) -> None:
    """Fetch, store and match corporate actions, then backfill. Flushes; the caller commits.

    Source failures go in `report.failed["actions"]`; the count of new stock_actions rows in
    `report.updated["actions"]`.
    """
    deadline = clock() + ACTIONS_BUDGET_SECONDS
    try:
        parsed, from_nse = _window(db, fetcher, today)
    except SourceError as exc:
        report.failed["actions"] = str(exc)
        return
    created = match_to_users(db, store_actions(db, parsed), today)
    notes: list[str] = []
    if from_nse:  # the backfill is NSE only; with NSE down it waits for another night
        created += _backfill(db, fetcher, today, deadline, clock, notes)
    report.updated["actions"] = created
    if notes:
        report.failed["actions"] = "; ".join(notes)


# Renames and the safety net for actions the feeds missed.
def follow_renames(db: Session, listed: set[str] | None = None) -> int:
    """Point linked stocks at their new NSE symbol after a rename; return how many moved.

    market_codes rows are never deleted, so an old symbol lingers after a rename. `listed` is
    tonight's equity-list code set: OLDSYM is "gone" when it is not in it (without `listed`,
    when it has no market_codes row). The ISIN comes from OLDSYM's market_codes row, else its
    stored corporate action. It moves only if exactly one other listed code carries that ISIN.
    `Instrument.symbol` is never touched.
    """
    codes = {
        c: isin
        for c, isin in db.execute(
            select(MarketCode.code, MarketCode.isin).where(MarketCode.kind == "stock")
        )
    }
    by_isin: dict[str, list[str]] = defaultdict(list)
    for code, isin in codes.items():
        if isin and (listed is None or code in listed):
            by_isin[isin].append(code)
    moved = 0
    insts = db.scalars(
        select(Instrument).where(Instrument.kind == "stock", Instrument.source_code.is_not(None))
    ).all()
    for inst in insts:
        old = inst.source_code
        if old is None:
            continue
        gone = old not in listed if listed is not None else old not in codes
        if not gone:
            continue
        isin = codes.get(old) or db.scalar(
            select(CorporateAction.isin)
            .where(CorporateAction.symbol == old, CorporateAction.isin.is_not(None))
            .limit(1)
        )
        if not isin:
            continue
        new = [c for c in by_isin.get(isin, ()) if c != old]
        if len(new) == 1:
            inst.source_code = new[0]
            moved += 1
    db.flush()
    return moved


DROP_THRESHOLD = Decimal("0.35")  # a close more than 35% below the previous one
DROP_WINDOW = timedelta(days=3)
RECENT_DROP = timedelta(days=5)  # only a fresh drop is news; an old one was seen or dismissed
KNOWN_KINDS = ("split", "consolidation", "bonus", "merger", "demerger")


def _known_action_near(db: Session, inst_id: int, day: date) -> bool:
    return (
        db.scalar(
            select(StockAction.id)
            .where(
                StockAction.instrument_id == inst_id,
                StockAction.kind.in_(KNOWN_KINDS),
                StockAction.status != "dismissed",
                StockAction.ex_date >= day - DROP_WINDOW,
                StockAction.ex_date <= day + DROP_WINDOW,
            )
            .limit(1)
        )
        is not None
    )


def flag_suspect_drops(db: Session, today: date) -> int:
    """Flag held stocks whose latest close fell over 35% with no known action within 3 days.

    Day-on-day is the instrument's two most recent price dates. Sets `suspect_drop_on`; returns
    how many were newly flagged. Flags that now have a known action nearby are cleared.
    Flushes; the caller commits.
    """
    for inst in db.scalars(
        select(Instrument).where(
            Instrument.kind == "stock", Instrument.suspect_drop_on.is_not(None)
        )
    ):
        if inst.suspect_drop_on and _known_action_near(db, inst.id, inst.suspect_drop_on):
            inst.suspect_drop_on = None
    flagged = 0
    for user_id in db.scalars(
        select(Instrument.user_id).where(Instrument.kind == "stock").distinct()
    ):
        state = _UserState(db, user_id)
        for inst in db.scalars(
            select(Instrument).where(
                Instrument.user_id == user_id,
                Instrument.kind == "stock",
                Instrument.suspect_drop_on.is_(None),
            )
        ):
            if not state.holds_now(inst.id):
                continue
            rows = db.execute(
                select(InstrumentPrice.date, InstrumentPrice.price)
                .where(InstrumentPrice.instrument_id == inst.id)
                .order_by(InstrumentPrice.date.desc(), InstrumentPrice.id.desc())
            ).all()
            latest: dict[date, Decimal] = {}
            for day, price in rows:
                latest.setdefault(day, price)
                if len(latest) == 2:
                    break
            if len(latest) < 2:
                continue
            (day, close), (_, prev) = latest.items()
            if day < today - RECENT_DROP or prev <= 0 or close >= prev * (1 - DROP_THRESHOLD):
                continue
            if _known_action_near(db, inst.id, day):
                continue
            inst.suspect_drop_on = day
            flagged += 1
    db.flush()
    return flagged
