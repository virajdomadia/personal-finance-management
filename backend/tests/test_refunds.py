"""Refunds: money back for a purchase. A refund lowers its category's spending instead of counting
as income, and may be linked to the purchase it refunds."""

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import budgets, cash_flow
from app.main import app
from app.models.account import Account
from app.models.transaction import Transaction
from tests.test_accounts import Headers, auth, locs, make

client = TestClient(app)

URL = "/api/transactions"
TODAY = date(2026, 11, 12)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(cash_flow, "today_india", lambda: TODAY)
    monkeypatch.setattr(budgets, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def bank(headers: Headers, balance: str = "10000.00", name: str = "HDFC") -> int:
    response = make(headers, type="bank", name=name, bank_kind="savings", balance=balance)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def post(headers: Headers, **fields: Any) -> Response:
    return client.post(URL, json={"date": "2026-11-05", **fields}, headers=headers)


def made(headers: Headers, **fields: Any) -> dict[str, Any]:
    response = post(headers, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def purchase(headers: Headers, account_id: int, amount: str = "2000.00", **fields: Any) -> int:
    body = {"type": "expense", "account_id": account_id, "amount": amount, "category": "Shopping"}
    return made(headers, **{**body, **fields})["id"]


def refund(headers: Headers, account_id: int, amount: str = "500.00", **fields: Any) -> Response:
    return post(headers, type="refund", account_id=account_id, amount=amount, **fields)


def balance(headers: Headers, account_id: int) -> str:
    accounts = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a for a in accounts if a["id"] == account_id)["balance"]


def get(headers: Headers, id_: int) -> dict[str, Any]:
    response = client.get(f"{URL}/{id_}", headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def message(response: Response) -> str:
    assert response.status_code == 422, response.json()
    return response.json()["detail"][0]["msg"]


# Recording


def test_a_refund_brings_money_back_and_names_a_spending_category(headers: Headers) -> None:
    b = bank(headers)
    created = refund(headers, b, category="Shopping")
    assert created.status_code == 201, created.json()
    body = created.json()
    assert (body["type"], body["category"], body["refund_of_id"]) == ("refund", "Shopping", None)
    assert balance(headers, b) == "10500.00"


def test_an_unlinked_refund_needs_a_spending_category(headers: Headers) -> None:
    b = bank(headers)
    assert message(refund(headers, b)) == "Choose a category."


def test_a_refund_has_no_second_account_or_interest(headers: Headers) -> None:
    b, other = bank(headers), bank(headers, name="SBI")
    assert locs(refund(headers, b, category="Shopping", to_account_id=other)) == [
        ["body", "to_account_id"]
    ]
    assert locs(refund(headers, b, category="Shopping", interest="1.00")) == [["body", "interest"]]


def test_only_a_refund_links_to_a_purchase(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b)
    response = post(
        headers, type="income", account_id=b, amount="10.00", category="Salary", refund_of_id=bought
    )
    assert message(response) == "Only a refund links to a purchase."


# Linking to the purchase


def test_a_linked_refund_takes_the_purchase_category(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b, category="Groceries")
    body = refund(headers, b, refund_of_id=bought).json()
    assert (body["category"], body["refund_of_id"]) == ("Groceries", bought)
    assert get(headers, bought)["refunded"] == "500.00"
    assert message(refund(headers, b, refund_of_id=bought, category="Travel")) == (
        "A linked refund takes its purchase's category."
    )


def test_a_purchase_can_be_refunded_in_parts_but_not_beyond_it(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b, amount="2000.00")
    assert refund(headers, b, "1500.00", refund_of_id=bought).status_code == 201
    assert message(refund(headers, b, "600.00", refund_of_id=bought)) == (
        "Only ₹500 of this purchase is left to refund."
    )
    assert refund(headers, b, "500.00", refund_of_id=bought).status_code == 201
    assert get(headers, bought)["refunded"] == "2000.00"


def test_a_refund_cant_come_before_its_purchase(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b, date="2026-11-05")
    response = refund(headers, b, refund_of_id=bought, date="2026-11-04")
    assert message(response) == "A refund can't be dated before its purchase."


def test_a_refund_links_only_to_your_own_purchase(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    b = bank(headers)
    income = made(headers, type="income", account_id=b, amount="10.00", category="Salary")
    other = auth(db_session, monkeypatch, email="other@example.com")
    theirs = purchase(other, bank(other))
    for target in (income["id"], theirs, 999999):
        assert message(refund(headers, b, refund_of_id=target)) == "Choose the purchase refunded."


def test_a_refund_can_land_on_another_account(headers: Headers) -> None:
    # Bought on the card, refunded to the bank: it still links.
    b = bank(headers)
    card = make(headers, type="credit_card", name="Card", balance="0.00").json()["id"]
    bought = purchase(headers, card)
    assert refund(headers, b, refund_of_id=bought).status_code == 201
    assert (balance(headers, card), balance(headers, b)) == ("2000.00", "10500.00")


# Changing the purchase


def test_a_purchase_cant_drop_below_what_was_refunded(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b, amount="2000.00")
    refund(headers, b, "1500.00", refund_of_id=bought)
    response = client.patch(f"{URL}/{bought}", json={"amount": "1000.00"}, headers=headers)
    assert message(response) == "₹1,500 of this purchase is already refunded."
    ok = client.patch(f"{URL}/{bought}", json={"amount": "1500.00"}, headers=headers)
    assert ok.status_code == 200, ok.json()


def test_a_new_category_on_the_purchase_moves_its_refunds(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b, category="Shopping")
    returned = refund(headers, b, refund_of_id=bought).json()["id"]
    response = client.patch(f"{URL}/{bought}", json={"category": "Groceries"}, headers=headers)
    assert response.status_code == 200, response.json()
    assert get(headers, returned)["category"] == "Groceries"


def test_deleting_the_purchase_keeps_its_refunds_unlinked(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b)
    returned = refund(headers, b, refund_of_id=bought).json()["id"]
    assert client.delete(f"{URL}/{bought}", headers=headers).status_code == 200
    kept = get(headers, returned)
    assert (kept["refund_of_id"], kept["category"]) == (None, "Shopping")
    assert balance(headers, b) == "10500.00"


def test_an_expense_shows_nothing_refunded_until_one_is(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b)
    assert get(headers, bought)["refunded"] is None
    income = made(headers, type="income", account_id=b, amount="10.00", category="Salary")
    assert income["refunded"] is None


# Reports


def test_a_refund_lowers_spending_not_raises_income(headers: Headers) -> None:
    b = bank(headers)
    made(headers, type="income", account_id=b, amount="50000.00", category="Salary")
    bought = purchase(headers, b, amount="2000.00", category="Shopping")
    refund(headers, b, "500.00", refund_of_id=bought, date="2026-11-08")

    month = client.get("/api/cash-flow", params={"month": "2026-11"}, headers=headers).json()
    assert (month["income"], month["spending"]) == ("50000.00", "1500.00")
    shopping = next(c for c in month["spending_by_category"] if c["name"] == "Shopping")
    assert shopping["amount"] == "1500.00"

    listed = client.get(URL, params={"month": "2026-11"}, headers=headers).json()
    assert (listed["total_income"], listed["total_expense"]) == ("50000.00", "1500.00")
    assert listed["expense_by_category"] == [{"category": "Shopping", "amount": "1500.00"}]


def test_a_refund_counts_in_the_month_it_arrives(headers: Headers) -> None:
    b = bank(headers)
    bought = purchase(headers, b, amount="2000.00", date="2026-10-20")
    refund(headers, b, "500.00", refund_of_id=bought, date="2026-11-03")
    october = client.get("/api/cash-flow", params={"month": "2026-10"}, headers=headers).json()
    november = client.get("/api/cash-flow", params={"month": "2026-11"}, headers=headers).json()
    assert (october["spending"], november["spending"]) == ("2000.00", "-500.00")


def test_a_refund_frees_its_budget(headers: Headers) -> None:
    b = bank(headers)
    rows = client.get("/api/categories", headers=headers).json()["expense"]
    shopping = next(c["id"] for c in rows if c["name"] == "Shopping")
    put = client.put(f"/api/budgets/{shopping}", json={"amount": "1800.00"}, headers=headers)
    assert put.status_code == 200, put.json()
    bought = purchase(headers, b, amount="2000.00", category="Shopping")
    line = next(x for x in client.get("/api/budgets", headers=headers).json()["budgets"])
    assert line["over"] is True
    refund(headers, b, "500.00", refund_of_id=bought)
    line = next(x for x in client.get("/api/budgets", headers=headers).json()["budgets"])
    assert (line["spent"], line["over"]) == ("1500.00", False)


def test_refunds_lower_the_emergency_fund_monthly_spend(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import goals

    monkeypatch.setattr(goals, "today_india", lambda: TODAY)
    b = bank(headers)
    uid = db_session.scalar(select(Account.user_id).where(Account.id == b))
    for month in range(6, 11):  # June to October: ₹10,000 spent, then ₹1,000 back in October
        db_session.add(
            Transaction(
                user_id=uid,
                type="expense",
                amount=Decimal("10000.00"),
                date=date(2026, month, 2),
                account_id=b,
                category="Shopping",
            )
        )
    db_session.add(
        Transaction(
            user_id=uid,
            type="refund",
            amount=Decimal("1000.00"),
            date=date(2026, 10, 9),
            account_id=b,
            category="Shopping",
        )
    )
    db_session.commit()
    body = client.post(
        "/api/goals", json={"name": "Emergency fund", "kind": "emergency"}, headers=headers
    ).json()
    # June is the first month and not a full one, so July to October: (40,000 - 1,000) / 4.
    assert body["ef"]["computed"] == "9750.00"


# Suggestions


def test_refundable_purchases_suggest_what_a_refund_could_be(headers: Headers) -> None:
    b = bank(headers, balance="50000.00")
    small = purchase(headers, b, amount="300.00", date="2026-11-01")
    big = purchase(headers, b, amount="2000.00", date="2026-11-02", note="Shoes")
    done = purchase(headers, b, amount="900.00", date="2026-11-03")
    refund(headers, b, "900.00", refund_of_id=done)
    made(headers, type="income", account_id=b, amount="900.00", category="Salary")

    response = client.get(
        f"{URL}/refundable", params={"amount": "500.00", "date": "2026-11-10"}, headers=headers
    )
    assert response.status_code == 200, response.json()
    found = response.json()["purchases"]
    # Too small and fully refunded purchases are left out; income never shows.
    assert [p["id"] for p in found] == [big]
    assert found[0] == {
        "id": big,
        "date": "2026-11-02",
        "amount": "2000.00",
        "left": "2000.00",
        "category": "Shopping",
        "account_id": b,
        "account_name": "HDFC",
        "note": "Shoes",
    }
    assert small not in [p["id"] for p in found]
