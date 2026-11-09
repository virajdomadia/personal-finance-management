"""Interest maths for PPF and recurring deposits (RD). Pure functions, no database.

Two rules live here:
- PPF: interest for a month is rate / 12 / 100 on the lowest balance between the end of the 5th and
  the end of the month; the year's months (April to March) are summed and rounded once.
- RD: quarterly compounding, an amount held for m whole months grows by (1 + rate / 400) ** (m / 3).

A bank whose method differs is matched by changing only `rd_maturity_value` and
`rd_interest_so_far`.
"""

from datetime import date
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import NamedTuple

from app.api.dates import clamped_date

PAISE = Decimal("0.01")


class Dated(NamedTuple):
    date: date
    amount: Decimal  # signed: + in, - out


def _paise(value: Decimal) -> Decimal:
    return value.quantize(PAISE, rounding=ROUND_HALF_UP)


def financial_year(day: date) -> int:
    """The starting year of the financial year (April to March) containing `day`."""
    return day.year if day.month >= 4 else day.year - 1


def fy_label(year: int) -> str:
    return f"{year}-{(year + 1) % 100:02d}"


def add_months(day: date, months: int, anchor_day: int | None = None) -> date:
    index = day.year * 12 + day.month - 1 + months
    return clamped_date(index // 12, index % 12 + 1, anchor_day or day.day)


def whole_months(start: date, end: date) -> int:
    """Completed months from start to end (a month ends on the same day, or the last day)."""
    if end < start:
        return 0
    months = (end.year - start.year) * 12 + end.month - start.month
    return months if add_months(start, months) <= end else months - 1


def ppf_maturity(opened_on: date) -> date:
    return date(financial_year(opened_on) + 16, 4, 1)


def rd_maturity(opened_on: date, tenure_months: int) -> date:
    return add_months(opened_on, tenure_months)


def _month_lowest(opening: Decimal, moves: list[Dated], year: int, month: int) -> Decimal:
    """The lowest balance between the end of the 5th and the end of the month."""

    def balance_on(day: date) -> Decimal:
        return opening + sum((m.amount for m in moves if m.date <= day), Decimal(0))

    lowest = balance_on(date(year, month, 5))
    for day in sorted({m.date for m in moves if m.date.year == year and m.date.month == month}):
        if day.day > 5:
            lowest = min(lowest, balance_on(day))
    return lowest


def ppf_year_interest(
    opening: Decimal, moves: list[Dated], rate: Decimal, year: int, today: date
) -> Decimal:
    """PPF interest for FY `year` over the months whose last day is on or before `today`."""
    total = Decimal(0)
    for i in range(12):
        index = year * 12 + 3 + i  # April of `year` is month index 3
        y, m = index // 12, index % 12 + 1
        last = clamped_date(y, m, 31)
        if last <= today:
            total += _month_lowest(opening, moves, y, m) * rate / 1200
    return _paise(total)


def ppf_interest_due(
    opening: Decimal,
    moves: list[Dated],
    interest_dates: list[date],
    rate: Decimal,
    added_on: date,
    today: date,
) -> tuple[int, Decimal] | None:
    """The year just ended, if it ended on or after `added_on` and its interest is not recorded."""
    fy = financial_year(today)
    year = fy if today >= date(fy + 1, 3, 31) else fy - 1
    ended = date(year + 1, 3, 31)
    if ended < added_on:
        return None
    window_end = date(year + 2, 3, 30)
    if any(ended <= d <= window_end for d in interest_dates):
        return None
    return year, ppf_year_interest(opening, moves, rate, year, today)


def rd_maturity_value(amount: Decimal, rate: Decimal, tenure_months: int) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 34
        q = 1 + rate / 400
        total = sum(
            (
                amount * q ** (Decimal(tenure_months - k + 1) / 3)
                for k in range(1, tenure_months + 1)
            ),
            Decimal(0),
        )
    return _paise(total)


def rd_instalments(
    opened_on: date,
    deposit_amount: Decimal,
    deposits_at_opening: int,
    transfers_in: list[Dated],
) -> list[Dated]:
    opening = [Dated(add_months(opened_on, i), deposit_amount) for i in range(deposits_at_opening)]
    return opening + list(transfers_in)


def rd_interest_so_far(
    instalments: list[Dated],
    rate: Decimal,
    today: date,
    maturity: date,
    recorded_interest: Decimal,
) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 34
        q = 1 + rate / 400
        until = min(today, maturity)
        total = sum(
            (i.amount * (q ** (Decimal(whole_months(i.date, until)) / 3) - 1) for i in instalments),
            Decimal(0),
        )
    return _paise(max(total - recorded_interest, Decimal(0)))


def rd_due_months(
    opened_on: date,
    due_day: int,
    tenure_months: int,
    deposits_at_opening: int,
    transfer_dates: list[date],
    today: date,
) -> list[date]:
    """Instalment dates that have come round with no transfer into the RD in that month."""
    paid = {(d.year, d.month) for d in transfer_dates}
    due = []
    for i in range(deposits_at_opening, tenure_months):
        index = opened_on.year * 12 + opened_on.month - 1 + i
        day = clamped_date(index // 12, index % 12 + 1, due_day)
        if day <= today and (day.year, day.month) not in paid:
            due.append(day)
    return due


def rd_months_paid(transfer_dates: list[date]) -> int:
    return len({(d.year, d.month) for d in transfer_dates})
