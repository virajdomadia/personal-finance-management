"""The spend calendar: each day's money out less money in. Rules:
docs/architecture/financial-calculations.md, "Spend calendar".

Pure functions over plain rows, so the arithmetic is tested without a database.
"""

from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import NamedTuple

from app.api.cash_flow import ZERO, Row, last_day

# The types that move money in or out of the user's hands; transfers and adjustments don't.
CALENDAR_TYPES = ("income", "expense", "emi", "refund")


class CalendarDay(NamedTuple):
    date: date
    net: Decimal | None  # out − in; negative when more came in. None for a day after `through`


def day_net(row: Row) -> Decimal:
    """What a transaction adds to its day: expenses and whole EMIs out, income and refunds in."""
    if row.type in ("expense", "emi"):
        return row.amount
    if row.type in ("income", "refund"):
        return -row.amount
    return ZERO


def calendar_days(rows: Iterable[Row], first: date, through: date) -> list[CalendarDay]:
    by_day: dict[date, Decimal] = {}
    for r in rows:
        by_day[r.date] = by_day.get(r.date, ZERO) + day_net(r)
    return [
        CalendarDay(day, None if day > through else by_day.get(day, ZERO))
        for day in (
            date(first.year, first.month, d)
            for d in range(1, last_day(first.year, first.month) + 1)
        )
    ]
