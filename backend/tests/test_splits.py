"""Split transactions: one expense split across several of the owner's own categories."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import app
from app.models.account import Account
from tests.test_accounts import Headers, auth
from tests.test_adjustments import account, days_ago, spend

client = TestClient(app)
TX = "/api/transactions"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def rows(headers: Headers) -> list[dict[str, Any]]:
    return client.get(TX, headers=headers).json()["transactions"]


def test_unsplit_has_no_tag(headers: Headers) -> None:
    tx = spend(headers, account(headers), "3000.00", days_ago(1))
    assert client.get(f"{TX}/{tx}", headers=headers).json()["split"] is None
    assert [r["split"] for r in rows(headers)] == [None]


def split(headers: Headers, tx: int, *parts: tuple[str, str]) -> Any:
    body = {"parts": [{"category": c, "amount": a} for c, a in parts]}
    return client.put(f"{TX}/{tx}/split", json=body, headers=headers)


def bill(headers: Headers) -> tuple[int, int]:
    """A ₹3,000 Groceries bill on a ₹10,000 bank. Returns (bank, bill)."""
    bank = account(headers, balance="10000.00")
    return bank, spend(headers, bank, "3000.00", days_ago(1))


def balance(headers: Headers, bank: int) -> str:
    listed = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a for a in listed if a["id"] == bank)["balance"]


def test_split_into_two(headers: Headers) -> None:
    bank, tx = bill(headers)
    response = split(headers, tx, ("Groceries", "2200.00"), ("Household", "800.00"))
    assert response.status_code == 200, response.json()
    body = response.json()
    assert body["id"] == tx and body["total"] == "3000.00"
    assert [p["amount"] for p in body["parts"]] == ["2200.00", "800.00"]
    assert body["parts"][0]["id"] == tx
    tags = sorted(
        (r["split"]["part"], r["split"]["parts"], r["split"]["id"]) for r in rows(headers)
    )
    assert tags == [(1, 2, tx), (2, 2, tx)]
    assert balance(headers, bank) == "7000.00"


def test_cash_flow_counts_each_category(headers: Headers) -> None:
    _, tx = bill(headers)
    split(headers, tx, ("Groceries", "2200.00"), ("Household", "800.00"))
    month = days_ago(1)[:7]
    flow = client.get("/api/cash-flow", params={"month": month}, headers=headers).json()
    by_name = {s["name"]: s["amount"] for s in flow["spending_by_category"]}
    assert (by_name["Groceries"], by_name["Household"]) == ("2200.00", "800.00")


def test_resplit_and_undo(headers: Headers) -> None:
    bank, tx = bill(headers)
    split(headers, tx, ("Groceries", "1000.00"), ("Household", "1000.00"), ("Shopping", "1000.00"))
    assert split(headers, tx, ("Groceries", "2000.00"), ("Shopping", "1000.00")).status_code == 200
    assert len(rows(headers)) == 2
    assert split(headers, tx, ("Groceries", "3000.00")).status_code == 200
    assert [(r["id"], r["amount"], r["split"]) for r in rows(headers)] == [(tx, "3000.00", None)]
    assert balance(headers, bank) == "7000.00"


def test_parts_must_add_up(headers: Headers) -> None:
    _, tx = bill(headers)
    response = split(headers, tx, ("Groceries", "2000.00"), ("Household", "800.00"))
    assert response.status_code == 422
    assert "The parts add up to ₹2,800; the bill is ₹3,000." in str(response.json())


def test_only_expenses(headers: Headers) -> None:
    bank = account(headers)
    income = client.post(
        TX,
        json={
            "type": "income",
            "account_id": bank,
            "amount": "500.00",
            "date": days_ago(1),
            "category": "Salary",
        },
        headers=headers,
    ).json()["id"]
    response = split(headers, income, ("Salary", "250.00"), ("Salary", "250.00"))
    assert response.status_code == 422
    assert "Only an expense can be split." in str(response.json())


def test_zero_part_refused(headers: Headers) -> None:
    _, tx = bill(headers)
    response = split(headers, tx, ("Groceries", "3000.00"), ("Household", "0.00"))
    assert response.status_code == 422


def test_refund_follows_removed_part(headers: Headers) -> None:
    bank, tx = bill(headers)
    parts = split(headers, tx, ("Groceries", "2200.00"), ("Household", "800.00")).json()["parts"]
    refund = client.post(
        TX,
        json={
            "type": "refund",
            "account_id": bank,
            "amount": "100.00",
            "date": days_ago(0),
            "refund_of_id": parts[1]["id"],
        },
        headers=headers,
    )
    assert refund.status_code == 201, refund.json()
    assert split(headers, tx, ("Groceries", "3000.00")).status_code == 200
    got = client.get(f"{TX}/{refund.json()['id']}", headers=headers).json()
    assert got["refund_of_id"] == tx


def test_archived_account_refused(headers: Headers, db_session: Session) -> None:
    bank, tx = bill(headers)
    db_session.get(Account, bank).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
    db_session.commit()
    assert split(headers, tx, ("Groceries", "2200.00"), ("Household", "800.00")).status_code == 409


def test_get_split_from_a_part(headers: Headers) -> None:
    _, tx = bill(headers)
    parts = split(headers, tx, ("Groceries", "2200.00"), ("Household", "800.00")).json()["parts"]
    got = client.get(f"{TX}/{parts[1]['id']}/split", headers=headers).json()
    assert got["id"] == tx and [p["category"] for p in got["parts"]] == ["Groceries", "Household"]


def split_bill(headers: Headers) -> tuple[int, int, int]:
    """(bank, original, part 2) of a ₹3,000 bill split 2,200 / 800."""
    bank, tx = bill(headers)
    parts = split(headers, tx, ("Groceries", "2200.00"), ("Household", "800.00")).json()["parts"]
    return bank, tx, parts[1]["id"]


def test_part_category_and_note_editable(headers: Headers) -> None:
    _, _, part = split_bill(headers)
    body = {"category": "Personal care", "note": "soap"}
    response = client.patch(f"{TX}/{part}", json=body, headers=headers)
    assert response.status_code == 200, response.json()
    assert (response.json()["category"], response.json()["note"]) == ("Personal care", "soap")


def test_part_amount_date_account_refused(headers: Headers) -> None:
    bank, tx, part = split_bill(headers)
    other = account(headers, name="SBI")
    changes = [
        {"amount": "500.00"},
        {"date": days_ago(3)},
        {"account_id": other},
    ]
    for target in (tx, part):
        for change in changes:
            response = client.patch(f"{TX}/{target}", json=change, headers=headers)
            assert response.status_code == 422, (target, change, response.json())
            assert "Change the split instead." in str(response.json())
    assert balance(headers, bank) == "7000.00"


def test_delete_part_refused(headers: Headers) -> None:
    _, _, part = split_bill(headers)
    response = client.delete(f"{TX}/{part}", headers=headers)
    assert response.status_code == 409
    assert "Change the split instead." in str(response.json())


def test_delete_original_deletes_parts(headers: Headers) -> None:
    bank, tx, _ = split_bill(headers)
    assert client.delete(f"{TX}/{tx}", headers=headers).status_code == 200
    assert rows(headers) == []
    assert balance(headers, bank) == "10000.00"


def test_sms_after_split_links_original(headers: Headers, db_session: Session) -> None:
    from tests.test_sms_ingest import bank as sms_bank
    from tests.test_sms_ingest import entry, manual, send, stored, transactions

    b = sms_bank(headers)
    typed = manual(
        headers,
        type="expense",
        account_id=b,
        amount="3000.00",
        date=days_ago(0),
        category="Groceries",
    )
    split(headers, typed, ("Groceries", "2200.00"), ("Household", "800.00"))
    body = entry(amount="3000.00", payee="DMart", date=days_ago(0))
    assert send(headers, body).json()["results"][0]["status"] == "recorded"
    assert stored(db_session, body["hash"]).transaction_id == typed
    assert len(transactions(db_session)) == 2
    assert balance(headers, b) == "7000.00"


# Review fixes


def test_split_refuses_a_part_below_its_refunds(headers: Headers) -> None:
    bank, tx = bill(headers)
    refund = client.post(
        TX,
        json={
            "type": "refund",
            "account_id": bank,
            "amount": "2500.00",
            "date": days_ago(0),
            "refund_of_id": tx,
        },
        headers=headers,
    )
    assert refund.status_code == 201, refund.json()
    response = split(headers, tx, ("Groceries", "2200.00"), ("Household", "800.00"))
    assert response.status_code == 422
    assert "already refunded" in str(response.json())
    assert [r["amount"] for r in rows(headers) if r["type"] == "expense"] == ["3000.00"]


def test_sms_for_part_one_amount_is_not_the_split_bill(
    headers: Headers, db_session: Session
) -> None:
    from tests.test_sms_ingest import bank as sms_bank
    from tests.test_sms_ingest import entry, manual, send, stored, transactions

    b = sms_bank(headers)
    typed = manual(
        headers,
        type="expense",
        account_id=b,
        amount="3000.00",
        date=days_ago(0),
        category="Groceries",
    )
    split(headers, typed, ("Groceries", "2200.00"), ("Household", "800.00"))
    other = entry(amount="2200.00", payee="Zomato", date=days_ago(0))
    send(headers, other)
    assert stored(db_session, other["hash"]).transaction_id != typed
    assert len(transactions(db_session)) == 3  # the bill's two parts and the Zomato spend


def test_a_split_bill_cant_become_a_transfer(headers: Headers, db_session: Session) -> None:
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.sms.ingest import _convert

    bank, tx, part = split_bill(headers)
    card = account(headers, "credit_card", "0.00", name="Card", credit_limit="50000.00")
    uid = db_session.scalar(select(User.id))
    assert uid is not None
    for target in (tx, part):
        row = db_session.get(Transaction, target)
        assert row is not None
        assert _convert(db_session, uid, row, bank, card) is False
    db_session.rollback()
    assert {r["type"] for r in rows(headers)} == {"expense"}


def test_review_cant_delete_a_split_bill(headers: Headers, db_session: Session) -> None:
    from fastapi import HTTPException

    from app.models.sms import SmsEntry
    from app.models.user import User
    from app.sms.review import _drop_own_expense

    _, tx, _ = split_bill(headers)
    uid = db_session.scalar(select(User.id))
    assert uid is not None
    entry = SmsEntry(
        user_id=uid,
        hash="h" * 64,
        sender="HDFCBK",
        bank="hdfc",
        kind="debit",
        status="review",
        amount=Decimal("3000"),
        occurred_on=date.today(),
        transaction_id=tx,
    )
    db_session.add(entry)
    db_session.flush()
    with pytest.raises(HTTPException) as refused:
        _drop_own_expense(db_session, uid, entry, [])
    assert refused.value.status_code == 409
    db_session.rollback()
    assert len(rows(headers)) == 2
