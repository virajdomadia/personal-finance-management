from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import app
from app.models.sms import SmsEntry
from app.models.transaction import Transaction
from tests.test_accounts import Headers, auth
from tests.test_transactions import account, post

client = TestClient(app)

URL = "/api/transactions"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def add(headers: Headers, day: str, amount: str, category: str, **kw: Any) -> int:
    type_ = kw.pop("type", "expense")
    account_id = kw.pop("account_id")
    response = post(
        headers,
        type=type_,
        date=day,
        account_id=account_id,
        amount=amount,
        category=category,
        **kw,
    )
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def search(headers: Headers, **params: Any) -> dict[str, Any]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def notes(headers: Headers, **params: Any) -> list[str | None]:
    return [t["note"] for t in search(headers, **params)["transactions"]]


@pytest.fixture
def book(headers: Headers, db_session: Session) -> dict[str, int]:
    cash = account(headers, "cash", "10000.00", name="Wallet cash")
    bank = account(headers, "bank", "50000.00", name="HDFC")
    ids = {
        "plumber": add(headers, "2026-09-02", "800.00", "Housing", account_id=cash, note="Plumber"),
        "plumber2": add(
            headers, "2026-10-15", "650.00", "Housing", account_id=bank, note="plumber, kitchen"
        ),
        "chai": add(
            headers, "2026-10-20", "20.00", "Food and dining", account_id=cash, note="Chai"
        ),
        "salary": add(headers, "2026-10-31", "80000.00", "Salary", type="income", account_id=bank),
        "percent": add(headers, "2026-11-01", "99.00", "Shopping", account_id=bank, note="50% off"),
    }
    sms_tx = add(headers, "2026-11-02", "300.00", "Shopping", account_id=bank, note=None)
    db_session.add(
        SmsEntry(
            user_id=db_session.get(Transaction, sms_tx).user_id,  # type: ignore[union-attr]
            hash="h1",
            sender="HDFCBK",
            bank="hdfc",
            kind="debit",
            amount=300,
            occurred_on=db_session.get(Transaction, sms_tx).date,  # type: ignore[union-attr]
            payee="Ramesh Plumbing Works",
            status="recorded",
            transaction_id=sms_tx,
        )
    )
    db_session.commit()
    ids["sms"] = sms_tx
    ids["cash"], ids["bank"] = cash, bank
    return ids


def test_text_finds_notes_and_payees_newest_first(headers: Headers, book: dict[str, int]) -> None:
    found = search(headers, q="PLUMB")["transactions"]
    assert [t["id"] for t in found] == [book["sms"], book["plumber2"], book["plumber"]]


def test_text_also_finds_categories(headers: Headers, book: dict[str, int]) -> None:
    assert notes(headers, q="dining") == ["Chai"]


def test_like_characters_are_literal(headers: Headers, book: dict[str, int]) -> None:
    assert notes(headers, q="50%") == ["50% off"]
    assert notes(headers, q="_") == []


def test_date_range(headers: Headers, book: dict[str, int]) -> None:
    assert notes(headers, date_from="2026-10-01", date_to="2026-10-20") == [
        "Chai",
        "plumber, kitchen",
    ]
    response = client.get(
        URL, params={"date_from": "2026-10-02", "date_to": "2026-10-01"}, headers=headers
    )
    assert response.status_code == 422


def test_amount_range(headers: Headers, book: dict[str, int]) -> None:
    assert notes(headers, amount_min="600", amount_max="800.00") == [
        "plumber, kitchen",
        "Plumber",
    ]
    assert client.get(URL, params={"amount_min": "-1"}, headers=headers).status_code == 422
    assert client.get(URL, params={"amount_min": "1.234"}, headers=headers).status_code == 422
    bad = client.get(URL, params={"amount_min": "10", "amount_max": "5"}, headers=headers)
    assert bad.status_code == 422


def test_account_type_and_category_combine(headers: Headers, book: dict[str, int]) -> None:
    body = search(headers, q="plumb", account_id=book["cash"])
    assert [t["note"] for t in body["transactions"]] == ["Plumber"]
    assert body["total_expense"] == "800.00"
    assert notes(headers, type="income") == [None]
    assert notes(headers, category="housing") == ["plumber, kitchen", "Plumber"]


def test_category_includes_subcategories(headers: Headers, book: dict[str, int]) -> None:
    cats = client.get("/api/categories", headers=headers).json()["expense"]
    ids = {c["name"]: c["id"] for c in cats}
    client.patch(
        f"/api/categories/{ids['Housing']}", json={"parent_id": ids["Shopping"]}, headers=headers
    )
    assert len(notes(headers, category="Shopping")) == 4
    assert notes(headers, category="Housing") == ["plumber, kitchen", "Plumber"]


def test_uncategorised(headers: Headers, book: dict[str, int], db_session: Session) -> None:
    tx = db_session.get(Transaction, book["chai"])
    assert tx is not None
    tx.category, tx.source = None, "sms"
    db_session.commit()
    assert notes(headers, category="Uncategorised") == ["Chai"]


def test_totals_cover_every_match(headers: Headers, book: dict[str, int]) -> None:
    body = search(headers, q="plumb", limit=1)
    assert len(body["transactions"]) == 1
    assert body["has_more"] is True
    assert body["total_expense"] == "1750.00"


def test_search_is_private(
    headers: Headers, book: dict[str, int], db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = auth(db_session, monkeypatch, "other@example.com")
    assert search(other, q="plumb")["transactions"] == []
