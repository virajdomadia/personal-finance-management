"""Card statements: each statement's total and minimum due, entered by hand or read from an SMS,
and where its bill stands: paid, partly paid, the minimum paid, overdue, or overpaid."""

from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.main import app
from app.models.card_statement import CardStatement
from tests.test_accounts import Headers, auth, locs, make
from tests.test_sms_ingest import entry, send

client = TestClient(app)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def day(n: int) -> str:
    """`n` days from today: negative for the past."""
    return (today_india() + timedelta(days=n)).isoformat()


def card(headers: Headers, **fields: Any) -> int:
    body = {"name": "Regalia", "balance": "0.00", "credit_limit": "100000.00", "last4": "9876"}
    response = make(headers, type="credit_card", **{**body, **fields})
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def bank(headers: Headers) -> int:
    response = make(headers, type="bank", name="HDFC", bank_kind="savings", balance="100000.00")
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def add(headers: Headers, card_id: int, **fields: Any) -> Response:
    body = {
        "statement_date": day(-5),
        "total_due": "15000.00",
        "minimum_due": "1500.00",
        "due_date": day(15),
        **fields,
    }
    return client.post(f"/api/accounts/{card_id}/statements", json=body, headers=headers)


def added(headers: Headers, card_id: int, **fields: Any) -> dict[str, Any]:
    response = add(headers, card_id, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def statements(headers: Headers, card_id: int) -> dict[str, Any]:
    response = client.get(f"/api/accounts/{card_id}/statements", headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def pay(headers: Headers, from_id: int, card_id: int, amount: str, on: str) -> None:
    body = {
        "type": "transfer",
        "account_id": from_id,
        "to_account_id": card_id,
        "amount": amount,
        "date": on,
    }
    response = client.post("/api/transactions", json=body, headers=headers)
    assert response.status_code == 201, response.json()


def spend(headers: Headers, card_id: int, amount: str, on: str) -> None:
    body = {
        "type": "expense",
        "account_id": card_id,
        "amount": amount,
        "date": on,
        "category": "Shopping",
    }
    response = client.post("/api/transactions", json=body, headers=headers)
    assert response.status_code == 201, response.json()


def standing(headers: Headers, card_id: int) -> tuple[Any, ...]:
    current = statements(headers, card_id)["current"]
    return (current["status"], current["paid"], current["left"], current["extra"])


def message(response: Response) -> str:
    assert response.status_code == 422, response.json()
    return response.json()["detail"][0]["msg"]


# Entering a statement


def test_a_statement_entered_by_hand(headers: Headers) -> None:
    c = card(headers)
    body = added(headers, c)
    assert body == {
        "id": body["id"],
        "account_id": c,
        "statement_date": day(-5),
        "total_due": "15000.00",
        "minimum_due": "1500.00",
        "due_date": day(15),
        "source": "manual",
    }
    listed = statements(headers, c)
    assert [s["id"] for s in listed["statements"]] == [body["id"]]
    assert listed["current"]["statement"]["id"] == body["id"]


def test_the_newest_statement_is_the_current_one(headers: Headers) -> None:
    c = card(headers)
    older = added(headers, c, statement_date=day(-35), due_date=day(-15))
    newer = added(headers, c)
    listed = statements(headers, c)
    assert [s["id"] for s in listed["statements"]] == [newer["id"], older["id"]]
    assert listed["current"]["statement"]["id"] == newer["id"]


def test_a_card_without_statements_has_no_current_one(headers: Headers) -> None:
    c = card(headers)
    listed = statements(headers, c)
    assert (listed["statements"], listed["current"], listed["unbilled"]) == ([], None, "0.00")


def test_statement_rules(headers: Headers) -> None:
    c = card(headers)
    assert message(add(headers, c, minimum_due="16000.00")) == (
        "The minimum can't be more than the total."
    )
    assert locs(add(headers, c, due_date=day(-6))) == [["body", "due_date"]]
    assert locs(add(headers, c, statement_date=day(1), due_date=day(20))) == [
        ["body", "statement_date"]
    ]
    assert locs(add(headers, c, total_due="-1.00")) == [["body", "total_due"]]
    assert add(headers, c, minimum_due=None).status_code == 201  # a minimum is optional
    again = add(headers, c)
    assert again.status_code == 409
    assert again.json()["detail"] == f"Regalia already has a statement dated {day(-5)}."


def test_only_your_own_card_has_statements(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    b = bank(headers)
    response = add(headers, b)
    assert response.status_code == 409
    assert response.json()["detail"] == "Only a credit card has statements."
    other = auth(db_session, monkeypatch, email="other@example.com")
    theirs = card(other)
    assert add(headers, theirs).status_code == 404
    assert client.get(f"/api/accounts/{theirs}/statements", headers=headers).status_code == 404


def test_editing_and_deleting_a_statement(headers: Headers) -> None:
    c = card(headers)
    s = added(headers, c)
    url = f"/api/card-statements/{s['id']}"
    changed = client.patch(url, json={"total_due": "14000.00"}, headers=headers)
    assert changed.status_code == 200, changed.json()
    assert (changed.json()["total_due"], changed.json()["minimum_due"]) == ("14000.00", "1500.00")
    assert client.delete(url, headers=headers).status_code == 200
    assert statements(headers, c)["statements"] == []
    assert client.delete(url, headers=headers).status_code == 404


# Where the bill stands


def test_a_bill_moves_from_unpaid_to_paid(headers: Headers) -> None:
    c, b = card(headers), bank(headers)
    added(headers, c)  # ₹15,000, minimum ₹1,500, due in 15 days
    assert standing(headers, c) == ("unpaid", "0.00", "15000.00", "0.00")
    pay(headers, b, c, "1000.00", day(-3))
    assert standing(headers, c) == ("part_paid", "1000.00", "14000.00", "0.00")
    pay(headers, b, c, "500.00", day(-2))
    assert standing(headers, c) == ("minimum_paid", "1500.00", "13500.00", "0.00")
    pay(headers, b, c, "13500.00", day(-1))
    assert standing(headers, c) == ("paid", "15000.00", "0.00", "0.00")
    pay(headers, b, c, "500.00", day(0))
    # The extra is still the card's: it counts toward the next bill.
    assert standing(headers, c) == ("paid", "15500.00", "0.00", "500.00")


def test_a_payment_before_the_statement_doesnt_count(headers: Headers) -> None:
    c, b = card(headers), bank(headers)
    added(headers, c)
    pay(headers, b, c, "2000.00", day(-6))
    assert standing(headers, c) == ("unpaid", "0.00", "15000.00", "0.00")


def test_a_bill_past_its_due_date_is_overdue_until_paid(headers: Headers) -> None:
    c, b = card(headers), bank(headers)
    added(headers, c, statement_date=day(-25), due_date=day(-5))
    assert statements(headers, c)["current"]["overdue"] is True
    pay(headers, b, c, "15000.00", day(-1))
    assert statements(headers, c)["current"]["overdue"] is False


def test_spending_since_the_statement_is_unbilled(headers: Headers) -> None:
    c = card(headers)
    added(headers, c)  # dated 5 days ago
    spend(headers, c, "700.00", day(-6))  # on this statement already
    spend(headers, c, "1200.00", day(-4))
    spend(headers, c, "300.00", day(-1))
    assert statements(headers, c)["unbilled"] == "1500.00"


# From an SMS


def test_a_statement_sms_records_a_statement(headers: Headers, db_session: Session) -> None:
    c = card(headers)
    body = entry(
        kind="card_statement",
        last4="9876",
        amount="15000.00",
        minimum_due="1500.00",
        date=day(-5),
        due_date=day(15),
        payee=None,
    )
    assert send(headers, body).status_code == 200
    [s] = statements(headers, c)["statements"]
    assert (s["total_due"], s["minimum_due"], s["due_date"], s["source"]) == (
        "15000.00",
        "1500.00",
        day(15),
        "sms",
    )
    # The same statement read again updates it, rather than adding another.
    again = {k: v for k, v in body.items() if k != "hash"}  # another message, so another hash
    send(headers, entry(**{**again, "amount": "15100.00"}))
    assert [x["total_due"] for x in statements(headers, c)["statements"]] == ["15100.00"]


def test_a_statement_entered_by_hand_wins_over_the_sms(headers: Headers) -> None:
    c = card(headers)
    added(headers, c, total_due="14000.00", minimum_due="1400.00")
    body = entry(
        kind="card_statement",
        last4="9876",
        amount="15000.00",
        date=day(-5),
        due_date=day(15),
        payee=None,
    )
    send(headers, body)
    [s] = statements(headers, c)["statements"]
    assert (s["total_due"], s["source"]) == ("14000.00", "manual")


def test_editing_an_sms_statement_makes_it_yours(headers: Headers, db_session: Session) -> None:
    c = card(headers)
    send(
        headers,
        entry(
            kind="card_statement",
            last4="9876",
            amount="15000.00",
            date=day(-5),
            due_date=day(15),
            payee=None,
        ),
    )
    [s] = statements(headers, c)["statements"]
    url = f"/api/card-statements/{s['id']}"
    changed = client.patch(url, json={"minimum_due": "750.00"}, headers=headers)
    assert changed.json()["source"] == "manual"
    db_session.expire_all()
    row = db_session.scalar(select(CardStatement).where(CardStatement.id == s["id"]))
    assert row is not None and row.minimum_due == Decimal("750.00")


# Reminders


def test_the_dashboard_bill_comes_from_the_statement(headers: Headers) -> None:
    c, b = card(headers), bank(headers)
    added(headers, c)
    pay(headers, b, c, "1000.00", day(-1))
    bill = client.get("/api/dashboard", headers=headers).json()["card_bill"]
    assert bill == {
        "account_id": c,
        "name": "Regalia",
        "amount": "14000.00",
        "minimum_left": "500.00",
        "due_date": day(15),
    }
