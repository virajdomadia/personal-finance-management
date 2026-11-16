"""Interest maths for PPF, recurring deposits (RD) and fixed deposits (FD). Pure functions, no
database.

Three rules live here:
- PPF: interest for a month is rate / 12 / 100 on the lowest balance between the end of the 5th and
  the end of the month; the year's months (April to March) are summed and rounded once
  to the nearest rupee, as a bank passbook shows.
- RD: quarterly compounding, an amount held for m whole months grows by (1 + rate / 400) ** (m / 3).
- FD: compounded every whole quarter, then simple interest for the days left over (the method
  Indian banks publish for cumulative FDs). A payout FD pays its interest out instead.

A bank whose method differs is matched by changing only `rd_maturity_value` and
`rd_interest_so_far`, or `fd_value` for an FD.
"""

from datetime import UTC, date
from decimal import ROUND_HALF_UP, Decimal, localcontext
from typing import Literal, NamedTuple

from pydantic import BaseModel

from app.api.balances import balance_of
from app.api.dates import INDIA, clamped_date
from app.api.loans import Book, DepositMove
from app.api.portfolio import PortfolioTotals
from app.models.account import Account

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
    return clamped_date(
        index // 12, index % 12 + 1, anchor_day if anchor_day is not None else day.day
    )


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
    """PPF interest for FY `year` over the months whose last day is on or before `today`.

    The sum is rounded once, half up, to whole rupees (the passbook credits 94.67 as 95).
    """
    total = Decimal(0)
    with localcontext() as ctx:
        ctx.prec = 34
        for i in range(12):
            index = year * 12 + 3 + i  # April of `year` is month index 3
            y, m = index // 12, index % 12 + 1
            last = clamped_date(y, m, 31)
            if last <= today:
                total += _month_lowest(opening, moves, y, m) * rate / 1200
    return total.quantize(Decimal(1), rounding=ROUND_HALF_UP).quantize(PAISE)


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


def fd_value(amount: Decimal, rate: Decimal, start: date, end: date) -> Decimal:
    """`amount` placed on `start`, compounded each whole quarter, simple interest for the days
    after the last whole quarter, as at `end`. Not rounded: callers round their totals."""
    if end <= start:
        return amount
    with localcontext() as ctx:
        ctx.prec = 34
        quarters = whole_months(start, end) // 3
        last = add_months(start, quarters * 3)
        days = (end - last).days
        return amount * (1 + rate / 400) ** quarters * (1 + rate * days / 36500)


def fd_maturity_value(principals: list[Dated], rate: Decimal, maturity: date) -> Decimal:
    return _paise(sum((fd_value(p.amount, rate, p.date, maturity) for p in principals), Decimal(0)))


def fd_interest_so_far(
    principals: list[Dated],
    rate: Decimal,
    today: date,
    maturity: date,
    recorded_interest: Decimal,
) -> Decimal:
    until = min(today, maturity)
    earned = sum(
        (fd_value(p.amount, rate, p.date, until) - p.amount for p in principals), Decimal(0)
    )
    return _paise(max(earned - recorded_interest, Decimal(0)))


def fd_payout_amount(principal: Decimal, rate: Decimal, payout: str) -> Decimal | None:
    """The interest a payout FD pays each month or quarter; None for a cumulative FD."""
    if payout == "monthly":
        return _paise(principal * rate / 1200)
    if payout == "quarterly":
        return _paise(principal * rate / 400)
    return None


PPF_YEAR_LIMIT = Decimal("150000.00")


class PpfInterestDue(BaseModel):
    year: str
    amount: str
    date: str


class PpfFigures(BaseModel):
    kind: Literal["ppf"]
    maturity_date: str
    deposited_this_year: str
    year_limit: str
    interest_this_year: str
    interest_due: PpfInterestDue | None


class RdFigures(BaseModel):
    kind: Literal["rd"]
    maturity_date: str
    deposits_paid: int
    deposits_left: int
    deposited: str
    interest_so_far: str
    value_today: str
    maturity_value: str
    due: list[str]


class FdFigures(BaseModel):
    kind: Literal["fd"]
    maturity_date: str
    payout: str
    principal: str
    interest_so_far: str
    value_today: str
    maturity_value: str
    payout_amount: str | None
    matured: bool


DepositFigures = PpfFigures | RdFigures | FdFigures


def _fmt(value: Decimal) -> str:
    return f"{value + 0:.2f}"


def _transfers_in(moves: list[DepositMove]) -> list[Dated]:
    return [Dated(m.date, m.amount) for m in moves if m.kind == "in"]


def rd_months_recorded(account: Account, book: Book) -> int:
    return rd_months_paid(
        [m.date for m in book.deposit_moves.get(account.id, []) if m.kind == "in"]
    )


def rd_deposits_paid(account: Account, book: Book) -> int | None:
    if account.deposits_at_opening is None:
        return None
    return account.deposits_at_opening + rd_months_recorded(account, book)


def _ppf_figures(account: Account, book: Book, today: date) -> PpfFigures | None:
    if account.opened_on is None or account.interest_rate is None:
        return None
    moves = book.deposit_moves.get(account.id, [])
    signed = [Dated(m.date, -m.amount if m.kind == "out" else m.amount) for m in moves]
    year = financial_year(today)
    deposited = sum(
        (m.amount for m in moves if m.kind == "in" and financial_year(m.date) == year),
        Decimal(0),
    )
    rate = account.interest_rate
    opening = account.opening_balance
    created = account.created_at
    added_on = (created if created.tzinfo else created.replace(tzinfo=UTC)).astimezone(INDIA).date()
    due = ppf_interest_due(
        opening, signed, [m.date for m in moves if m.kind == "interest"], rate, added_on, today
    )
    return PpfFigures(
        kind="ppf",
        maturity_date=ppf_maturity(account.opened_on).isoformat(),
        deposited_this_year=_fmt(deposited),
        year_limit=_fmt(PPF_YEAR_LIMIT),
        interest_this_year=_fmt(ppf_year_interest(opening, signed, rate, year, today)),
        interest_due=None
        if due is None
        else PpfInterestDue(
            year=fy_label(due[0]), amount=_fmt(due[1]), date=date(due[0] + 1, 3, 31).isoformat()
        ),
    )


def _rd_figures(account: Account, book: Book, today: date) -> RdFigures | None:
    opened, amount, tenure = account.opened_on, account.deposit_amount, account.tenure_months
    rate, at_opening, due_day = account.interest_rate, account.deposits_at_opening, account.due_day
    if opened is None or amount is None or tenure is None or rate is None:
        return None
    if at_opening is None or due_day is None:
        return None
    moves = book.deposit_moves.get(account.id, [])
    transfers = _transfers_in(moves)
    paid = at_opening + rd_months_paid([t.date for t in transfers])
    maturity = rd_maturity(opened, tenure)
    recorded = sum((m.amount for m in moves if m.kind == "interest"), Decimal(0))
    # A closed RD earns nothing more and has nothing due.
    closed = account.archived_at is not None
    interest = (
        Decimal(0)
        if closed
        else rd_interest_so_far(
            rd_instalments(opened, amount, at_opening, transfers), rate, today, maturity, recorded
        )
    )
    return RdFigures(
        kind="rd",
        maturity_date=maturity.isoformat(),
        deposits_paid=paid,
        deposits_left=max(tenure - paid, 0),
        deposited=_fmt(sum((t.amount for t in transfers), Decimal(0)) + at_opening * amount),
        interest_so_far=_fmt(interest),
        value_today=_fmt(balance_of(account, book.flows) + interest),
        maturity_value=_fmt(rd_maturity_value(amount, rate, tenure)),
        due=[]
        if closed
        else [
            d.isoformat()
            for d in rd_due_months(
                opened, due_day, tenure, at_opening, [t.date for t in transfers], today
            )
        ],
    )


def _fd_figures(account: Account, book: Book, today: date) -> FdFigures | None:
    opened, maturity, rate = account.opened_on, account.matures_on, account.interest_rate
    payout = account.fd_payout
    if opened is None or maturity is None or rate is None or payout is None:
        return None
    moves = book.deposit_moves.get(account.id, [])
    # The opening balance is the principal placed on the opening date; transfers in add to it.
    principals = [Dated(opened, account.opening_balance), *_transfers_in(moves)]
    principals = [p for p in principals if p.amount > 0]
    principal = sum((p.amount for p in principals), Decimal(0))
    recorded = sum((m.amount for m in moves if m.kind == "interest"), Decimal(0))
    balance = balance_of(account, book.flows)
    # A closed or emptied FD earns nothing more; a payout FD's interest goes to the bank.
    earning = account.archived_at is None and balance > 0
    interest = (
        fd_interest_so_far(principals, rate, today, maturity, recorded)
        if earning and payout == "cumulative"
        else Decimal(0)
    )
    return FdFigures(
        kind="fd",
        maturity_date=maturity.isoformat(),
        payout=payout,
        principal=_fmt(principal),
        interest_so_far=_fmt(interest),
        value_today=_fmt(balance + interest),
        maturity_value=_fmt(
            fd_maturity_value(principals, rate, maturity) if payout == "cumulative" else principal
        ),
        payout_amount=None
        if (amount := fd_payout_amount(principal, rate, payout)) is None
        else _fmt(amount),
        matured=today >= maturity,
    )


def deposit_figures(account: Account, book: Book, today: date) -> DepositFigures | None:
    if account.type == "ppf":
        return _ppf_figures(account, book, today)
    if account.type == "rd":
        return _rd_figures(account, book, today)
    if account.type == "fd":
        return _fd_figures(account, book, today)
    return None


class DepositRow(NamedTuple):
    account: Account
    balance: Decimal
    figures: DepositFigures
    interest_estimate: Decimal


def deposit_rows(active: list[Account], book: Book, today: date) -> list[DepositRow]:
    """One row per active PPF, RD or FD, in the order `active` has them (balance and estimate)."""
    rows = []
    for account in active:
        figures = deposit_figures(account, book, today)
        if figures is None or account.archived_at is not None:
            continue
        estimate = figures.interest_this_year if figures.kind == "ppf" else figures.interest_so_far
        rows.append(
            DepositRow(account, balance_of(account, book.flows), figures, Decimal(estimate))
        )
    return rows


def with_deposits(summary: PortfolioTotals, rows: list[DepositRow]) -> PortfolioTotals:
    """Market totals with deposits counted at their balance: both invested and value rise by it,
    so unrealised is unchanged. Estimated interest is not counted."""
    held = sum((r.balance for r in rows), Decimal("0.00"))
    return PortfolioTotals(
        summary.invested + held, summary.value + held, summary.unrealised, summary.realised
    )
