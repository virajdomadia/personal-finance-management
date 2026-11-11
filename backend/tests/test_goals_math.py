from datetime import date
from decimal import Decimal

from app.api.goals import (
    ExpenseFigure,
    expense_window,
    monthly_expenses,
    months_left,
    progress,
    reminder_due,
)

TODAY = date(2026, 11, 11)
OCT_BACK = [(2026, m) for m in range(5, 11)]


def test_window_drops_partial_first_month():
    assert expense_window(date(2026, 5, 20), TODAY) == OCT_BACK[1:]


def test_window_keeps_first_month_when_started_on_the_1st():
    assert expense_window(date(2026, 5, 1), TODAY) == OCT_BACK


def test_window_caps_at_six_months():
    assert expense_window(date(2025, 1, 3), TODAY) == OCT_BACK


def test_window_empty_without_a_full_month():
    assert expense_window(None, TODAY) == []
    assert expense_window(date(2026, 11, 2), TODAY) == []
    assert expense_window(date(2026, 10, 15), TODAY) == []


def test_window_crosses_year_boundary():
    assert expense_window(None, date(2027, 2, 10)) == []
    assert expense_window(date(2026, 1, 1), date(2027, 2, 10)) == [
        (2026, 8),
        (2026, 9),
        (2026, 10),
        (2026, 11),
        (2026, 12),
        (2027, 1),
    ]


def test_monthly_expenses_average_ignores_current_month():
    spend = {
        (2026, 6): Decimal(30000),
        (2026, 7): Decimal(32000),
        (2026, 8): Decimal(33000),
        (2026, 9): Decimal(31000),
        (2026, 10): Decimal(36000),
        (2026, 11): Decimal(99999),
    }
    assert monthly_expenses(spend, date(2026, 5, 20), TODAY) == ExpenseFigure(
        Decimal("32400.00"), [(2026, m) for m in range(6, 11)]
    )


def test_monthly_expenses_missing_months_count_as_zero():
    fig = monthly_expenses({(2026, 10): Decimal(6000)}, date(2026, 5, 1), TODAY)
    assert fig.amount == Decimal("1000.00")


def test_monthly_expenses_none_without_window():
    assert monthly_expenses({}, None, TODAY) == ExpenseFigure(None, [])


def test_months_left():
    assert months_left(date(2027, 6, 30), TODAY) == 8
    assert months_left(date(2026, 11, 30), TODAY) == 1
    assert months_left(date(2026, 10, 31), TODAY) == 0


def test_progress_partway():
    p = progress(Decimal(120000), Decimal(45500), date(2027, 6, 30), TODAY)
    assert p.percent == 38
    assert not p.reached
    assert p.months_left == 8
    assert p.per_month == Decimal("9313.00")
    assert not p.overdue


def test_progress_reached_and_over():
    p = progress(Decimal(120000), Decimal(120000), date(2027, 6, 30), TODAY)
    assert p.reached and p.per_month is None and p.percent == 100
    assert progress(Decimal(120000), Decimal(130000), None, TODAY).percent == 108


def test_progress_overdue():
    p = progress(Decimal(120000), Decimal(45500), date(2026, 10, 31), TODAY)
    assert p.months_left == 0 and p.per_month is None and p.overdue


def test_progress_without_target_or_date():
    p = progress(None, Decimal(500), None, TODAY)
    assert p.percent is None and not p.reached and p.months_left is None
    assert p.per_month is None and not p.overdue
    q = progress(Decimal(1000), Decimal(500), None, TODAY)
    assert q.percent == 50 and q.months_left is None and q.per_month is None


def test_percent_rounds_half_up():
    assert progress(Decimal(200), Decimal(1), None, TODAY).percent == 1  # 0.5
    assert progress(Decimal(3), Decimal(1), None, TODAY).percent == 33


def due(set_aside=0, reached=False, today=date(2026, 11, 30), start=date(2026, 11, 1)):
    return reminder_due(Decimal(5000), 31, start, Decimal(set_aside), reached, today)


def test_reminder_not_due_before_clamped_day():
    assert due(today=date(2026, 11, 29)) is None


def test_reminder_due_on_clamped_day():
    assert due() == Decimal("5000.00")


def test_reminder_due_remainder():
    assert due(3000) == Decimal("2000.00")


def test_reminder_not_due_when_covered_reached_or_not_started():
    assert due(5000) is None
    assert due(reached=True) is None
    assert due(start=date(2026, 12, 1)) is None


def test_reminder_not_due_without_settings():
    t = date(2026, 11, 30)
    assert reminder_due(None, 1, date(2026, 11, 1), Decimal(0), False, t) is None
    assert reminder_due(Decimal(5000), None, date(2026, 11, 1), Decimal(0), False, t) is None
    assert reminder_due(Decimal(5000), 1, None, Decimal(0), False, t) is None
