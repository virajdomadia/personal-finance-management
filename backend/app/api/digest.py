"""The weekly digest's own rules: which week, the usual figure, "on pace to go over" and the
headline. Rules: docs/architecture/financial-calculations.md, "Weekly digest".

Spending itself is `app.api.cash_flow`'s and budget figures are `app.api.budgets`', so the digest
always agrees with the month report and the budgets page.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

from app.api.routes.accounts import rupees

ZERO = Decimal(0)
PAISA = Decimal("0.01")
WEEK = timedelta(days=7)
# From this time on a Sunday the week ending that day is the default one.
SUNDAY_READY = time(18, 0)
USUAL_WEEKS = 4
# A difference within this many percent reads as "about the same as usual".
ABOUT_THE_SAME = 5
# On pace: used more than this many points above the share of the month gone, and at least half.
PACE_MARGIN = 10
PACE_FLOOR = 50
MONTHS = (
    "January February March April May June July August September October November December"
).split()


def monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def default_week(now: datetime) -> date:
    """The Monday of the last whole week; a Sunday is whole from 6 pm."""
    today = now.date()
    this = monday(today)
    if today.weekday() == 6 and now.time() >= SUNDAY_READY:
        return this
    return this - WEEK


@dataclass(frozen=True)
class Week:
    start: date  # Monday
    through: date  # the last day counted: Sunday, or today for this week so far

    @property
    def end(self) -> date:
        return self.start + timedelta(days=6)

    @property
    def complete(self) -> bool:
        return self.through == self.end


def week_of(start: date, today: date) -> Week:
    return Week(start, min(start + timedelta(days=6), today))


def earlier(week: Week, earliest: date | None) -> list[Week]:
    """Up to 4 weeks before, each over the same days; only weeks ending on or after the first
    transaction count."""
    if earliest is None:
        return []
    days = week.through - week.start
    found = []
    for n in range(1, USUAL_WEEKS + 1):
        start = week.start - n * WEEK
        if start + timedelta(days=6) >= earliest:
            found.append(Week(start, start + days))
    return found


def average(amounts: Sequence[Decimal]) -> Decimal | None:
    if not amounts:
        return None
    return (sum(amounts, ZERO) / len(amounts)).quantize(PAISA, rounding=ROUND_HALF_UP)


def label(start: date, today: date) -> str:
    this = monday(today)
    if start == this:
        return "this week"
    if start == this - WEEK:
        return "last week"
    return f"the week of {start.day} {MONTHS[start.month - 1]}"


def on_pace(spent: Decimal, amount: Decimal, days: int, days_in_month: int) -> bool:
    """50% ≤ used < 100% and used > elapsed + 10 points, in exact arithmetic:
    spent ÷ amount > days ÷ days_in_month + 10 ÷ 100."""
    if days >= days_in_month or amount <= 0 or spent >= amount:
        return False
    if spent * 100 < amount * PACE_FLOOR:
        return False
    return spent * 100 * days_in_month > amount * (100 * days + PACE_MARGIN * days_in_month)


def projected(spent: Decimal, days: int, days_in_month: int) -> Decimal:
    """The month's spending at the pace so far."""
    return (spent * days_in_month / days).quantize(PAISA, rounding=ROUND_HALF_UP)


def headline(
    spending: Decimal,
    usual: Decimal | None,
    change_percent: int | None,
    week_label: str,
    so_far: bool,
) -> str:
    comparison = ""
    if usual is not None and spending > 0:
        difference = spending - usual
        if difference == 0 or (
            change_percent is not None and abs(change_percent) <= ABOUT_THE_SAME
        ):
            comparison = ", about the same as usual"
        else:
            more = "more" if difference > 0 else "less"
            comparison = f", {rupees(abs(difference))} {more} than usual"
        if so_far:
            comparison += " by now"
    if so_far:
        if spending == 0:
            return "You haven't spent anything so far this week."
        return f"So far this week you've spent {rupees(spending)}{comparison}."
    when = week_label if week_label in ("this week", "last week") else f"in {week_label}"
    if spending == 0:
        return f"You didn't spend anything {when}."
    return f"You spent {rupees(spending)} {when}{comparison}."
