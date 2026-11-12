from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import app
from app.models.account import Account
from app.models.investment import Instrument, Sip
from app.models.recurring import RecurringTemplate
from app.models.user import User
from tests.test_accounts import Headers, auth

client = TestClient(app)
URL = "/api/setup"
ORDER = ["bank", "cards", "loans", "recurring", "investments"]


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def uid(db: Session, email: str = "me@example.com") -> int:
    return db.scalars(select(User.id).where(User.email == email)).one()


def account(db: Session, type_: str, email: str = "me@example.com", **fields: Any) -> Account:
    row = Account(
        user_id=uid(db, email), type=type_, name=type_, opening_balance=Decimal(0), **fields
    )
    db.add(row)
    db.commit()
    return row


def instrument(db: Session, kind: str, symbol: str = "X") -> Instrument:
    row = Instrument(user_id=uid(db), kind=kind, symbol=symbol, name=symbol)
    db.add(row)
    db.commit()
    return row


def template(db: Session, active: bool = True) -> RecurringTemplate:
    bank = account(db, "bank", bank_kind="salary")
    row = RecurringTemplate(
        user_id=uid(db),
        name="Rent",
        type="expense",
        amount=Decimal(20000),
        account_id=bank.id,
        category="Rent",
        frequency="monthly",
        day=5,
        start_date=date(2026, 11, 1),
        remind_days=3,
        active=active,
    )
    db.add(row)
    db.commit()
    return row


def steps(headers: Headers) -> dict[str, dict[str, Any]]:
    response = client.get(URL, headers=headers)
    assert response.status_code == 200
    return {step["key"]: step for step in response.json()["steps"]}


def test_new_user_has_every_step_to_do_in_order(headers: Headers) -> None:
    body = client.get(URL, headers=headers).json()
    assert body == {"steps": [{"key": key, "done": False, "count": 0} for key in ORDER]}


def test_needs_sign_in(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    auth(db_session, monkeypatch)
    assert client.get(URL).status_code == 401


@pytest.mark.parametrize(
    ("type_", "key", "fields"),
    [
        ("bank", "bank", {"bank_kind": "savings"}),
        ("credit_card", "cards", {}),
        ("loan", "loans", {}),
        ("ppf", "investments", {}),
        ("rd", "investments", {}),
    ],
)
def test_an_account_ticks_its_step(
    headers: Headers, db_session: Session, type_: str, key: str, fields: dict
) -> None:
    account(db_session, type_, **fields)
    result = steps(headers)
    assert result[key] == {"key": key, "done": True, "count": 1}
    assert [k for k, step in result.items() if step["done"]] == [key]


def test_cash_wallet_and_broker_tick_nothing(headers: Headers, db_session: Session) -> None:
    for type_ in ("cash", "wallet", "broker"):
        account(db_session, type_)
    assert not any(step["done"] for step in steps(headers).values())


def test_archived_accounts_do_not_count(headers: Headers, db_session: Session) -> None:
    account(db_session, "credit_card", archived_at=datetime(2026, 11, 1, tzinfo=UTC))
    account(db_session, "credit_card")
    assert steps(headers)["cards"] == {"key": "cards", "done": True, "count": 1}
    account(db_session, "loan", archived_at=datetime(2026, 11, 1, tzinfo=UTC))
    assert steps(headers)["loans"]["done"] is False


def test_bank_counts_every_active_bank(headers: Headers, db_session: Session) -> None:
    account(db_session, "bank", bank_kind="salary")
    account(db_session, "bank", bank_kind="savings")
    assert steps(headers)["bank"]["count"] == 2


def test_recurring_reminder_ticks_recurring(headers: Headers, db_session: Session) -> None:
    template(db_session)
    assert steps(headers)["recurring"] == {"key": "recurring", "done": True, "count": 1}


def test_stopped_reminder_does_not_count(headers: Headers, db_session: Session) -> None:
    template(db_session, active=False)
    assert steps(headers)["recurring"]["done"] is False


def test_sip_ticks_recurring_and_its_fund_ticks_investments(
    headers: Headers, db_session: Session
) -> None:
    bank = account(db_session, "bank", bank_kind="salary")
    fund = instrument(db_session, "mutual_fund", "120503")
    for active in (True, False):
        db_session.add(
            Sip(
                user_id=uid(db_session),
                instrument_id=fund.id,
                account_id=bank.id,
                amount=Decimal(5000),
                day=10,
                start_date=date(2026, 11, 1),
                active=active,
            )
        )
    db_session.commit()
    result = steps(headers)
    assert result["recurring"] == {"key": "recurring", "done": True, "count": 1}
    assert result["investments"] == {"key": "investments", "done": True, "count": 1}


def test_stocks_funds_and_coins_count_as_investments(headers: Headers, db_session: Session) -> None:
    instrument(db_session, "stock", "INFY")
    instrument(db_session, "mutual_fund", "120503")
    instrument(db_session, "crypto", "bitcoin")
    account(db_session, "ppf")
    assert steps(headers)["investments"] == {"key": "investments", "done": True, "count": 4}


def test_another_users_data_never_counts(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    auth(db_session, monkeypatch, "other@example.com")
    for type_ in ("bank", "credit_card", "loan", "ppf"):
        account(db_session, type_, email="other@example.com")
    assert not any(step["done"] for step in steps(headers).values())
