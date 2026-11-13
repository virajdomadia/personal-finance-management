from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import cash_flow
from app.main import app
from app.models.transaction import Transaction
from tests.test_accounts import Headers, auth, make
from tests.test_transactions import post

client = TestClient(app)

URL = "/api/cash-flow"
TODAY = date(2026, 11, 12)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(cash_flow, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def account(headers: Headers, type_: str, **extra: Any) -> int:
    response = make(headers, type=type_, **extra)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def record(headers: Headers, day: str, type_: str, account_id: int, amount: str, **kw: Any) -> None:
    response = post(headers, date=day, type=type_, account_id=account_id, amount=amount, **kw)
    assert response.status_code == 201, response.json()


def summary(headers: Headers, **params: str) -> dict[str, Any]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def categories(headers: Headers) -> dict[str, int]:
    rows = client.get("/api/categories", headers=headers).json()["expense"]
    return {c["name"]: c["id"] for c in rows}


def setup_month(headers: Headers) -> int:
    """November to the 12th, and October around it. Returns the bank's id."""
    bank = account(headers, "bank", name="HDFC", bank_kind="savings", balance="100000.00")
    card = account(headers, "credit_card", name="Card", balance="0.00", credit_limit="50000.00")
    loan = account(headers, "loan", name="Car loan", balance="300000.00")
    record(headers, "2026-11-01", "income", bank, "80000.00", category="Salary")
    record(headers, "2026-11-03", "expense", bank, "6000.00", category="Groceries")
    record(headers, "2026-11-05", "expense", card, "1200.00", category="Swiggy")
    record(headers, "2026-11-05", "emi", bank, "12000.00", to_account_id=loan, interest="3000.00")
    record(headers, "2026-11-10", "transfer", bank, "20000.00", to_account_id=card)
    # October: the 1st to the 12th count for the comparison; the 20th does not.
    record(headers, "2026-10-01", "income", bank, "80000.00", category="Salary")
    record(headers, "2026-10-04", "expense", bank, "4000.00", category="Groceries")
    record(headers, "2026-10-20", "expense", bank, "9000.00", category="Travel")
    return bank


def test_month_totals_leave_out_transfers_and_emi_principal(headers: Headers) -> None:
    setup_month(headers)
    body = summary(headers)
    assert (body["month"], body["is_current"], body["through"]) == ("2026-11", True, "2026-11-12")
    assert (body["income"], body["spending"], body["net"]) == ("80000.00", "10200.00", "69800.00")
    assert body["transaction_count"] == 5


def test_compares_with_last_month_at_the_same_day(headers: Headers) -> None:
    setup_month(headers)
    body = summary(headers)
    assert body["previous"] == {
        "month": "2026-10",
        "start": "2026-10-01",
        "through": "2026-10-12",
        "income": "80000.00",
        "spending": "4000.00",
        "net": "76000.00",
    }
    assert body["spending_change"] == {"amount": "6200.00", "percent": 155}
    assert body["income_change"] == {"amount": "0.00", "percent": 0}
    assert body["net_change"] == {"amount": "-6200.00", "percent": -8}


def test_top_categories_and_rollup(headers: Headers) -> None:
    setup_month(headers)
    ids = categories(headers)
    client.patch(
        f"/api/categories/{ids['Swiggy']}",
        json={"parent_id": ids["Food and dining"]},
        headers=headers,
    )

    body = summary(headers)
    assert [(c["name"], c["amount"], c["percent"]) for c in body["top_spending"]] == [
        ("Groceries", "6000.00", 59),
        ("Loan interest", "3000.00", 29),
        ("Food and dining", "1200.00", 12),
    ]
    food = body["spending_by_category"][2]
    assert (food["direct"], food["icon"]) == ("0.00", "food")
    assert [(c["name"], c["amount"]) for c in food["children"]] == [("Swiggy", "1200.00")]
    assert body["top_spending"][2]["children"] == []
    assert [(c["name"], c["amount"]) for c in body["income_by_category"]] == [
        ("Salary", "80000.00")
    ]


def test_merging_shows_one_bucket(headers: Headers) -> None:
    bank = setup_month(headers)
    record(headers, "2026-11-06", "expense", bank, "300.00", category="Food and dining")
    ids = categories(headers)
    client.post(
        f"/api/categories/{ids['Swiggy']}/merge",
        json={"into_id": ids["Food and dining"]},
        headers=headers,
    )

    groups = summary(headers)["spending_by_category"]
    assert "Swiggy" not in [g["name"] for g in groups]
    food = next(g for g in groups if g["name"] == "Food and dining")
    assert food["amount"] == "1500.00"


def test_daily_spending(headers: Headers) -> None:
    setup_month(headers)
    daily = summary(headers)["daily"]
    assert len(daily) == 30
    assert daily[2] == {"date": "2026-11-03", "spent": "6000.00", "height": 100}
    assert daily[4] == {"date": "2026-11-05", "spent": "4200.00", "height": 70}
    assert daily[9]["spent"] == "0.00"
    assert daily[12] == {"date": "2026-11-13", "spent": None, "height": None}


def test_a_past_month_compares_whole_months(headers: Headers) -> None:
    setup_month(headers)
    body = summary(headers, month="2026-10")
    assert (body["is_current"], body["through"], body["spending"]) == (
        False,
        "2026-10-31",
        "13000.00",
    )
    assert body["previous"]["through"] == "2026-09-30"
    assert body["spending_change"]["percent"] is None
    assert (body["previous_month"], body["next_month"]) == (None, "2026-11")
    assert body["earliest_month"] == "2026-10"


def test_navigation_and_refusals(headers: Headers) -> None:
    body = summary(headers)
    assert (body["previous_month"], body["next_month"], body["earliest_month"]) == (
        None,
        None,
        None,
    )
    assert body["spending"] == "0.00" and body["top_spending"] == []
    assert client.get(URL, params={"month": "2026-12"}, headers=headers).status_code == 422
    assert client.get(URL, params={"month": "2026-13"}, headers=headers).status_code == 422


def test_uncategorised_sms_money_counts(headers: Headers, db_session: Session) -> None:
    bank = account(headers, "bank", name="HDFC", bank_kind="savings", balance="1000.00")
    record(headers, "2026-11-02", "expense", bank, "40.00", category="Other")
    tx = db_session.scalars(select(Transaction)).one()
    tx.category, tx.source = None, "sms"
    db_session.commit()
    top = summary(headers)["top_spending"][0]
    assert (top["name"], top["id"], top["amount"]) == ("Uncategorised", None, "40.00")


def test_other_users_money_is_private(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_month(headers)
    other = auth(db_session, monkeypatch, "other@example.com")
    assert summary(other)["spending"] == "0.00"


def test_unauthenticated() -> None:
    assert client.get(URL).status_code == 401
