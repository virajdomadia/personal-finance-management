from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api import cash_flow as cf
from app.api import spend_calendar as sc
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import fmt
from app.api.routes.cash_flow import _future, _month
from app.db.session import DbSession
from app.models.transaction import Transaction

router = APIRouter(prefix="/calendar", tags=["calendar"], dependencies=[Depends(get_current_user)])


class CalendarDayOut(BaseModel):
    date: str
    net: str | None  # spent − received; negative when more came in. None after today


class SpendCalendar(BaseModel):
    month: str  # "YYYY-MM"
    is_current: bool
    through: str  # the last day counted
    days: list[CalendarDayOut]
    previous_month: str | None
    next_month: str | None


@router.get("")
def spend_calendar(
    user: CurrentUser,
    db: DbSession,
    month: Annotated[str | None, Query(pattern=r"^[1-9][0-9]{3}-(0[1-9]|1[0-2])$")] = None,
) -> SpendCalendar:
    """Each day's money spent less money received. Rules:
    docs/architecture/financial-calculations.md, "Spend calendar"."""
    today = today_india()
    this_month = date(today.year, today.month, 1)
    first = this_month if month is None else date(int(month[:4]), int(month[5:]), 1)
    if first > today:
        raise _future()
    end = date(first.year, first.month, cf.last_day(first.year, first.month))
    through = min(end, today)

    rows = [
        cf.Row(*r)
        for r in db.execute(
            select(
                Transaction.type,
                Transaction.amount,
                Transaction.interest,
                Transaction.category,
                Transaction.date,
            ).where(
                Transaction.user_id == user.id,
                Transaction.type.in_(sc.CALENDAR_TYPES),
                Transaction.date >= first,
                Transaction.date <= through,
            )
        )
    ]
    days = sc.calendar_days(rows, first, through)

    earliest = db.scalar(select(func.min(Transaction.date)).where(Transaction.user_id == user.id))
    earliest_first = None if earliest is None else date(earliest.year, earliest.month, 1)
    prev, nxt = cf.previous_month(first), cf.next_month(first)
    return SpendCalendar(
        month=_month(first),
        is_current=first == this_month,
        through=through.isoformat(),
        days=[
            CalendarDayOut(date=d.date.isoformat(), net=None if d.net is None else fmt(d.net))
            for d in days
        ],
        previous_month=(
            _month(prev) if earliest_first is not None and prev >= earliest_first else None
        ),
        next_month=None if nxt > today else _month(nxt),
    )
