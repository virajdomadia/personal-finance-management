from datetime import date
from decimal import Decimal

import pytest

from app.api import cash_flow as cf
from app.models.category import Category


def row(
    type_: str,
    amount: str,
    category: str | None = None,
    day: int = 1,
    interest: str | None = None,
) -> cf.Row:
    return cf.Row(
        type_,
        Decimal(amount),
        None if interest is None else Decimal(interest),
        category,
        date(2026, 11, day),
    )


def test_spending_counts_expenses_and_emi_interest_only() -> None:
    rows = [
        row("income", "80000.00", "Salary"),
        row("expense", "6000.00", "Groceries"),
        row("expense", "1200.00", "Dining"),
        row("emi", "12000.00", "Loan interest", interest="3000.00"),
        row("transfer", "20000.00"),  # a card bill payment
    ]
    totals = cf.totals(rows)
    assert (totals.income, totals.spending, totals.net) == (
        Decimal("80000.00"),
        Decimal("10200.00"),
        Decimal("69800.00"),
    )


@pytest.mark.parametrize(
    "month,today,expected",
    [
        # The current month runs to today; the month before to the same day.
        ((2026, 11), date(2026, 11, 12), ("2026-11-12", "2026-10-01", "2026-10-12")),
        # Clamped to February's length.
        ((2027, 3), date(2027, 3, 30), ("2027-03-30", "2027-02-01", "2027-02-28")),
        # A past month compares whole months.
        ((2026, 3), date(2026, 11, 12), ("2026-03-31", "2026-02-01", "2026-02-28")),
        # On its last day a month is whole, as it will be the day after.
        ((2026, 4), date(2026, 4, 30), ("2026-04-30", "2026-03-01", "2026-03-31")),
        ((2027, 2), date(2027, 2, 28), ("2027-02-28", "2027-01-01", "2027-01-31")),
        ((2026, 4), date(2026, 5, 1), ("2026-04-30", "2026-03-01", "2026-03-31")),
        # January compares with December.
        ((2027, 1), date(2027, 1, 5), ("2027-01-05", "2026-12-01", "2026-12-05")),
    ],
)
def test_windows(month: tuple[int, int], today: date, expected: tuple[str, str, str]) -> None:
    start, through, before, before_through = cf.windows(date(*month, 1), today)
    assert start == date(*month, 1)
    assert (through.isoformat(), before.isoformat(), before_through.isoformat()) == expected


@pytest.mark.parametrize(
    "part,whole,expected",
    [("1", "3", 33), ("2", "3", 67), ("1", "8", 13), ("-1", "8", -13), ("5", "0", None)],
)
def test_percent_rounds_half_up(part: str, whole: str, expected: int | None) -> None:
    assert cf.percent(Decimal(part), Decimal(whole)) == expected


def category(id: int, name: str, parent: int | None = None) -> Category:
    return Category(
        id=id, kind="expense", name=name, name_key=name.casefold(), parent_id=parent, icon="food"
    )


def test_grouping_rolls_subcategories_into_their_parent() -> None:
    categories = [
        category(1, "Food and dining"),
        category(2, "Groceries", parent=1),
        category(3, "Dining", parent=1),
        category(4, "Fuel"),
    ]
    rows = [
        row("expense", "100.00", "groceries"),
        row("expense", "50.00", "Dining"),
        row("expense", "30.00", "Food and dining"),
        row("expense", "120.00", "Fuel"),
        row("expense", "10.00", None),
        row("income", "999.00", "Salary"),
    ]
    groups = cf.grouped(rows, "expense", categories)
    assert [(g.name, g.amount, g.direct) for g in groups] == [
        ("Food and dining", Decimal("180.00"), Decimal("30.00")),
        ("Fuel", Decimal("120.00"), Decimal("120.00")),
        ("Uncategorised", Decimal("10.00"), Decimal("10.00")),
    ]
    assert [(c.name, c.amount) for c in groups[0].children] == [
        ("Groceries", Decimal("100.00")),
        ("Dining", Decimal("50.00")),
    ]
    assert groups[2].id is None


def test_daily_bars_are_relative_to_the_biggest_day() -> None:
    rows = [
        row("expense", "200.00", day=1),
        row("expense", "50.00", day=3),
        row("income", "9.00", day=2),
    ]
    days = cf.daily(rows, date(2026, 11, 1), date(2026, 11, 3))
    assert len(days) == 30
    assert [(d.spent, d.height) for d in days[:4]] == [
        (Decimal("200.00"), 100),
        (Decimal(0), 0),
        (Decimal("50.00"), 25),
        (None, None),
    ]
