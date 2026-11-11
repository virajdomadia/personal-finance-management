from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import streak
from app.api.routes.streak import streak_days
from app.main import app
from app.models.transaction import Transaction
from app.models.user import User
from tests.test_accounts import Headers, auth, make

client = TestClient(app)
D = date(2026, 11, 11)


def test_empty() -> None:
    assert streak_days(set(), D) == 0


def test_today_only() -> None:
    assert streak_days({D}, D) == 1


def test_yesterday_keeps_streak() -> None:
    assert streak_days({D - timedelta(1), D - timedelta(2)}, D) == 2


def test_gap_resets() -> None:
    assert streak_days({D, D - timedelta(2)}, D) == 1


def test_two_days_ago_is_broken() -> None:
    assert streak_days({D - timedelta(2)}, D) == 0


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(streak, "today_india", lambda: D)
    return auth(db_session, monkeypatch)


def add_tx(
    db: Session, headers: Headers, created_at: datetime, email: str = "me@example.com"
) -> None:
    account = make(headers).json()["id"]
    uid = db.scalars(select(User.id).where(User.email == email)).one()
    db.add(
        Transaction(
            user_id=uid,
            type="expense",
            amount=10,
            date=D,
            account_id=account,
            category="Groceries",
            created_at=created_at,
        )
    )
    db.commit()


def test_endpoint_uses_india_date(headers: Headers, db_session: Session) -> None:
    # 2026-11-10T18:30:00Z is 2026-11-11 00:00 IST, so it counts for the 11th.
    add_tx(db_session, headers, datetime(2026, 11, 10, 18, 30, tzinfo=UTC))
    assert client.get("/api/streak", headers=headers).json() == {"days": 1}


def test_endpoint_counts_consecutive_days(headers: Headers, db_session: Session) -> None:
    add_tx(db_session, headers, datetime(2026, 11, 10, 18, 30, tzinfo=UTC))
    add_tx(db_session, headers, datetime(2026, 11, 10, 12, 0, tzinfo=UTC))
    assert client.get("/api/streak", headers=headers).json() == {"days": 2}


def test_other_users_transactions_ignored(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = auth(db_session, monkeypatch, "other@example.com")
    add_tx(db_session, other, datetime(2026, 11, 11, 5, 0, tzinfo=UTC), "other@example.com")
    assert client.get("/api/streak", headers=headers).json() == {"days": 0}


def test_requires_a_session() -> None:
    assert client.get("/api/streak").status_code == 401
