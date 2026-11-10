from datetime import date

from app.api.sips import BuyRow, SipRow, due_dates

TODAY = date(2026, 11, 9)


def sip(day=5, start=date(2026, 5, 5), active=True):
    return SipRow(1, 1, 2, day, start, active)


def linked(d):
    return BuyRow(1, 2, d, True, 1)


def test_unrecorded_months_are_due():
    assert due_dates(sip(), [], TODAY) == [date(2026, m, 5) for m in range(5, 12)]


def test_linked_opening_buys_settle_months():
    days = [
        date(2026, 5, 5), date(2026, 6, 5), date(2026, 7, 6), date(2026, 8, 5),
        date(2026, 9, 7), date(2026, 10, 6), date(2026, 11, 5),
    ]  # fmt: skip
    assert due_dates(sip(), [linked(d) for d in days], TODAY) == []


def test_unlinked_buy_counts_only_when_not_opening_from_any_account():
    d = date(2026, 5, 6)
    assert date(2026, 5, 5) not in due_dates(sip(), [BuyRow(1, 2, d, False, None)], TODAY)
    assert date(2026, 5, 5) in due_dates(sip(), [BuyRow(1, 2, d, True, None)], TODAY)
    assert date(2026, 5, 5) not in due_dates(sip(), [BuyRow(1, 3, d, False, None)], TODAY)
    assert date(2026, 5, 5) in due_dates(sip(), [BuyRow(9, 2, d, False, None)], TODAY)
    # Another SIP's linked buy does not settle this one.
    assert date(2026, 5, 5) in due_dates(sip(), [BuyRow(1, 2, d, False, 7)], TODAY)


def test_not_due_before_the_debit_day():
    assert date(2026, 11, 5) not in due_dates(sip(), [], date(2026, 11, 4))
    assert date(2026, 10, 5) in due_dates(sip(), [], date(2026, 11, 4))


def test_stopped_sip_is_never_due():
    assert due_dates(sip(active=False), [], TODAY) == []


def test_day_31_clamps():
    s = sip(day=31, start=date(2027, 1, 1))
    assert date(2027, 2, 28) in due_dates(s, [], date(2027, 3, 1))


def test_start_after_debit_day():
    s = sip(day=5, start=date(2026, 5, 20))
    assert due_dates(s, [], TODAY)[0] == date(2026, 6, 5)


def test_unlinked_buy_from_a_new_bank_settles_a_moved_sip():
    # Paid from bank 2 in Jan-Feb, moved to bank 3 in March; today is 2027-03-20.
    moved = SipRow(1, 1, 3, 5, date(2027, 1, 5), True)
    buys = [
        BuyRow(1, 2, date(2027, 1, 5), False, None),
        BuyRow(1, 2, date(2027, 2, 5), False, None),
    ]
    assert due_dates(moved, buys, date(2027, 3, 20)) == [date(2027, 3, 5)]


def test_another_active_sip_of_the_fund_keeps_its_own_account_buys():
    mine = SipRow(1, 1, 3, 5, date(2027, 1, 5), True)
    theirs = SipRow(2, 1, 2, 5, date(2027, 1, 5), True)
    buys = [BuyRow(1, 2, date(2027, 1, 5), False, None)]
    assert date(2027, 1, 5) in due_dates(mine, buys, date(2027, 1, 20), [mine, theirs])
    stopped = theirs._replace(active=False)
    assert date(2027, 1, 5) not in due_dates(mine, buys, date(2027, 1, 20), [mine, stopped])
