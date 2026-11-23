from datetime import date
from decimal import Decimal

from app.api.cash_flow import Row
from app.api.spend_calendar import (
    Allowance,
    Fixed,
    allowance,
    calendar_days,
    counts_in,
    pace,
)

START = date(2020, 1, 1)


def item(name: str, kind: str, amount: str, **kw: object) -> Fixed:
    values: dict[str, object] = {
        "day": 1,
        "start_date": START,
        "end_date": None,
        "active": True,
        **kw,
    }
    return Fixed(name, kind, Decimal(amount), **values)  # type: ignore[arg-type]


OWNER = [
    item("Salary", "income", "54800"),
    item("Rent", "out", "16000"),
    item("SIP", "out", "5000"),
    item("PPF", "out", "3000"),
]


def row(type_: str, amount: str, day: date) -> Row:
    return Row(type_, Decimal(amount), None, None, day)


def test_the_owners_month() -> None:
    assert allowance(OWNER, date(2026, 12, 1)) == Allowance(
        Decimal("54800"), Decimal("24000"), Decimal("30800"), Decimal("993.55")
    )


def test_thirty_day_and_february() -> None:
    assert allowance(OWNER, date(2026, 11, 1)).per_day == Decimal("1026.67")
    assert allowance(OWNER, date(2026, 2, 1)).per_day == Decimal("1100.00")
    assert allowance(OWNER, date(2028, 2, 1)).per_day == Decimal("1062.07")


def test_no_income_means_no_per_day() -> None:
    result = allowance(OWNER[1:], date(2026, 11, 1))
    assert result.per_day is None
    assert result.free == Decimal("-24000")


def test_fixed_more_than_income() -> None:
    items = [item("Salary", "income", "10000"), item("Rent", "out", "16000")]
    result = allowance(items, date(2026, 11, 1))
    assert result.free == Decimal("-6000")
    assert result.per_day == Decimal("-200.00")


def test_counts_in_by_dates() -> None:
    late = item("New", "out", "100", start_date=date(2026, 11, 20))
    assert counts_in(late, date(2026, 11, 1))
    assert not counts_in(late, date(2026, 10, 1))
    ended = item("Old", "out", "100", end_date=date(2026, 10, 31))
    assert counts_in(ended, date(2026, 10, 1))
    assert not counts_in(ended, date(2026, 11, 1))
    off = item("Off", "out", "100", active=False)
    assert not counts_in(off, date(2026, 11, 1))


def test_inactive_and_late_items_left_out_of_allowance() -> None:
    items = [*OWNER, item("Gym", "out", "3000", start_date=date(2026, 12, 5))]
    assert allowance(items, date(2026, 11, 1)).fixed_out == Decimal("24000")
    assert allowance(items, date(2026, 12, 1)).fixed_out == Decimal("27000")


ROWS = [
    row("expense", "500", date(2026, 11, 3)),
    row("expense", "1500", date(2026, 11, 5)),
    row("refund", "200", date(2026, 11, 5)),
    row("income", "54800", date(2026, 11, 1)),
]


def test_days_colour_and_future() -> None:
    days = calendar_days(ROWS, date(2026, 11, 1), date(2026, 11, 12), Decimal("1000"))
    assert len(days) == 30
    by_day = {d.date.day: d for d in days}
    assert (by_day[3].spent, by_day[3].over) == (Decimal("500"), False)
    assert (by_day[5].spent, by_day[5].over) == (Decimal("1300"), True)
    assert (by_day[1].spent, by_day[1].over) == (Decimal("0"), False)
    assert (by_day[13].spent, by_day[13].over) == (None, None)


def test_days_without_per_day() -> None:
    days = calendar_days(ROWS, date(2026, 11, 1), date(2026, 11, 12), None)
    past = [d for d in days if d.date.day <= 12]
    assert all(d.over is None for d in past)
    assert past[4].spent == Decimal("1300")


def test_negative_per_day_any_spend_is_over() -> None:
    rows = [row("expense", "50", date(2026, 11, 2))]
    days = calendar_days(rows, date(2026, 11, 1), date(2026, 11, 2), Decimal("-200"))
    assert days[0].over is False
    assert days[1].over is True


def test_pace() -> None:
    first, through = date(2026, 11, 1), date(2026, 11, 12)
    assert pace(Decimal("1000"), through, first, Decimal("10000")) == Decimal("2000.00")
    assert pace(None, through, first, Decimal("10000")) is None
