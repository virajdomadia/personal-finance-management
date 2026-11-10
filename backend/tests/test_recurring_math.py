from datetime import date

from app.api.recurring import (
    Status,
    TemplateRow,
    card_bill_due,
    is_recorded,
    occurrences,
    status,
)


def tpl(
    frequency="monthly", day=1, month=None, start=date(2027, 1, 1), end=None, remind=3, active=True
):
    return TemplateRow(1, frequency, day, month, start, end, remind, active)


def test_monthly_day_31_clamps():
    t = tpl(day=31, start=date(2027, 1, 31))
    assert occurrences(t, date(2027, 4, 30)) == [
        date(2027, 1, 31),
        date(2027, 2, 28),
        date(2027, 3, 31),
        date(2027, 4, 30),
    ]


def test_yearly_feb_29_clamps():
    t = tpl("yearly", 29, 2, start=date(2028, 2, 29))
    assert occurrences(t, date(2029, 12, 31)) == [date(2028, 2, 29), date(2029, 2, 28)]


def test_end_date_stops_occurrences():
    t = tpl(end=date(2027, 2, 15))
    assert occurrences(t, date(2027, 6, 1)) == [date(2027, 1, 1), date(2027, 2, 1)]


YEARLY = dict(frequency="yearly", day=6, month=4, start=date(2027, 4, 6), remind=30)


def test_yearly_reminder_window():
    t = tpl(**YEARLY)
    assert status(t, [], set(), date(2027, 3, 6)) == Status([], None)
    assert status(t, [], set(), date(2027, 3, 7)) == Status([], date(2027, 4, 6))
    assert status(t, [], set(), date(2027, 4, 7)).due == [date(2027, 4, 6)]


def test_yearly_payment_window():
    t = tpl(**YEARLY)
    today = date(2027, 4, 7)
    for paid in (date(2027, 3, 27), date(2027, 4, 26)):
        assert status(t, [paid], set(), today).due == []
    assert status(t, [date(2027, 6, 1)], set(), today).due == [date(2027, 4, 6)]
    assert not is_recorded(t, date(2028, 4, 6), [date(2027, 4, 6)])


def test_monthly_rent_due_and_skip():
    t = tpl()
    today = date(2027, 3, 10)
    paid = [date(2027, 1, 3)]
    assert status(t, paid, set(), today).due == [date(2027, 2, 1), date(2027, 3, 1)]
    assert status(t, paid, {date(2027, 2, 1)}, today).due == [date(2027, 3, 1)]


def test_one_payment_settles_one_occurrence():
    m = tpl()
    today = date(2027, 2, 20)
    # Two payments in January: the first settles January, the second settles nothing.
    assert status(m, [date(2027, 1, 5), date(2027, 1, 20)], set(), today).due == [date(2027, 2, 1)]
    # A payment inside both January's month and February's early window settles only January.
    assert status(m, [date(2027, 1, 30)], set(), today).due == [date(2027, 2, 1)]
    # Two yearly occurrences never share a payment.
    y = tpl("yearly", 6, 4, start=date(2027, 4, 6))
    assert status(y, [date(2028, 3, 1)], set(), date(2028, 4, 10)).due == [date(2027, 4, 6)]


def test_payment_from_coming_up_settles_next_month():
    t = tpl(start=date(2026, 10, 1), remind=3)
    paid = [date(2026, 10, 5), date(2026, 10, 30)]
    assert status(t, paid, set(), date(2026, 10, 31)).coming_up is None
    assert status(t, paid, set(), date(2026, 11, 2)).due == []


def test_a_skipped_occurrence_never_takes_a_payment():
    t = tpl(start=date(2026, 10, 1), remind=3)
    # October is skipped, so the 30 Oct payment settles November instead.
    assert status(t, [date(2026, 10, 30)], {date(2026, 10, 1)}, date(2026, 11, 2)).due == []


def test_payment_prefers_its_own_open_month():
    t = tpl(start=date(2026, 10, 1), remind=20)
    # 15 Oct is inside November's early window too, but October is still open.
    assert status(t, [date(2026, 10, 15)], set(), date(2026, 11, 2)).due == [date(2026, 11, 1)]


def test_yearly_early_side_follows_remind_days():
    t = tpl("yearly", 6, 4, start=date(2027, 4, 6), remind=60)
    assert status(t, [date(2027, 2, 5)], set(), date(2027, 4, 7)) == Status([], None)
    assert status(t, [date(2027, 2, 4)], set(), date(2027, 4, 7)).due == [date(2027, 4, 6)]


def test_stopped_template_never_due():
    t = tpl(active=False)
    assert status(t, [], set(), date(2027, 5, 1)) == Status([], None)


def test_card_bill_due():
    assert card_bill_due(date(2027, 4, 6), 15, 5) == date(2027, 5, 5)
    assert card_bill_due(date(2027, 4, 6), 1, 25) == date(2027, 5, 25)
    assert card_bill_due(date(2027, 4, 15), 15, 5) == date(2027, 5, 5)
