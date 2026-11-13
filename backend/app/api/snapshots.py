"""Net worth snapshots: today's figures stored for later, and estimated month-ends from history.

The rules are in docs/architecture/financial-calculations.md, "Net worth over time".
"""

import calendar
import logging
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import NamedTuple

from sqlalchemy import exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.api.balances import balance_of, load_dated_movements, net_flows
from app.api.dates import INDIA, clamped_date
from app.api.routes.accounts import DEPOSIT_TYPES, totals
from app.api.worth import GROUPS, worth_of
from app.models.account import Account
from app.models.investment import Instrument
from app.models.snapshot import NetWorthSnapshot
from app.models.user import User

log = logging.getLogger("app.snapshots")

BACKFILL_MONTHS = 12
# How far from the same day last month a snapshot may be and still compare: up to 16 days
# before it, or 3 after. Within 3 days either side it counts as on the day.
NEAREST_BEFORE = 16
NEAREST_AFTER = 3
ON_TARGET_DAYS = 3
INVESTMENT_GROUPS = ("stocks", "funds", "crypto")
PAISE = Decimal("0.01")
# The nightly run is scheduled for 23:30 India time but can start as late as 00:29. Its snapshot
# belongs to the evening it was meant for, so the date is taken this long before the run.
EVENING_SHIFT = timedelta(hours=3)


class Figures(NamedTuple):
    net_worth: Decimal
    total_have: Decimal
    total_owe: Decimal
    split: dict[str, Decimal]  # every group in GROUPS

    def without_investments(self) -> Decimal:
        """Net worth less stocks, funds and coins: what an estimated month-end can compare with."""
        return self.net_worth - sum((self.split[g] for g in INVESTMENT_GROUPS), Decimal(0))


def rounded(have: Decimal, owe: Decimal, split: dict[str, Decimal]) -> Figures:
    """Figures rounded to paise so they add up exactly as stored: have and owe first, net worth
    from those, and bank and cash as what is left of have after the other groups."""
    have, owe = have.quantize(PAISE), owe.quantize(PAISE)
    parts = {g: split[g].quantize(PAISE) for g in GROUPS if g != "bank_cash"}
    bank_cash = have - sum(parts.values(), Decimal(0))
    return Figures(have - owe, have, owe, {"bank_cash": bank_cash, **parts})


def snapshot_date(now: datetime) -> date:
    """The India date of the evening a nightly run belongs to, even one starting after midnight."""
    return (now.astimezone(INDIA) - EVENING_SHIFT).date()


def has_anything(db: Session, user_id: int) -> bool:
    """Whether the user has an account (archived or not) or an instrument to count."""
    return bool(
        db.scalar(
            select(
                or_(
                    exists().where(Account.user_id == user_id),
                    exists().where(Instrument.user_id == user_id),
                )
            )
        )
    )


def current_figures(db: Session, user_id: int, today: date) -> Figures | None:
    """The dashboard's figures now, or None for a user with nothing to count."""
    if not has_anything(db, user_id):
        return None
    active = list(
        db.scalars(
            select(Account).where(Account.user_id == user_id, Account.archived_at.is_(None))
        ).all()
    )
    worth = worth_of(db, user_id, active, today)
    return rounded(worth.have, worth.owe, worth.split)


def _row(user_id: int, day: date, figures: Figures, estimated: bool) -> dict:
    return {
        "user_id": user_id,
        "date": day,
        "net_worth": figures.net_worth,
        "total_have": figures.total_have,
        "total_owe": figures.total_owe,
        **{group: figures.split[group] for group in GROUPS},
        "estimated": estimated,
    }


def _upsert(db: Session, rows: list[dict], *, replace_real: bool) -> None:
    """Write rows, one per (user, date). An existing real snapshot is replaced only when
    `replace_real`; an existing estimated one always is."""
    if not rows:
        return
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    stmt = insert(NetWorthSnapshot).values(rows)
    changed = {
        name: stmt.excluded[name]
        for name in ("net_worth", "total_have", "total_owe", *GROUPS, "estimated")
    }
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id", "date"],
        set_={**changed, "updated_at": func.now()},
        where=None if replace_real else NetWorthSnapshot.estimated.is_(True),
    )
    db.execute(stmt)


def write_snapshot(db: Session, user_id: int, today: date) -> bool:
    """Store today's figures as the user's real snapshot, replacing any for today.

    False (and nothing written) for a user with nothing to count. The caller commits.
    """
    figures = current_figures(db, user_id, today)
    if figures is None:
        return False
    _upsert(db, [_row(user_id, today, figures, False)], replace_real=True)
    return True


def ensure_today(db: Session, user_id: int, today: date, figures: Figures) -> None:
    """Write today's real snapshot if there isn't one yet, so a new user has a first point.
    The nightly run replaces it with that night's figures."""
    real = db.scalar(
        select(NetWorthSnapshot.id).where(
            NetWorthSnapshot.user_id == user_id,
            NetWorthSnapshot.date == today,
            NetWorthSnapshot.estimated.is_(False),
        )
    )
    if real is None:
        _upsert(db, [_row(user_id, today, figures, False)], replace_real=False)
        db.commit()


def snapshot_all(db: Session, today: date) -> int:
    """Today's snapshot for every user with something to count, each committed on its own.

    A user whose snapshot fails is logged and skipped. Returns how many were written.
    """
    written = 0
    for user_id in db.scalars(select(User.id).order_by(User.id)).all():
        try:
            if write_snapshot(db, user_id, today):
                db.commit()
                written += 1
        except Exception:
            db.rollback()
            log.exception("net worth snapshot failed for user %s", user_id)
    log.info("net worth snapshots: written=%d", written)
    return written


def months_back(day: date, months: int) -> date:
    """The same day `months` earlier, clamped to that month's length."""
    year, month = divmod(day.year * 12 + day.month - 1 - months, 12)
    return clamped_date(year, month + 1, day.day)


def month_ends(today: date, months: int) -> list[date]:
    """The last day of each of the `months` months before today's month, oldest first."""
    ends = []
    for back in range(months, 0, -1):
        year, month = divmod(today.year * 12 + today.month - 1 - back, 12)
        ends.append(date(year, month + 1, calendar.monthrange(year, month + 1)[1]))
    return ends


def india_date(moment: datetime) -> date:
    if moment.tzinfo is None:  # SQLite hands back naive UTC
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(INDIA).date()


def first_real_date(db: Session, user_id: int) -> date | None:
    return db.scalar(
        select(func.min(NetWorthSnapshot.date)).where(
            NetWorthSnapshot.user_id == user_id, NetWorthSnapshot.estimated.is_(False)
        )
    )


def estimate_month_ends(
    db: Session, user_id: int, today: date, months: int = BACKFILL_MONTHS
) -> dict[date, Figures]:
    """Estimated figures for each month-end before the first real snapshot, from transactions
    and trade cash only: investments count as zero. A month-end with no account is left out."""
    first_real = first_real_date(db, user_id)
    ends = [d for d in month_ends(today, months) if first_real is None or d < first_real]
    if not ends:
        return {}
    accounts = list(db.scalars(select(Account).where(Account.user_id == user_id)).all())
    moves = load_dated_movements(db, user_id)

    # An account counts from its first movement or the day it was added, whichever is earlier.
    starts = {a.id: india_date(a.created_at) for a in accounts}
    for day, move in moves:
        for account_id in (move.account_id, move.to_account_id):
            if account_id in starts and day < starts[account_id]:
                starts[account_id] = day

    estimates: dict[date, Figures] = {}
    for end in ends:
        counted = [
            a
            for a in accounts
            if starts[a.id] <= end and (a.archived_at is None or india_date(a.archived_at) > end)
        ]
        if not counted:
            continue
        flows = net_flows(move for day, move in moves if day <= end)
        have, owe = totals(counted, flows)
        deposits = sum(
            (balance_of(a, flows) for a in counted if a.type in DEPOSIT_TYPES), Decimal(0)
        )
        split = dict.fromkeys(GROUPS, Decimal(0))
        split["deposits"] = deposits
        estimates[end] = rounded(have, owe, split)
    return estimates


def backfill(db: Session, user_id: int, today: date, months: int = BACKFILL_MONTHS) -> int:
    """Write the estimated month-ends, never replacing a real snapshot. Returns how many."""
    estimates = estimate_month_ends(db, user_id, today, months)
    _upsert(
        db,
        [_row(user_id, day, figures, True) for day, figures in estimates.items()],
        replace_real=False,
    )
    db.commit()
    return len(estimates)
