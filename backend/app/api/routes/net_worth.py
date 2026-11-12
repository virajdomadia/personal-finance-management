"""Net worth over time: the stored snapshots for a range, today's live point, and the changes.

The rules are in docs/architecture/financial-calculations.md, "Net worth over time".
"""

from datetime import date
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import fmt
from app.api.snapshots import NEAREST_DAYS, Figures, current_figures, ensure_today, months_back
from app.api.worth import GROUPS
from app.db.session import DbSession
from app.models.snapshot import NetWorthSnapshot

router = APIRouter(
    prefix="/net-worth", tags=["net worth"], dependencies=[Depends(get_current_user)]
)

Range = Literal["3m", "6m", "1y", "all"]
RANGE_MONTHS: dict[str, int | None] = {"3m": 3, "6m": 6, "1y": 12, "all": None}


class Allocation(BaseModel):
    bank_cash: str
    deposits: str
    stocks: str
    funds: str
    crypto: str


class Point(BaseModel):
    date: str
    net_worth: str
    total_have: str
    total_owe: str
    allocation: Allocation
    estimated: bool


class Change(BaseModel):
    amount: str  # today's net worth minus the one on `from_date`; signed
    from_date: str


class NetWorthHistory(BaseModel):
    range: Range
    today: str
    points: list[Point]  # oldest first; the last is today, worked out now
    since_last_month: Change | None
    since_start: Change | None
    tracked_since: str | None  # the first real snapshot; points before it are estimated


def _point(day: date, figures: Figures, estimated: bool) -> Point:
    return Point(
        date=day.isoformat(),
        net_worth=fmt(figures.net_worth),
        total_have=fmt(figures.total_have),
        total_owe=fmt(figures.total_owe),
        allocation=Allocation(**{g: fmt(figures.split[g]) for g in GROUPS}),
        estimated=estimated,
    )


def _figures(row: NetWorthSnapshot) -> Figures:
    return Figures(
        row.net_worth,
        row.total_have,
        row.total_owe,
        {g: getattr(row, g) for g in GROUPS},
    )


def _change(now: Decimal, row: NetWorthSnapshot | None) -> Change | None:
    if row is None:
        return None
    return Change(amount=fmt(now - row.net_worth), from_date=row.date.isoformat())


def nearest(rows: list[NetWorthSnapshot], target: date) -> NetWorthSnapshot | None:
    """The snapshot closest to `target` within NEAREST_DAYS; the earlier one on a tie."""
    close = [r for r in rows if abs((r.date - target).days) <= NEAREST_DAYS]
    return min(close, key=lambda r: (abs((r.date - target).days), r.date), default=None)


@router.get("")
def get_history(
    user: CurrentUser, db: DbSession, range_: Annotated[Range, Query(alias="range")] = "1y"
) -> NetWorthHistory:
    today = today_india()
    now = current_figures(db, user.id, today)
    if now is None:
        return NetWorthHistory(
            range=range_,
            today=today.isoformat(),
            points=[],
            since_last_month=None,
            since_start=None,
            tracked_since=None,
        )
    ensure_today(db, user.id, today, now)

    rows = list(
        db.scalars(
            select(NetWorthSnapshot)
            .where(NetWorthSnapshot.user_id == user.id)
            .order_by(NetWorthSnapshot.date)
        ).all()
    )
    past = [r for r in rows if r.date < today]
    months = RANGE_MONTHS[range_]
    start = None if months is None else months_back(today, months)
    shown = [r for r in past if start is None or r.date >= start]
    tracked = next((r.date for r in rows if not r.estimated), None)

    return NetWorthHistory(
        range=range_,
        today=today.isoformat(),
        points=[_point(r.date, _figures(r), r.estimated) for r in shown]
        + [_point(today, now, False)],
        since_last_month=_change(now.net_worth, nearest(past, months_back(today, 1))),
        since_start=_change(now.net_worth, shown[0] if shown else None),
        tracked_since=None if tracked is None else tracked.isoformat(),
    )
