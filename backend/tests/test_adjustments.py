"""Dated balance adjustments: correcting an account's balance records a dated entry with a reason,
instead of rewriting the opening balance, so the figures before it keep their history."""

from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.main import app
from app.models.account import Account
from tests.test_accounts import Headers, auth, locs, make

client = TestClient(app)

URL = "/api/transactions"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def days_ago(n: int) -> str:
    return (today_india() - timedelta(days=n)).isoformat()


def account(headers: Headers, type_: str = "bank", balance: str = "10000.00", **extra: Any) -> int:
    if type_ == "bank":
        extra.setdefault("bank_kind", "savings")
    response = make(headers, type=type_, name=extra.pop("name", "HDFC"), balance=balance, **extra)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def spend(headers: Headers, account_id: int, amount: str, day: str) -> int:
    body = {
        "type": "expense",
        "account_id": account_id,
        "amount": amount,
        "date": day,
        "category": "Groceries",
    }
    response = client.post(URL, json=body, headers=headers)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def correct(headers: Headers, account_id: int, balance: str, **fields: Any) -> Response:
    body = {"balance": balance, **fields}
    return client.patch(f"/api/accounts/{account_id}", json=body, headers=headers)


def adjustments(headers: Headers) -> list[dict[str, Any]]:
    listed = client.get(URL, params={"type": "adjustment"}, headers=headers).json()
    return listed["transactions"]


def opening(db: Session, account_id: int) -> Decimal:
    db.expire_all()
    row = db.get(Account, account_id)
    assert row is not None
    return row.opening_balance


def message(response: Response) -> str:
    assert response.status_code == 422, response.json()
    return response.json()["detail"][0]["msg"]


# Correcting a balance


def test_a_correction_is_a_dated_adjustment_and_keeps_the_opening(
    headers: Headers, db_session: Session
) -> None:
    b = account(headers)
    spend(headers, b, "1000.00", days_ago(3))
    response = correct(headers, b, "9230.00", balance_reason="Interest I missed")
    assert response.status_code == 200, response.json()
    assert response.json()["balance"] == "9230.00"
    assert opening(db_session, b) == Decimal("10000.00")
    [adj] = adjustments(headers)
    assert (adj["amount"], adj["date"], adj["note"]) == (
        "230.00",
        today_india().isoformat(),
        "Interest I missed",
    )
    assert (adj["account_id"], adj["category"]) == (b, None)


def test_a_lower_balance_is_a_negative_adjustment(headers: Headers) -> None:
    b = account(headers)
    spend(headers, b, "1000.00", days_ago(3))
    assert correct(headers, b, "8800.00", balance_reason="Bank charges").status_code == 200
    assert adjustments(headers)[0]["amount"] == "-200.00"


def test_an_adjustment_needs_a_reason(headers: Headers) -> None:
    b = account(headers)
    spend(headers, b, "1000.00", days_ago(3))
    response = correct(headers, b, "9230.00")
    assert locs(response) == [["body", "balance_reason"]]
    assert message(response) == "Say why the balance changed."
    assert adjustments(headers) == []


def test_as_of_a_past_day_corrects_that_day_and_keeps_what_came_after(headers: Headers) -> None:
    # On the day before the ₹1,000 purchase the balance was really ₹9,500, not ₹10,000.
    b = account(headers)
    spend(headers, b, "1000.00", days_ago(3))
    response = correct(headers, b, "9500.00", balance_date=days_ago(4), balance_reason="Statement")
    assert response.status_code == 200, response.json()
    assert response.json()["balance"] == "8500.00"
    [adj] = adjustments(headers)
    assert (adj["amount"], adj["date"]) == ("-500.00", days_ago(4))


def test_the_as_of_day_cant_be_in_the_future(headers: Headers) -> None:
    b = account(headers)
    spend(headers, b, "1000.00", days_ago(3))
    tomorrow = (today_india() + timedelta(days=1)).isoformat()
    response = correct(headers, b, "9000.00", balance_date=tomorrow, balance_reason="x")
    assert locs(response) == [["body", "balance_date"]]


def test_a_card_correction_changes_what_is_owed(headers: Headers) -> None:
    card = account(headers, "credit_card", "2000.00", name="Card", credit_limit="50000.00")
    spend(headers, card, "500.00", days_ago(2))  # owes 2,500
    response = correct(headers, card, "2300.00", balance_reason="Statement")
    assert response.status_code == 200, response.json()
    assert response.json()["balance"] == "2300.00"
    # Money into the card: it owes ₹200 less.
    assert adjustments(headers)[0]["amount"] == "200.00"


def test_an_account_with_nothing_recorded_just_changes_its_opening(
    headers: Headers, db_session: Session
) -> None:
    b = account(headers)
    response = correct(headers, b, "12000.00")  # fixing a typo: no reason needed
    assert response.status_code == 200, response.json()
    assert opening(db_session, b) == Decimal("12000.00")
    assert adjustments(headers) == []


def test_the_same_balance_records_nothing(headers: Headers) -> None:
    b = account(headers)
    spend(headers, b, "1000.00", days_ago(3))
    assert correct(headers, b, "9000.00", name="HDFC Bank").status_code == 200
    assert adjustments(headers) == []


def test_a_correction_cant_take_cash_below_zero(headers: Headers) -> None:
    cash = account(headers, "cash", "500.00", name="Wallet cash")
    spend(headers, cash, "100.00", days_ago(1))
    response = correct(headers, cash, "-10.00", balance_reason="x")
    assert locs(response) == [["body", "balance"]]


# An adjustment is neither income nor spending


def test_an_adjustment_is_not_income_or_spending(headers: Headers) -> None:
    b = account(headers)
    spend(headers, b, "1000.00", days_ago(3))
    correct(headers, b, "9500.00", balance_reason="Cashback I missed")
    month = today_india().strftime("%Y-%m")
    listed = client.get(URL, params={"month": month}, headers=headers).json()
    if days_ago(3)[:7] == month:
        assert listed["total_expense"] == "1000.00"
    assert listed["total_income"] == "0.00"
    flow = client.get("/api/cash-flow", headers=headers).json()
    assert flow["income"] == "0.00"


# As a transaction


def test_deleting_an_adjustment_puts_the_balance_back(headers: Headers) -> None:
    b = account(headers)
    spend(headers, b, "1000.00", days_ago(3))
    correct(headers, b, "9230.00", balance_reason="x")
    [adj] = adjustments(headers)
    assert client.delete(f"{URL}/{adj['id']}", headers=headers).status_code == 200
    accounts = client.get("/api/accounts", headers=headers).json()["accounts"]
    assert next(a for a in accounts if a["id"] == b)["balance"] == "9000.00"


def test_an_adjustment_posted_directly_follows_the_same_rules(headers: Headers) -> None:
    b = account(headers)
    body = {"type": "adjustment", "account_id": b, "date": days_ago(1)}
    ok = client.post(URL, json={**body, "amount": "-50.00", "note": "Cash count"}, headers=headers)
    assert ok.status_code == 201, ok.json()
    assert (ok.json()["amount"], ok.json()["category"]) == ("-50.00", None)
    assert message(
        client.post(URL, json={**body, "amount": "0.00", "note": "x"}, headers=headers)
    ) == ("An adjustment can't be ₹0.")
    no_reason = client.post(URL, json={**body, "amount": "10.00"}, headers=headers)
    assert locs(no_reason) == [["body", "note"]]
    assert message(no_reason) == "Say why the balance changed."
    with_category = client.post(
        URL, json={**body, "amount": "10.00", "note": "x", "category": "Groceries"}, headers=headers
    )
    assert locs(with_category) == [["body", "category"]]


def test_only_an_adjustment_can_be_negative(headers: Headers) -> None:
    b = account(headers)
    body = {"type": "expense", "account_id": b, "date": days_ago(1), "category": "Groceries"}
    response = client.post(URL, json={**body, "amount": "-50.00"}, headers=headers)
    assert message(response) == "Amount must be greater than 0."
