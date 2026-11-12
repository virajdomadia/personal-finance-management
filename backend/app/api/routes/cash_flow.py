from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api import cash_flow as cf
from app.api.categories import all_categories
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import fmt
from app.db.session import DbSession
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/cash-flow", tags=["cash flow"], dependencies=[Depends(get_current_user)]
)

TOP = 3


class Change(BaseModel):
    amount: str  # signed: this month − the month before at the same day
    percent: int | None  # signed; None when the month before was 0


class Period(BaseModel):
    month: str  # "YYYY-MM"
    start: str
    through: str  # the last day counted
    income: str
    spending: str
    net: str


class CategorySlice(BaseModel):
    id: int | None  # None for "Uncategorised"
    name: str
    icon: str | None
    colour: str | None
    amount: str
    percent: int  # of the kind's total, rounded half up
    direct: str  # in the category itself, not a subcategory
    children: list["CategorySlice"]


class DaySpend(BaseModel):
    date: str
    spent: str | None  # None for a day after today
    height: int | None  # percent of the month's biggest day, for the bar


class CashFlowMonth(BaseModel):
    month: str
    is_current: bool
    start: str
    through: str
    income: str
    spending: str
    net: str
    # The month before, from its 1st to the same day of the month.
    previous: Period
    income_change: Change
    spending_change: Change
    net_change: Change
    spending_by_category: list[CategorySlice]
    income_by_category: list[CategorySlice]
    # The three biggest spending groups (without their subcategories).
    top_spending: list[CategorySlice]
    daily: list[DaySpend]
    transaction_count: int
    # For month navigation: None when nothing is recorded before, or it would be the future.
    earliest_month: str | None
    previous_month: str | None
    next_month: str | None


def _month(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _change(now: Decimal, before: Decimal) -> Change:
    difference = now - before
    return Change(amount=fmt(difference), percent=cf.percent(difference, abs(before)))


def _slice(group: cf.Group, total: Decimal, children: bool = True) -> CategorySlice:
    return CategorySlice(
        id=group.id,
        name=group.name,
        icon=group.icon,
        colour=group.colour,
        amount=fmt(group.amount),
        percent=cf.percent(group.amount, total) or 0,
        direct=fmt(group.direct),
        children=[_slice(c, total) for c in group.children] if children else [],
    )


def _future() -> RequestValidationError:
    return RequestValidationError(
        [
            {
                "loc": ("query", "month"),
                "msg": "That month hasn't started yet.",
                "type": "value_error",
            }
        ]
    )


@router.get("")
def month_summary(
    user: CurrentUser,
    db: DbSession,
    month: Annotated[str | None, Query(pattern=r"^[1-9][0-9]{3}-(0[1-9]|1[0-2])$")] = None,
) -> CashFlowMonth:
    """Income, spending and net for a month (default: this one), against the month before at
    the same day. Rules: docs/architecture/financial-calculations.md, "Monthly cash flow"."""
    today = today_india()
    this_month = date(today.year, today.month, 1)
    first = this_month if month is None else date(int(month[:4]), int(month[5:]), 1)
    if first > today:
        raise _future()
    start, through, before_start, before_through = cf.windows(first, today)
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
                Transaction.type.in_(("income", "expense", "emi")),
                Transaction.date >= before_start,
                Transaction.date <= through,
            )
        )
    ]
    this = [r for r in rows if start <= r.date <= through]
    before = [r for r in rows if before_start <= r.date <= before_through]
    now, then = cf.totals(this), cf.totals(before)

    categories = all_categories(db, user.id)
    spending = cf.grouped(this, "expense", categories)
    income = cf.grouped(this, "income", categories)
    count = db.scalar(
        select(func.count())
        .select_from(Transaction)
        .where(
            Transaction.user_id == user.id,
            Transaction.date >= start,
            Transaction.date <= through,
        )
    )
    earliest = db.scalar(select(func.min(Transaction.date)).where(Transaction.user_id == user.id))
    db.commit()  # a first read seeds the default categories
    earliest_first = None if earliest is None else date(earliest.year, earliest.month, 1)
    prev, nxt = cf.previous_month(first), cf.next_month(first)

    return CashFlowMonth(
        month=_month(first),
        is_current=first == this_month,
        start=start.isoformat(),
        through=through.isoformat(),
        income=fmt(now.income),
        spending=fmt(now.spending),
        net=fmt(now.net),
        previous=Period(
            month=_month(before_start),
            start=before_start.isoformat(),
            through=before_through.isoformat(),
            income=fmt(then.income),
            spending=fmt(then.spending),
            net=fmt(then.net),
        ),
        income_change=_change(now.income, then.income),
        spending_change=_change(now.spending, then.spending),
        net_change=_change(now.net, then.net),
        spending_by_category=[_slice(g, now.spending) for g in spending],
        income_by_category=[_slice(g, now.income) for g in income],
        top_spending=[_slice(g, now.spending, children=False) for g in spending[:TOP]],
        daily=[
            DaySpend(
                date=d.date.isoformat(),
                spent=None if d.spent is None else fmt(d.spent),
                height=d.height,
            )
            for d in cf.daily(this, start, through)
        ],
        transaction_count=count or 0,
        earliest_month=None if earliest_first is None else _month(earliest_first),
        previous_month=(
            _month(prev) if earliest_first is not None and prev >= earliest_first else None
        ),
        next_month=None if nxt > today else _month(nxt),
    )
