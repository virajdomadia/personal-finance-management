from datetime import UTC, date, datetime, timedelta, timezone

INDIA = timezone(timedelta(hours=5, minutes=30))


def today_india() -> date:
    return datetime.now(UTC).astimezone(INDIA).date()
