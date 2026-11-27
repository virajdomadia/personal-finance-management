"""Reconciliation: a bank account in Gullak against the balance in its bank's last SMS."""

import hashlib
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.main import app
from app.models.sms import SmsEntry
from app.models.user import User
from tests.test_accounts import Headers, auth
from tests.test_adjustments import account, correct, days_ago, spend

client = TestClient(app)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def sms(db: Session, account_id: int | None, balance: str | None, day: date, **fields: Any) -> None:
    seed = f"{account_id}-{balance}-{day}-{fields}"
    values: dict[str, Any] = {
        "kind": "debit",
        "status": "recorded",
        "amount": Decimal("100"),
        **fields,
    }
    db.add(
        SmsEntry(
            user_id=db.scalar(select(User.id)),
            hash=hashlib.sha256(seed.encode()).hexdigest(),
            sender="HDFCBK",
            bank="hdfc",
            occurred_on=day,
            account_id=account_id,
            balance=None if balance is None else Decimal(balance),
            **values,
        )
    )
    db.commit()


def check(headers: Headers, account_id: int) -> dict[str, Any] | None:
    listed = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a for a in listed if a["id"] == account_id)["bank_check"]


def test_no_sms_no_check(headers: Headers) -> None:
    assert check(headers, account(headers)) is None


def test_matching_bank(headers: Headers, db_session: Session) -> None:
    hdfc = account(headers, balance="10000.00")
    spend(headers, hdfc, "600.00", days_ago(2))
    sms(db_session, hdfc, "9400.00", today_india() - timedelta(days=2))
    assert check(headers, hdfc) == {"balance": "9400.00", "on": days_ago(2), "gap": "0.00"}


def test_gap_is_bank_less_gullak_on_the_sms_day(headers: Headers, db_session: Session) -> None:
    hdfc = account(headers, balance="10000.00")
    spend(headers, hdfc, "600.00", days_ago(5))
    spend(headers, hdfc, "250.00", days_ago(1))  # after the SMS: not part of the check
    sms(db_session, hdfc, "9000.00", today_india() - timedelta(days=5))
    # Gullak had 9,400 that day; the bank said 9,000: 400 missing from Gullak.
    assert check(headers, hdfc) == {"balance": "9000.00", "on": days_ago(5), "gap": "-400.00"}


def test_latest_sms_wins(headers: Headers, db_session: Session) -> None:
    hdfc = account(headers, balance="10000.00")
    sms(db_session, hdfc, "5000.00", today_india() - timedelta(days=9))
    sms(db_session, hdfc, "10000.00", today_india() - timedelta(days=3))
    sms(db_session, hdfc, None, today_india())  # no balance in this one
    assert check(headers, hdfc) == {"balance": "10000.00", "on": days_ago(3), "gap": "0.00"}


def test_card_and_other_accounts_ignored(headers: Headers, db_session: Session) -> None:
    hdfc = account(headers, balance="10000.00")
    card = account(headers, "credit_card", "0.00", name="Card", credit_limit="50000.00")
    sms(db_session, card, "48000.00", today_india(), kind="card_spend")
    sms(db_session, hdfc, "1.00", today_india(), kind="card_statement")
    assert check(headers, card) is None
    assert check(headers, hdfc) is None


def test_matching_the_bank_clears_the_gap(headers: Headers, db_session: Session) -> None:
    hdfc = account(headers, balance="10000.00")
    sms(db_session, hdfc, "9000.00", today_india() - timedelta(days=5))
    response = correct(
        headers, hdfc, "9000.00", balance_date=days_ago(5), balance_reason="Matched to bank SMS"
    )
    assert response.status_code == 200, response.json()
    assert check(headers, hdfc) == {"balance": "9000.00", "on": days_ago(5), "gap": "0.00"}


def test_payments_after_the_balance_sms_that_day_count(
    headers: Headers, db_session: Session
) -> None:
    # 23 Nov: a ₹1 refund SMS said ₹3,585.44, then three UPI payments without a balance.
    hdfc = account(headers, balance="3584.44")
    day = today_india() - timedelta(days=2)
    sms(db_session, hdfc, "3585.44", day, kind="credit", amount=Decimal("1"))
    for paid in ("299", "170", "387"):
        sms(db_session, hdfc, None, day, amount=Decimal(paid))
    for paid in ("299.00", "170.00", "387.00"):
        spend(headers, hdfc, paid, days_ago(2))
    client.post(
        "/api/transactions",
        json={"type": "income", "account_id": hdfc, "amount": "1.00", "date": days_ago(2),
              "category": "Salary"},
        headers=headers,
    )  # fmt: skip
    # The bank's end of that day was 3,585.44 − 856 = 2,729.44, which Gullak also shows.
    assert check(headers, hdfc) == {"balance": "2729.44", "on": days_ago(2), "gap": "0.00"}


def test_a_later_credit_that_day_adds_to_the_banks_balance(
    headers: Headers, db_session: Session
) -> None:
    hdfc = account(headers, balance="10000.00")
    day = today_india() - timedelta(days=1)
    sms(db_session, hdfc, "9000.00", day, amount=Decimal("1000"))
    sms(db_session, hdfc, None, day, kind="credit", amount=Decimal("500"))
    assert check(headers, hdfc)["balance"] == "9500.00"
