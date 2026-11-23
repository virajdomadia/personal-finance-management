from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.reminder_payments import fixed_payment_ids
from app.api.routes import calendar, funds, recurring, sips, transactions
from app.main import app
from app.models.user import User
from tests.test_accounts import Headers, auth
from tests.test_fund_trades import bank, fund
from tests.test_recurring import made, record
from tests.test_sips import made as made_sip

client = TestClient(app)

TODAY = date(2026, 11, 12)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (recurring, transactions, calendar, funds, sips):
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


URL = "/api/calendar"


def month(headers: Headers, **params: str) -> dict[str, Any]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def owner_setup(headers: Headers) -> int:
    """Salary, rent, PPF as reminders and a SIP plan, all from HDFC. Returns HDFC's id."""
    hdfc = bank(headers, "100000.00", "HDFC")
    ppf = bank(headers, "0.00", "PPF")
    made(headers, hdfc, name="Salary", type="income", amount="54800.00", day=1, category="Salary")
    rent(headers, hdfc)
    made(
        headers,
        hdfc,
        name="PPF",
        type="transfer",
        amount="3000.00",
        day=10,
        to_account_id=ppf,
        category=None,
    )
    made_sip(headers, fund(headers), hdfc, amount="5000.00", day=7, start_date="2026-10-07")
    return hdfc


def test_owners_month(headers: Headers) -> None:
    owner_setup(headers)
    data = month(headers)
    assert data["month"] == "2026-11"
    assert data["is_current"] is True
    assert (data["income"], data["fixed_out"]) == ("54800.00", "24000.00")
    assert data["free"] == "30800.00"
    assert data["per_day"] == "1026.67"
    assert len(data["fixed"]) == 4
    assert [f["kind"] for f in data["fixed"]] == ["income", "out", "out", "out"]
    assert "sip" in [f["source"] for f in data["fixed"]]
    assert len(data["days"]) == 30


def test_rent_day_not_red(headers: Headers) -> None:
    hdfc = owner_setup(headers)
    recorded(headers, hdfc, "2026-11-05")  # the rent, paid outside the reminder
    response = record(headers, hdfc, "2026-11-05", amount="600.00", category="Groceries")
    assert response.status_code == 201, response.json()
    data = month(headers)
    day5 = data["days"][4]
    assert day5 == {"date": "2026-11-05", "spent": "600.00", "over": False}
    assert data["spent"] == "600.00"
    assert data["left"] == "30200.00"
    assert data["pace"] == "11720.04"  # 1026.67 x 12 - 600


def test_no_income_reminder(headers: Headers) -> None:
    rent(headers, bank(headers, "100000.00", "HDFC"))
    data = month(headers)
    assert data["per_day"] is None
    assert data["pace"] is None
    assert all(d["over"] is None for d in data["days"])


def test_yearly_reminder_ignored(headers: Headers) -> None:
    hdfc = owner_setup(headers)
    made(headers, hdfc, name="Insurance", amount="12000.00", frequency="yearly", month=3, day=1)
    assert month(headers)["fixed_out"] == "24000.00"


def test_future_month_refused(headers: Headers) -> None:
    response = client.get(URL, params={"month": "2026-12"}, headers=headers)
    assert response.status_code == 422
    assert "That month hasn't started yet." in str(response.json())


def test_past_month_full(headers: Headers) -> None:
    owner_setup(headers)
    data = month(headers, month="2026-10")
    assert data["is_current"] is False
    assert len(data["days"]) == 31
    assert all(d["spent"] is not None for d in data["days"])
    assert data["next_month"] == "2026-11"


def test_other_users_data_hidden(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    owner_setup(headers)
    other = auth(db_session, monkeypatch, email="other@example.com")
    data = month(other)
    assert data["fixed"] == []
    assert data["free"] == "0.00"


def stop(headers: Headers, reminder_id: int) -> None:
    response = client.patch(
        f"/api/recurring/{reminder_id}", json={"active": False}, headers=headers
    )
    assert response.status_code == 200, response.json()


def test_stopping_rent_keeps_earlier_months(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    made(
        headers,
        hdfc,
        name="Salary",
        type="income",
        amount="54800.00",
        day=1,
        category="Salary",
        start_date="2026-10-01",
    )
    reminder = made(headers, hdfc, amount="16000.00", day=5, start_date="2026-10-01")
    recorded(headers, hdfc, "2026-10-05", recurring_template_id=reminder["id"])
    stop(headers, reminder["id"])
    october = month(headers, month="2026-10")
    assert october["fixed_out"] == "16000.00"
    assert october["days"][4]["spent"] == "0.00"
    assert month(headers)["fixed_out"] == "0.00"  # gone from November on


def test_rent_paid_then_stopped_this_month(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    reminder = made(headers, hdfc, amount="16000.00", day=5, start_date="2026-10-01")
    recorded(headers, hdfc, "2026-11-05", recurring_template_id=reminder["id"])
    stop(headers, reminder["id"])
    november = month(headers)
    assert november["fixed_out"] == "16000.00"
    assert november["days"][4]["spent"] == "0.00"


def test_payment_of_a_reminder_not_counted_this_month_is_not_spending(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    reminder = made(headers, hdfc, amount="16000.00", day=5, start_date="2026-10-01")
    recorded(headers, hdfc, "2026-10-05", recurring_template_id=reminder["id"])
    stop(headers, reminder["id"])
    # Paid once more by hand in November after stopping: still not everyday spending.
    recorded(headers, hdfc, "2026-11-05", recurring_template_id=reminder["id"])
    assert month(headers)["days"][4]["spent"] == "0.00"


def test_marks_on_the_month(headers: Headers) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    made(headers, hdfc, name="Salary", type="income", amount="54800.00", day=1, category="Salary")
    reminder = rent(headers, hdfc)
    made(headers, hdfc, name="Premium", amount="12000.00", frequency="yearly", month=3, day=10)
    recorded(headers, hdfc, "2026-11-05", recurring_template_id=reminder["id"])
    marks = month(headers)["marks"]
    assert [(m["date"], m["name"], m["state"]) for m in marks] == [
        ("2026-11-01", "Salary", "due"),
        ("2026-11-05", "Rent", "paid"),
    ]
    assert marks[1] == {
        "date": "2026-11-05",
        "template_id": reminder["id"],
        "name": "Rent",
        "amount": "16000.00",
        "kind": "out",
        "state": "paid",
    }


def test_rent_paid_early_then_stopped_counts_in_its_month(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    hdfc = bank(headers, "100000.00", "HDFC")
    reminder = made(headers, hdfc, amount="16000.00", day=1, start_date="2026-10-01")
    recorded(headers, hdfc, "2026-10-01", recurring_template_id=reminder["id"])
    recorded(headers, hdfc, "2026-10-30", recurring_template_id=reminder["id"])  # for 1 Nov
    stop(headers, reminder["id"])
    assert month(headers)["fixed_out"] == "16000.00"  # November's rent was paid
