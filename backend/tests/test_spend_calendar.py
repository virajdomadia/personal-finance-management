from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.reminder_payments import fixed_payment_ids
from app.api.routes import recurring, transactions
from app.main import app
from app.models.user import User
from tests.test_accounts import Headers, auth
from tests.test_fund_trades import bank
from tests.test_recurring import made, record

client = TestClient(app)

TODAY = date(2026, 11, 12)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (recurring, transactions):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def user_id(db: Session, email: str = "me@example.com") -> int:
    return db.scalars(select(User.id).where(User.email == email)).one()


def rent(headers: Headers, account: int) -> dict[str, Any]:
    return made(headers, account, amount="16000.00", day=5, remind_days=3)


def recorded(headers: Headers, account: int, day: str, **fields: Any) -> int:
    response = record(headers, account, day, amount="16000.00", **fields)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def test_linked_payment_is_fixed(headers: Headers, db_session: Session) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    reminder = rent(headers, hdfc)
    paid = recorded(headers, hdfc, "2026-11-05", recurring_template_id=reminder["id"])
    assert fixed_payment_ids(db_session, user_id(db_session), {reminder["id"]}) == {paid}


def test_matched_unlinked_payment_is_fixed(headers: Headers, db_session: Session) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    sbi = bank(headers, "100000.00", "SBI")
    reminder = rent(headers, hdfc)
    paid = recorded(headers, hdfc, "2026-11-05")
    recorded(headers, sbi, "2026-11-05")  # same amount, another account: not the rent
    assert fixed_payment_ids(db_session, user_id(db_session), {reminder["id"]}) == {paid}


def test_two_same_day_payments_one_reminder(headers: Headers, db_session: Session) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    reminder = rent(headers, hdfc)
    first = recorded(headers, hdfc, "2026-11-05")
    recorded(headers, hdfc, "2026-11-05")
    assert fixed_payment_ids(db_session, user_id(db_session), {reminder["id"]}) == {first}


def test_only_the_asked_reminders(headers: Headers, db_session: Session) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    reminder = rent(headers, hdfc)
    recorded(headers, hdfc, "2026-11-05", recurring_template_id=reminder["id"])
    assert fixed_payment_ids(db_session, user_id(db_session), set()) == set()
