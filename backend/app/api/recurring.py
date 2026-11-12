from collections.abc import Iterable
from datetime import date, timedelta
from typing import NamedTuple

from app.api.dates import clamped_date
from app.api.deposits import financial_year  # noqa: F401  (re-exported)

YEARLY_WINDOW_DAYS = 45


class TemplateRow(NamedTuple):
    id: int
    frequency: str
    day: int
    month: int | None
    start_date: date
    end_date: date | None
    remind_days: int
    active: bool


class Status(NamedTuple):
    due: list[date]
    coming_up: date | None


def occurrences(t: TemplateRow, upto: date) -> list[date]:
    """Every occurrence from the start date to `upto` (or the end date, if earlier)."""
    limit = min(upto, t.end_date) if t.end_date else upto
    found: list[date] = []
    if t.frequency == "yearly":
        month = t.month or t.start_date.month
        for year in range(t.start_date.year, limit.year + 1):
            found.append(clamped_date(year, month, t.day))
    else:
        index = t.start_date.year * 12 + t.start_date.month - 1
        while index <= limit.year * 12 + limit.month - 1:
            found.append(clamped_date(index // 12, index % 12 + 1, t.day))
            index += 1
    return [d for d in found if t.start_date <= d <= limit]


def _in_window(t: TemplateRow, occurrence: date, paid: date) -> bool:
    """A payment counts toward an occurrence in its usual window or in its reminder lead-up.

    Usual window: the same calendar month (monthly) or 45 days either side (yearly). Lead-up:
    `remind_days` before the occurrence, so a payment recorded from "Coming up" settles it.
    """
    before = (occurrence - paid).days
    if t.frequency == "yearly":
        return -YEARLY_WINDOW_DAYS <= before <= max(YEARLY_WINDOW_DAYS, t.remind_days)
    same_month = (paid.year, paid.month) == (occurrence.year, occurrence.month)
    return same_month or 0 < before <= t.remind_days


def is_recorded(t: TemplateRow, occurrence: date, paid: Iterable[date]) -> bool:
    return any(_in_window(t, occurrence, p) for p in paid)


def status(t: TemplateRow, paid: list[date], skips: set[date], today: date) -> Status:
    open_ = open_occurrences(t, paid, skips, today + timedelta(days=t.remind_days))
    due = [o for o in open_ if o <= today]
    coming = next((o for o in open_ if o > today), None)
    return Status(due, coming)


def open_occurrences(t: TemplateRow, paid: list[date], skips: set[date], upto: date) -> list[date]:
    """Occurrences up to `upto`, oldest first, that no payment settles and that aren't skipped.

    `status` looks `remind_days` ahead; the next-30-days list looks further with the same rules.
    """
    if not t.active:
        return []
    occs = occurrences(t, upto)
    settled: set[date] = set()
    for p in sorted(paid):
        candidates = [
            o for o in occs if o not in settled and o not in skips and _in_window(t, o, p)
        ]
        if candidates:
            # One payment settles one occurrence: its own month's when still open, else the
            # nearest (the earlier one on a tie). A skipped occurrence never takes a payment.
            settled.add(
                min(
                    candidates,
                    key=lambda o: ((o.year, o.month) != (p.year, p.month), abs((p - o).days), o),
                )
            )
    return [o for o in occs if o not in settled and o not in skips]


def card_bill_due(charge: date, statement_day: int, due_day: int) -> date:
    """The due date of the statement a charge lands on."""
    statement = clamped_date(charge.year, charge.month, statement_day)
    if statement < charge:
        statement = clamped_date(*_next_month(statement), statement_day)
    due = clamped_date(statement.year, statement.month, due_day)
    if due <= statement:
        due = clamped_date(*_next_month(statement), due_day)
    return due


def _next_month(day: date) -> tuple[int, int]:
    return (day.year + 1, 1) if day.month == 12 else (day.year, day.month + 1)
