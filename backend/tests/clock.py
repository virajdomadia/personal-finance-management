"""Pin the app's India-time clock for a test.

A module that sets `TODAY = today_india()` at import and compares it with what the app works out
during a request goes wrong when the run crosses midnight in India: the module keeps the old day
and the app moves on. Pinning the clock to that same day keeps both sides on it.

Every `today_india()` in the app calls `app.api.dates.now_india` at call time, so patching that one
function pins them all, however the caller imported `today_india`.
"""

from datetime import date, datetime, time

import pytest

from app.api import dates


def pin_india_today(monkeypatch: pytest.MonkeyPatch, day: date) -> None:
    """Make `today_india()` return `day` (and `now_india()` noon on it) for the rest of the test."""
    noon = datetime.combine(day, time(12), tzinfo=dates.INDIA)
    monkeypatch.setattr(dates, "now_india", lambda: noon)
