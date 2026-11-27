from datetime import date
from decimal import Decimal

from app.api.cash_flow import Row
from app.api.spend_calendar import calendar_days, day_net


def row(type_: str, amount: str, day: date = date(2026, 11, 5), interest: str | None = None) -> Row:
    return Row(type_, Decimal(amount), None if interest is None else Decimal(interest), None, day)


def test_money_out_counts_up() -> None:
    assert day_net(row("expense", "500")) == Decimal("500")
    # The whole EMI leaves the account, not just its interest.
    assert day_net(row("emi", "12000", interest="3000")) == Decimal("12000")


def test_money_in_counts_down() -> None:
    assert day_net(row("income", "4000")) == Decimal("-4000")
    assert day_net(row("refund", "200")) == Decimal("-200")


def test_moves_between_own_accounts_count_nothing() -> None:
    assert day_net(row("transfer", "3000")) == Decimal("0")
    assert day_net(row("adjustment", "-150")) == Decimal("0")


ROWS = [
    row("expense", "8000", date(2026, 11, 3)),
    row("income", "4000", date(2026, 11, 3)),
    row("expense", "1500", date(2026, 11, 5)),
    row("refund", "200", date(2026, 11, 5)),
    row("income", "54800", date(2026, 11, 1)),
    row("expense", "8000", date(2026, 11, 1)),
]


def test_each_day_is_out_less_in() -> None:
    days = calendar_days(ROWS, date(2026, 11, 1), date(2026, 11, 12))
    assert len(days) == 30
    by_day = {d.date.day: d.net for d in days}
    assert by_day[3] == Decimal("4000")  # spent 8k, got 4k
    assert by_day[5] == Decimal("1300")
    assert by_day[1] == Decimal("-46800")  # salary day: more came in
    assert by_day[2] == Decimal("0")


def test_days_after_through_are_blank() -> None:
    days = calendar_days(ROWS, date(2026, 11, 1), date(2026, 11, 12))
    assert days[11].net is not None
    assert all(d.net is None for d in days[12:])
