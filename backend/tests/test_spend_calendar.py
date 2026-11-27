from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes import calendar, recurring, transactions
from app.main import app
from tests.test_accounts import Headers, auth
from tests.test_fund_trades import bank
from tests.test_recurring import made, record

client = TestClient(app)

TODAY = date(2026, 11, 12)
URL = "/api/calendar"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (recurring, transactions, calendar):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def month(headers: Headers, **params: str) -> dict[str, Any]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def recorded(headers: Headers, account: int, day: str, amount: str, **fields: Any) -> None:
    response = record(headers, account, day, amount=amount, **fields)
    assert response.status_code == 201, response.json()


def test_a_day_is_spent_less_received(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    recorded(headers, hdfc, "2026-11-03", "8000.00", category="Groceries")
    recorded(headers, hdfc, "2026-11-03", "4000.00", type="income", category="Salary")
    data = month(headers)
    assert data["month"] == "2026-11"
    assert data["is_current"] is True
    assert data["through"] == "2026-11-12"
    assert len(data["days"]) == 30
    assert data["days"][2] == {"date": "2026-11-03", "net": "4000.00"}
    assert data["days"][1] == {"date": "2026-11-02", "net": "0.00"}
    assert data["days"][12] == {"date": "2026-11-13", "net": None}


def test_salary_day_shows_what_came_in(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    recorded(headers, hdfc, "2026-11-01", "80000.00", type="income", category="Salary")
    recorded(headers, hdfc, "2026-11-01", "8000.00", category="Groceries")
    assert month(headers)["days"][0]["net"] == "-72000.00"


def test_rent_through_a_reminder_counts(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    rent = made(headers, hdfc, amount="16000.00", day=5, remind_days=3)
    recorded(headers, hdfc, "2026-11-05", "16000.00", recurring_template_id=rent["id"])
    assert month(headers)["days"][4]["net"] == "16000.00"


def test_transfers_count_nothing(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    ppf = bank(headers, "0.00", "PPF")
    recorded(
        headers, hdfc, "2026-11-10", "3000.00", type="transfer", to_account_id=ppf, category=None
    )
    assert month(headers)["days"][9]["net"] == "0.00"


def test_only_the_calendar_fields(headers: Headers) -> None:
    assert set(month(headers)) == {
        "month",
        "is_current",
        "through",
        "days",
        "previous_month",
        "next_month",
    }


def test_future_month_refused(headers: Headers) -> None:
    response = client.get(URL, params={"month": "2026-12"}, headers=headers)
    assert response.status_code == 422
    assert "That month hasn't started yet." in str(response.json())


def test_past_month_full(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    recorded(headers, hdfc, "2026-10-04", "500.00", category="Groceries")
    data = month(headers, month="2026-10")
    assert data["is_current"] is False
    assert len(data["days"]) == 31
    assert all(d["net"] is not None for d in data["days"])
    assert data["days"][3]["net"] == "500.00"
    assert data["next_month"] == "2026-11"
    assert data["previous_month"] is None  # nothing recorded before October


def test_other_users_data_hidden(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    recorded(headers, hdfc, "2026-11-03", "8000.00", category="Groceries")
    other = auth(db_session, monkeypatch, email="other@example.com")
    assert all(d["net"] in ("0.00", None) for d in month(other)["days"])
