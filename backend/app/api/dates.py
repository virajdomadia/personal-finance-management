import calendar
import re
from datetime import UTC, date, datetime, timedelta, timezone
from typing import Any

from pydantic_core import PydanticCustomError

INDIA = timezone(timedelta(hours=5, minutes=30))


def now_india() -> datetime:
    return datetime.now(UTC).astimezone(INDIA)


def today_india() -> date:
    return now_india().date()


def clamped_date(year: int, month: int, day: int) -> date:
    """The given day of the month, or the month's last day if it has fewer days."""
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


_ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
DATE_MESSAGE = "Enter a date, like 2026-01-15."


def iso_date(value: Any) -> date | None:
    """A pydantic `BeforeValidator` for a YYYY-MM-DD string; None passes through."""
    if value is None:
        return None
    if not isinstance(value, str) or not _ISO_DATE.fullmatch(value):
        raise PydanticCustomError("date", DATE_MESSAGE)
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise PydanticCustomError("date", DATE_MESSAGE) from None
