"""Goal maths: pure functions, no database."""

from datetime import date
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import NamedTuple

from app.api.dates import clamped_date
from app.api.portfolio import round_paise

Month = tuple[int, int]  # (year, month)

WINDOW_MONTHS = 6
WHOLE = Decimal(1)


class ExpenseFigure(NamedTuple):
    amount: Decimal | None  # None: no fully recorded month yet
    months: list[Month]  # the months averaged, oldest first


def _index(year: int, month: int) -> int:
    return year * 12 + month - 1


def _month(index: int) -> Month:
    return index // 12, index % 12 + 1


def expense_window(first_tx: date | None, today: date) -> list[Month]:
    """The last 6 calendar months before today's month that were fully recorded."""
    if first_tx is None:
        return []
    this = _index(today.year, today.month)
    first = _index(first_tx.year, first_tx.month)
    if first_tx.day != 1:
        first += 1
    start = max(this - WINDOW_MONTHS, first)
    return [_month(i) for i in range(start, this)]


def monthly_expenses(
    spend: dict[Month, Decimal], first_tx: date | None, today: date
) -> ExpenseFigure:
    months = expense_window(first_tx, today)
    if not months:
        return ExpenseFigure(None, [])
    total = sum((spend.get(m, Decimal(0)) for m in months), Decimal(0))
    return ExpenseFigure(round_paise(total / len(months)), months)


def months_left(target_date: date, today: date) -> int:
    """This month through the target's month, inclusive; 0 if the month is past."""
    gap = _index(target_date.year, target_date.month) - _index(today.year, today.month) + 1
    return max(gap, 0)


class Progress(NamedTuple):
    percent: int | None
    reached: bool
    months_left: int | None
    per_month: Decimal | None
    overdue: bool


def progress(
    target: Decimal | None, saved: Decimal, target_date: date | None, today: date
) -> Progress:
    reached = target is not None and saved >= target
    left = months_left(target_date, today) if target_date is not None else None
    percent = None
    if target is not None and target > 0:
        percent = int((saved / target * 100).quantize(WHOLE, rounding=ROUND_HALF_UP))
    per_month = None
    if target is not None and not reached and left:
        per_month = (
            ((target - saved) / left)
            .quantize(WHOLE, rounding=ROUND_CEILING)
            .quantize(Decimal("0.01"))
        )
    overdue = target_date is not None and target_date < today and not reached
    return Progress(percent, reached, left, per_month, overdue)


def reminder_due(
    monthly_amount: Decimal | None,
    reminder_day: int | None,
    reminder_start: date | None,
    set_aside_this_month: Decimal,
    reached: bool,
    today: date,
) -> Decimal | None:
    """The amount still to set aside this month, or None when nothing is due."""
    if monthly_amount is None or reminder_day is None or reminder_start is None or reached:
        return None
    if _index(today.year, today.month) < _index(reminder_start.year, reminder_start.month):
        return None
    if today < clamped_date(today.year, today.month, reminder_day):
        return None
    if set_aside_this_month >= monthly_amount:
        return None
    return round_paise(monthly_amount - set_aside_this_month)
