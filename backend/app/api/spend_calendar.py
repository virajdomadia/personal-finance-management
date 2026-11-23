"""The spend calendar: a month's fixed income and outgoings, the daily amount left after them,
and what was spent each day against it. Rules: docs/architecture/financial-calculations.md,
"Spend calendar".

Pure functions over plain rows, so the arithmetic is tested without a database.
"""

from collections.abc import Iterable
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import NamedTuple

from app.api.cash_flow import ZERO, Row, last_day, spent
from app.api.recurring import TemplateRow, occurrences, open_occurrences

CENT = Decimal("0.01")


class Fixed(NamedTuple):
    """A monthly reminder or SIP: money that comes in or goes out every month."""

    name: str
    kind: str  # "income" or "out"
    amount: Decimal
    day: int
    start_date: date
    end_date: date | None
    active: bool
    # A stopped item still counts up to the month of its last payment, so stopping one never
    # rewrites the months it was paid in.
    last_paid: date | None = None


class Allowance(NamedTuple):
    income: Decimal
    fixed_out: Decimal
    free: Decimal
    per_day: Decimal | None  # None when no fixed income counts this month


class CalendarDay(NamedTuple):
    date: date
    spent: Decimal | None  # None for a day after `through`
    over: bool | None  # None after `through`, or when there's no daily amount


def counts_in(item: Fixed, first: date) -> bool:
    """Whether an item counts for the month starting `first`: it overlaps the month and is
    active, or was stopped after a payment in that month or later."""
    end = date(first.year, first.month, last_day(first.year, first.month))
    if item.start_date > end or (item.end_date is not None and item.end_date < first):
        return False
    return item.active or (item.last_paid is not None and item.last_paid >= first)


def allowance(items: Iterable[Fixed], first: date) -> Allowance:
    counted = [i for i in items if counts_in(i, first)]
    income = sum((i.amount for i in counted if i.kind == "income"), ZERO)
    fixed_out = sum((i.amount for i in counted if i.kind != "income"), ZERO)
    free = income - fixed_out
    has_income = any(i.kind == "income" for i in counted)
    per_day = (
        (free / last_day(first.year, first.month)).quantize(CENT, ROUND_HALF_UP)
        if has_income
        else None
    )
    return Allowance(income, fixed_out, free, per_day)


def _over(amount: Decimal, per_day: Decimal | None) -> bool | None:
    if per_day is None:
        return None
    # With nothing free, any spending is over; a day with none is still fine.
    return amount > 0 if per_day < 0 else amount > per_day


def calendar_days(
    rows: Iterable[Row], first: date, through: date, per_day: Decimal | None
) -> list[CalendarDay]:
    by_day: dict[date, Decimal] = {}
    for r in rows:
        by_day[r.date] = by_day.get(r.date, ZERO) + spent(r)
    result: list[CalendarDay] = []
    for d in range(1, last_day(first.year, first.month) + 1):
        day = date(first.year, first.month, d)
        if day > through:
            result.append(CalendarDay(day, None, None))
            continue
        amount = by_day.get(day, ZERO)
        result.append(CalendarDay(day, amount, _over(amount, per_day)))
    return result


def pace(per_day: Decimal | None, through: date, first: date, spent: Decimal) -> Decimal | None:
    """How far under (positive) or over (negative) the daily amount the month is so far."""
    if per_day is None:
        return None
    return (per_day * ((through - first).days + 1) - spent).quantize(CENT, ROUND_HALF_UP)


def month_marks(
    row: TemplateRow, paid: list[date], skips: set[date], first: date, today: date
) -> list[tuple[date, str]]:
    """A reminder's occurrences in the month and where each stands: "paid", "skipped", "due"
    (on or before today and still owed) or "coming". For an active reminder."""
    end = date(first.year, first.month, last_day(first.year, first.month))
    open_ = set(open_occurrences(row, paid, skips, end))
    marks: list[tuple[date, str]] = []
    for o in occurrences(row, end):
        if o < first:
            continue
        if o in skips:
            state = "skipped"
        elif o not in open_:
            state = "paid"
        else:
            state = "due" if o <= today else "coming"
        marks.append((o, state))
    return marks
