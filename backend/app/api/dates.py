import calendar
from datetime import UTC, date, datetime, timedelta, timezone

INDIA = timezone(timedelta(hours=5, minutes=30))


def today_india() -> date:
    return datetime.now(UTC).astimezone(INDIA).date()


def clamped_date(year: int, month: int, day: int) -> date:
    """The given day of the month, or the month's last day if it has fewer days."""
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))
