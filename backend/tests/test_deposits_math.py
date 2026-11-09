from datetime import date
from decimal import Decimal

from app.api.deposits import (
    Dated,
    add_months,
    financial_year,
    fy_label,
    ppf_interest_due,
    ppf_maturity,
    ppf_year_interest,
    rd_due_months,
    rd_instalments,
    rd_interest_so_far,
    rd_maturity,
    rd_maturity_value,
    rd_months_paid,
    whole_months,
)

D = Decimal
RATE = D("7.1")


def test_financial_year_and_label():
    assert financial_year(date(2026, 4, 1)) == 2026
    assert financial_year(date(2026, 3, 31)) == 2025
    assert fy_label(2026) == "2026-27"
    assert fy_label(2099) == "2099-00"


def test_add_months_and_whole_months():
    assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert add_months(date(2026, 2, 28), 1, anchor_day=31) == date(2026, 3, 31)
    assert add_months(date(2026, 11, 15), 3) == date(2027, 2, 15)
    assert whole_months(date(2028, 1, 31), date(2028, 2, 29)) == 1
    assert whole_months(date(2026, 1, 15), date(2026, 2, 14)) == 0
    assert whole_months(date(2026, 3, 1), date(2026, 1, 1)) == 0


def test_maturities():
    assert ppf_maturity(date(2020, 6, 10)) == date(2036, 4, 1)
    assert ppf_maturity(date(2020, 3, 31)) == date(2035, 4, 1)
    assert ppf_maturity(date(2020, 4, 1)) == date(2036, 4, 1)
    assert rd_maturity(date(2026, 1, 31), 1) == date(2026, 2, 28)


def test_rd_maturity_value():
    assert rd_maturity_value(D(1000), D("6.8"), 12) == D("12448.73")
    assert rd_maturity_value(D(5000), D("7"), 24) == D("129098.90")


def test_rd_interest_so_far():
    # Four instalments held 3, 2, 1, 0 months at 7%.
    items = [Dated(date(2026, month, 1), D(5000)) for month in (8, 9, 10, 11)]
    today, far = date(2026, 11, 1), date(2030, 1, 1)
    assert rd_interest_so_far(items, D(7), today, far, D(0)) == D("174.66")
    assert rd_interest_so_far(items, D(7), today, far, D("100.00")) == D("74.66")
    assert rd_interest_so_far(items, D(7), today, far, D("500.00")) == D("0.00")


def test_rd_interest_stops_at_maturity():
    items = [Dated(date(2026, 1, 1), D(5000))]
    mat = date(2026, 7, 1)
    on = rd_interest_so_far(items, D(7), mat, mat, D(0))
    assert on > 0
    assert rd_interest_so_far(items, D(7), date(2027, 7, 1), mat, D(0)) == on


def test_ppf_year_interest():
    moves = [Dated(date(2026, 4, 10), D(50000))]
    end = date(2027, 3, 31)
    assert ppf_year_interest(D(100000), moves, RATE, 2026, end) == D("10354.17")
    early = [Dated(date(2026, 4, 4), D(50000))]
    assert ppf_year_interest(D(100000), early, RATE, 2026, end) == D("10650.00")
    got = ppf_year_interest(D(100000), moves, RATE, 2026, date(2027, 3, 30))
    assert got == D("10354.17") - D("887.50")


def test_ppf_interest_due():
    added = date(2026, 11, 9)
    args = (D(100000), [], [])
    assert ppf_interest_due(*args, RATE, added, date(2027, 3, 30)) is None
    got = ppf_interest_due(*args, RATE, added, date(2027, 3, 31))
    assert got == (2026, ppf_year_interest(D(100000), [], RATE, 2026, date(2027, 3, 31)))
    assert got[1] == D("7100.00")
    assert ppf_interest_due(D(1), [], [date(2027, 3, 31)], RATE, added, date(2027, 4, 5)) is None
    assert ppf_interest_due(D(1), [], [date(2027, 4, 15)], RATE, added, date(2027, 5, 1)) is None
    assert ppf_interest_due(*args, RATE, added, date(2026, 4, 10)) is None
    # An interest date in the previous window does not settle this year.
    assert ppf_interest_due(D(1), [], [date(2026, 3, 31)], RATE, added, date(2027, 4, 5)) == (
        2026,
        ppf_year_interest(D(1), [], RATE, 2026, date(2027, 4, 5)),
    )


def test_rd_instalments_and_months_paid():
    tr = [Dated(date(2026, 10, 15), D(1000))]
    got = rd_instalments(date(2026, 8, 31), D(1000), 2, tr)
    assert got == [Dated(date(2026, 8, 31), D(1000)), Dated(date(2026, 9, 30), D(1000))] + tr
    assert rd_months_paid([date(2026, 10, 1), date(2026, 10, 20), date(2026, 11, 2)]) == 2


def test_rd_due_months():
    opened = date(2026, 9, 15)
    f = rd_due_months
    assert f(opened, 15, 24, 1, [date(2026, 10, 15)], date(2026, 11, 20)) == [date(2026, 11, 15)]
    assert f(opened, 15, 24, 1, [date(2026, 10, 15)], date(2026, 11, 14)) == []
    assert f(opened, 15, 24, 1, [], date(2026, 11, 20)) == [date(2026, 10, 15), date(2026, 11, 15)]
    assert f(opened, 15, 2, 1, [], date(2027, 6, 1)) == [date(2026, 10, 15)]


def test_a_ppf_withdrawal_lowers_the_months_lowest_balance():
    april = date(2026, 4, 30)
    withdrawal = [Dated(date(2026, 4, 10), D(-30000))]
    # 70,000 is the lowest balance after the 10th: 70000 * 7.1 / 1200.
    assert ppf_year_interest(D(100000), withdrawal, RATE, 2026, april) == D("414.17")
    # A withdrawal and a later deposit in the same month: the lowest point still counts.
    both = withdrawal + [Dated(date(2026, 4, 20), D(30000))]
    assert ppf_year_interest(D(100000), both, RATE, 2026, april) == D("414.17")


def test_a_ppf_deposit_counts_only_if_made_by_the_5th():
    april = date(2026, 4, 30)
    on_the_5th = [Dated(date(2026, 4, 5), D(50000))]
    on_the_6th = [Dated(date(2026, 4, 6), D(50000))]
    assert ppf_year_interest(D(100000), on_the_5th, RATE, 2026, april) == D("887.50")
    assert ppf_year_interest(D(100000), on_the_6th, RATE, 2026, april) == D("591.67")


def test_rd_due_day_31_follows_the_end_of_february():
    f = rd_due_months
    assert f(date(2026, 12, 31), 31, 4, 0, [], date(2027, 4, 30)) == [
        date(2026, 12, 31),
        date(2027, 1, 31),
        date(2027, 2, 28),
        date(2027, 3, 31),
    ]
    # In a leap year, February's instalment falls on the 29th.
    assert f(date(2027, 12, 31), 31, 3, 0, [], date(2028, 3, 1)) == [
        date(2027, 12, 31),
        date(2028, 1, 31),
        date(2028, 2, 29),
    ]
