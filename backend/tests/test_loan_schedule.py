"""A loan's repayment schedule, worked out from what's owed today, the rate and the EMI."""

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.loans import ScheduleRow, schedule_rows
from app.main import app
from tests.test_accounts import Headers, auth, make
from tests.test_loans import loan

client = TestClient(app)

NEVER = "This EMI doesn't cover the monthly interest, so the loan never gets paid off."


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def d(text: str) -> Decimal:
    return Decimal(text)


def test_small_loan_rows() -> None:
    rows, problem = schedule_rows(d("1000"), d("12"), d("600"), date(2026, 12, 1), 5)
    assert problem is None
    assert rows == [
        ScheduleRow(
            date(2026, 12, 1), date(2026, 12, 5), d("600.00"), d("10.00"), d("590.00"), d("410.00")
        ),
        ScheduleRow(
            date(2027, 1, 1), date(2027, 1, 5), d("414.10"), d("4.10"), d("410.00"), d("0.00")
        ),
    ]


def test_home_loan_first_rows() -> None:
    rows, _ = schedule_rows(d("1000000"), d("8.5"), d("25000"), date(2026, 12, 1), 5)
    assert (rows[0].interest, rows[0].principal, rows[0].left) == (
        d("7083.33"),
        d("17916.67"),
        d("982083.33"),
    )
    assert rows[1].interest == d("6956.42")


def test_never_pays_off() -> None:
    assert schedule_rows(d("1000000"), d("12"), d("9000"), date(2026, 12, 1), 5) == ([], NEVER)
    assert schedule_rows(d("1000000"), d("12"), d("10000"), date(2026, 12, 1), 5) == ([], NEVER)


def test_interest_free() -> None:
    rows, problem = schedule_rows(d("1000"), d("0"), d("300"), date(2026, 12, 1), 5)
    assert problem is None
    assert len(rows) == 4
    assert all(r.interest == 0 for r in rows)
    assert rows[-1].amount == d("100.00")


def test_runs_past_cap() -> None:
    assert schedule_rows(d("1000000"), d("0"), d("100"), date(2026, 12, 1), 5) == (
        [],
        "This schedule runs past 50 years. Check the EMI and the rate.",
    )


def test_due_day_clamps() -> None:
    rows, _ = schedule_rows(d("1000"), d("12"), d("600"), date(2027, 2, 1), 31)
    assert rows[0].due == date(2027, 2, 28)
    rows, _ = schedule_rows(d("1000"), d("12"), d("600"), date(2027, 2, 1), None)
    assert rows[0].due is None


def schedule(headers: Headers, id: int) -> Any:
    return client.get(f"/api/accounts/{id}/schedule", headers=headers)


def small_loan(headers: Headers, **fields: Any) -> int:
    body = {
        "balance": "1000.00",
        "interest_rate": "12",
        "emi_amount": "600.00",
        "due_day": 5,
        **fields,
    }
    return loan(headers, **body)["id"]


def month_of(day: date) -> str:
    return day.isoformat()[:7]


def next_month(day: date) -> date:
    return (day.replace(day=1) + timedelta(days=32)).replace(day=1)


def test_schedule_route(headers: Headers, db_session: Session) -> None:
    id_ = small_loan(headers)
    added(db_session, id_, today_india().replace(day=1))  # before this month's due day
    response = schedule(headers, id_)
    assert response.status_code == 200, response.json()
    body = response.json()
    today = today_india()
    assert (body["paid_off"], body["problem"], body["emis_left"]) == (False, None, 2)
    assert (body["interest_left"], body["total_left"]) == ("14.10", "1014.10")
    assert body["rows"][0]["month"] == month_of(today)
    assert body["ends"] == month_of(next_month(today))
    assert body["rows"][0] == {
        "month": month_of(today),
        "due": today.replace(day=5).isoformat(),
        "amount": "600.00",
        "interest": "10.00",
        "principal": "590.00",
        "left": "410.00",
    }


def test_route_starts_next_month_after_this_months_emi(
    headers: Headers, db_session: Session
) -> None:
    bank = make(headers, type="bank", name="HDFC", bank_kind="savings", balance="50000.00").json()[
        "id"
    ]
    id_ = small_loan(headers, balance="2000.00")
    added(db_session, id_, today_india().replace(day=1))  # so only the EMI moves it
    assert schedule(headers, id_).json()["rows"][0]["month"] == month_of(today_india())
    paid = client.post(
        "/api/transactions",
        json={
            "type": "emi",
            "date": today_india().isoformat(),
            "account_id": bank,
            "to_account_id": id_,
            "amount": "600.00",
            "interest": "20.00",
        },
        headers=headers,
    )
    assert paid.status_code == 201, paid.json()
    assert schedule(headers, id_).json()["rows"][0]["month"] == month_of(next_month(today_india()))


def test_route_problems(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    no_rate = schedule(headers, loan(headers, balance="1000.00", emi_amount="600.00")["id"]).json()
    assert (no_rate["problem"], no_rate["rows"]) == (
        "Add the interest rate to see the schedule.",
        [],
    )
    no_emi = schedule(headers, loan(headers, balance="1000.00", interest_rate="12")["id"]).json()
    assert no_emi["problem"] == "Add the EMI to see the schedule."
    done = schedule(headers, small_loan(headers, balance="0.00")).json()
    assert (done["paid_off"], done["problem"], done["rows"]) == (True, None, [])
    bank = make(headers, type="bank", name="SBI", bank_kind="savings", balance="10.00").json()["id"]
    refused = schedule(headers, bank)
    assert refused.status_code == 422
    assert "Only a loan has a repayment schedule." in str(refused.json())
    mine = small_loan(headers)
    other = auth(db_session, monkeypatch, email="other@example.com")
    assert schedule(other, mine).status_code == 404


# Review fixes


def pin_today(monkeypatch: pytest.MonkeyPatch, day: date) -> None:
    from app.api.routes import accounts as accounts_route

    monkeypatch.setattr(accounts_route, "today_india", lambda: day)


def added(db: Session, id_: int, day: date) -> None:
    from datetime import UTC, datetime

    from app.models.account import Account

    row = db.get(Account, id_)
    assert row is not None
    row.created_at = datetime(day.year, day.month, day.day, 6, 0, tzinfo=UTC)  # noon in India
    db.commit()


def test_loan_added_after_this_months_due_day_starts_next_month(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    pin_today(monkeypatch, date(2026, 12, 20))
    id_ = small_loan(headers)
    added(db_session, id_, date(2026, 12, 20))  # typed in after the 5 Dec EMI
    assert schedule(headers, id_).json()["rows"][0]["due"] == "2027-01-05"


def test_loan_added_before_this_months_due_day_still_owes_it(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    pin_today(monkeypatch, date(2026, 12, 20))
    id_ = small_loan(headers)
    added(db_session, id_, date(2026, 12, 1))
    assert schedule(headers, id_).json()["rows"][0]["due"] == "2026-12-05"  # unpaid, still owed


def test_no_due_day_ignores_last_months_late_emi(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    pin_today(monkeypatch, date(2026, 12, 3))
    bank = make(headers, type="bank", name="HDFC", bank_kind="savings", balance="50000.00").json()[
        "id"
    ]
    id_ = loan(headers, balance="2000.00", interest_rate="12", emi_amount="600.00")["id"]
    paid = client.post(
        "/api/transactions",
        json={
            "type": "emi",
            "date": "2026-11-25",
            "account_id": bank,
            "to_account_id": id_,
            "amount": "600.00",
            "interest": "20.00",
        },
        headers=headers,
    )
    assert paid.status_code == 201, paid.json()
    assert schedule(headers, id_).json()["rows"][0]["month"] == "2026-12"
