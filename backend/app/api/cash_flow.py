"""A month's cash flow: income, spending and net, by category and by day, against the month
before at the same day. The rules are in docs/architecture/financial-calculations.md.

Pure functions over plain rows, so the arithmetic is tested without a database.
"""

import calendar
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from app.api.categories import UNCATEGORISED, name_key
from app.models.category import Category

ZERO = Decimal(0)


@dataclass(frozen=True)
class Row:
    type: str
    amount: Decimal
    interest: Decimal | None
    category: str | None
    date: date


def spent(row: Row) -> Decimal:
    """An expense's amount, an EMI's interest; transfers and income spend nothing."""
    if row.type == "expense":
        return row.amount
    if row.type == "emi":
        return row.interest or ZERO
    return ZERO


def earned(row: Row) -> Decimal:
    return row.amount if row.type == "income" else ZERO


def last_day(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def previous_month(first: date) -> date:
    return date(first.year - 1, 12, 1) if first.month == 1 else date(first.year, first.month - 1, 1)


def next_month(first: date) -> date:
    return date(first.year + 1, 1, 1) if first.month == 12 else date(first.year, first.month + 1, 1)


def windows(first: date, today: date) -> tuple[date, date, date, date]:
    """(start, through) for the month and for the month before at the same day.

    The month runs to today when it is the current month, else to its last day; the month
    before runs to the same day number, clamped to its own length."""
    last = last_day(first.year, first.month)
    current = (first.year, first.month) == (today.year, today.month)
    through = today if current else date(first.year, first.month, last)
    before = previous_month(first)
    day = through.day if current else 31  # a whole month compares with the whole month before
    before_through = date(before.year, before.month, min(day, last_day(before.year, before.month)))
    return first, through, before, before_through


def percent(part: Decimal, whole: Decimal) -> int | None:
    """part ÷ whole × 100, rounded half up to a whole percent; None when whole is 0."""
    if whole == 0:
        return None
    return int((part * 100 / whole).quantize(Decimal(1), rounding=ROUND_HALF_UP))


@dataclass
class Totals:
    income: Decimal = ZERO
    spending: Decimal = ZERO

    @property
    def net(self) -> Decimal:
        return self.income - self.spending


def totals(rows: Iterable[Row]) -> Totals:
    result = Totals()
    for row in rows:
        result.income += earned(row)
        result.spending += spent(row)
    return result


@dataclass
class Group:
    """A category's figure; a top-level one includes its subcategories' (`children`)."""

    id: int | None
    name: str
    icon: str | None
    colour: str | None
    amount: Decimal = ZERO
    direct: Decimal = ZERO  # what is in this category itself, not a subcategory
    children: list["Group"] = field(default_factory=list)


def _sort(groups: Iterable[Group]) -> list[Group]:
    return sorted(groups, key=lambda g: (-g.amount, g.name.casefold()))


def grouped(rows: Iterable[Row], kind: str, categories: Iterable[Category]) -> list[Group]:
    """Income (`kind="income"`) or spending by category, subcategories rolled up into their
    parents, biggest first. Each group's children are sorted the same way."""
    live = {c.name_key: c for c in categories if c.kind == kind and c.merged_into_id is None}
    by_id = {c.id: c for c in live.values()}
    value = earned if kind == "income" else spent
    tops: dict[str, Group] = {}

    def group_for(category: Category | None, name: str) -> Group:
        key = name_key(name) if category is None else f"#{category.id}"
        if key not in tops:
            tops[key] = (
                Group(None, name, None, None)
                if category is None
                else Group(category.id, category.name, category.icon, category.colour)
            )
        return tops[key]

    for row in rows:
        amount = value(row)
        if amount == 0:
            continue
        name = row.category or UNCATEGORISED
        category = None if row.category is None else live.get(name_key(row.category))
        parent = None if category is None else by_id.get(category.parent_id or 0)
        if parent is None:
            top = group_for(category, name)
            top.amount += amount
            top.direct += amount
            continue
        top = group_for(parent, parent.name)
        top.amount += amount
        assert category is not None
        child = next((c for c in top.children if c.id == category.id), None)
        if child is None:
            child = Group(category.id, category.name, category.icon, category.colour)
            top.children.append(child)
        child.amount += amount
        child.direct += amount

    result = _sort(tops.values())
    for top in result:
        top.children = _sort(top.children)
    return result


@dataclass
class DaySpend:
    date: date
    spent: Decimal | None  # None for a day after today
    height: int | None  # percent of the month's biggest day


def daily(rows: Iterable[Row], first: date, through: date) -> list[DaySpend]:
    by_day: dict[date, Decimal] = {}
    for row in rows:
        by_day[row.date] = by_day.get(row.date, ZERO) + spent(row)
    days = [
        date(first.year, first.month, d) for d in range(1, last_day(first.year, first.month) + 1)
    ]
    known = [by_day.get(d, ZERO) for d in days if d <= through]
    biggest = max(known, default=ZERO)
    result: list[DaySpend] = []
    for d in days:
        if d > through:
            result.append(DaySpend(d, None, None))
            continue
        amount = by_day.get(d, ZERO)
        result.append(DaySpend(d, amount, percent(amount, biggest) or 0))
    return result
