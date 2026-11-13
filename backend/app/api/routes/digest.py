"""The weekly digest. Rules: docs/architecture/financial-calculations.md, "Weekly digest".

Spending uses the month report's rows and rules (`app.api.cash_flow`), budgets the budgets page's
lines (`MonthBook`), and what's due the `/upcoming` list, so all three always agree."""

from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api import cash_flow as cf
from app.api import digest as dg
from app.api.dates import now_india
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import fmt
from app.api.routes.budgets import MonthBook, month_rows, month_text
from app.api.routes.cash_flow import TOP, CategorySlice, Change, _slice
from app.api.routes.upcoming import UpcomingItem, upcoming_items
from app.db.session import DbSession
from app.models.transaction import Transaction

router = APIRouter(prefix="/digest", tags=["digest"], dependencies=[Depends(get_current_user)])

DUE_DAYS = 7
WEEK_PATTERN = r"^(current|[1-9][0-9]{3}-[0-9]{2}-[0-9]{2})$"


class AtRisk(BaseModel):
    category_id: int
    name: str
    icon: str | None
    colour: str | None
    amount: str
    spent: str
    percent: int | None
    bar: int | None
    status: Literal["over", "on_pace"]
    over_by: str
    projected: str  # the month's spending at the pace so far


class BudgetsAtRisk(BaseModel):
    month: str  # the month holding the week's last counted day
    through: str
    days: int  # days of the month counted
    days_in_month: int
    elapsed_percent: int
    at_risk: list[AtRisk]


class DueSoon(BaseModel):
    start: str
    through: str
    total: str  # the items with money going out
    items: list[UpcomingItem]


class Digest(BaseModel):
    user_id: int
    week_start: str
    week_end: str
    through: str
    is_current: bool
    is_complete: bool
    label: str  # "this week" | "last week" | "the week of 26 October"
    spending: str
    usual: str | None  # None with no earlier week to compare with
    usual_weeks: int
    change: Change | None
    tone: Literal["more", "less", "same"] | None  # spent against usual, ±5% exactly; None: no usual
    top_spending: list[CategorySlice]
    budgets: BudgetsAtRisk
    due: DueSoon
    headline: str


def _week_error(message: str) -> RequestValidationError:
    return RequestValidationError(
        [{"loc": ("query", "week"), "msg": message, "type": "value_error"}]
    )


def _chosen(week: str | None, now_today: date, default: date) -> date:
    if week is None:
        return default
    if week == "current":
        return dg.monday(now_today)
    try:
        # The pattern keeps the year at 1000 or later, so the Monday and the 4 weeks before it
        # can't fall before year 1.
        start = dg.monday(date.fromisoformat(week))
    except (ValueError, OverflowError):
        raise _week_error("Enter a date, like 2026-01-15, or current.") from None
    if start > now_today:
        raise _week_error("That week hasn't started yet.")
    return start


def _budgets(book: MonthBook) -> BudgetsAtRisk:
    first = book.first
    days_in_month = cf.last_day(first.year, first.month)
    days = (book.through - book.start).days + 1
    found: list[AtRisk] = []
    for line in book.lines:
        if not line.active:
            continue
        status = (
            "over"
            if line.over
            else "on_pace"
            if dg.on_pace(line.spent, line.amount, days, days_in_month)
            else None
        )
        if status is None:
            continue
        found.append(
            AtRisk(
                category_id=line.category.id,
                name=line.category.name,
                icon=line.category.icon,
                colour=line.category.colour,
                amount=fmt(line.amount),
                spent=fmt(line.spent),
                percent=line.percent,
                bar=line.bar,
                status=status,
                over_by=fmt(line.over_by),
                projected=fmt(dg.projected(line.spent, days, days_in_month)),
            )
        )
    found.sort(key=lambda r: (r.status != "over", -(r.percent or 0), r.name.casefold()))
    return BudgetsAtRisk(
        month=month_text(first),
        through=book.through.isoformat(),
        days=days,
        days_in_month=days_in_month,
        elapsed_percent=cf.percent(Decimal(days), Decimal(days_in_month)) or 0,
        at_risk=found,
    )


@router.get("")
def weekly_digest(
    user: CurrentUser,
    db: DbSession,
    week: Annotated[str | None, Query(pattern=WEEK_PATTERN)] = None,
) -> Digest:
    """A week's spending against the usual, its top categories, budgets at risk and what's due in
    the next 7 days, with a one-line headline. Default: the last whole Monday–Sunday week."""
    now = now_india()
    today = now.date()
    chosen = dg.week_of(_chosen(week, today, dg.default_week(now)), today)

    earliest = db.scalar(select(func.min(Transaction.date)).where(Transaction.user_id == user.id))
    before = dg.earlier(chosen, earliest)
    first_day = before[-1].start if before else chosen.start
    rows = month_rows(db, user.id, first_day, chosen.through)

    def within(w: dg.Week) -> list[cf.Row]:
        return [r for r in rows if w.start <= r.date <= w.through]

    this = within(chosen)
    spending = cf.totals(this).spending
    usual = dg.average([cf.totals(within(w)).spending for w in before])
    change = None
    if usual is not None:
        difference = spending - usual
        change = Change(amount=fmt(difference), percent=cf.percent(difference, usual))

    through = chosen.through
    book = MonthBook(db, user.id, date(through.year, through.month, 1), through)
    groups = cf.grouped(this, "expense", book.categories)
    db.commit()  # a first read seeds the default categories

    start_due, until = today, today + timedelta(days=DUE_DAYS)
    _, items = upcoming_items(db, user.id, start_due, until)
    total_due = sum((Decimal(i.amount) for i in items if i.direction == "out"), cf.ZERO)
    week_label = dg.label(chosen.start, today)
    return Digest(
        user_id=user.id,
        week_start=chosen.start.isoformat(),
        week_end=chosen.end.isoformat(),
        through=chosen.through.isoformat(),
        is_current=chosen.start == dg.monday(today),
        is_complete=chosen.complete,
        label=week_label,
        spending=fmt(spending),
        usual=None if usual is None else fmt(usual),
        usual_weeks=len(before),
        change=change,
        tone=dg.tone(spending, usual),  # type: ignore[arg-type]
        top_spending=[_slice(g, spending, children=False) for g in groups[:TOP]],
        budgets=_budgets(book),
        due=DueSoon(
            start=start_due.isoformat(),
            through=until.isoformat(),
            total=fmt(total_due),
            items=items,
        ),
        headline=dg.headline(spending, usual, week_label, so_far=not chosen.complete),
    )
