"""Debits that are an expected payment: an EMI, a SIP instalment or a recurring reminder."""

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.models.investment import InstrumentPrice, InvestmentTrade, Sip
from app.models.sms import PayeeRule
from app.models.user import User
from tests.test_accounts import Headers, auth
from tests.test_sms_ingest import (
    account,
    balance,
    bank,
    client,
    entry,
    manual,
    one,
    send,
    stored,
    transactions,
)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def user_id(db: Session) -> int:
    found = db.scalar(select(User.id).where(User.email == "me@example.com"))
    assert found is not None
    return found


def loan(headers: Headers, pay_from: int, **fields: Any) -> int:
    body = {
        "name": "Home loan",
        "balance": "21632.00",
        "interest_rate": "14.50",
        "emi_amount": "7500.00",
        "pay_from_id": pay_from,
        **fields,
    }
    return account(headers, "loan", body.pop("balance"), **body)


def fund(headers: Headers, name: str = "Parag Parikh Flexi Cap", symbol: str = "PPFCF") -> int:
    response = client.post(
        "/api/investments/funds", json={"name": name, "symbol": symbol}, headers=headers
    )
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def sip(db: Session, fund_id: int, account_id: int, amount: str = "5000.00") -> int:
    today = today_india()
    row = Sip(
        user_id=user_id(db),
        instrument_id=fund_id,
        account_id=account_id,
        amount=Decimal(amount),
        day=today.day,
        start_date=today - timedelta(days=10),
    )
    db.add(row)
    db.commit()
    return row.id


def nav(db: Session, fund_id: int, price: str, days_ago: int = 0) -> None:
    db.add(
        InstrumentPrice(
            user_id=user_id(db),
            instrument_id=fund_id,
            date=today_india() - timedelta(days=days_ago),
            price=Decimal(price),
        )
    )
    db.commit()


def reminder(headers: Headers, account_id: int, **fields: Any) -> dict[str, Any]:
    today = today_india()
    body = {
        "name": "Rent",
        "type": "expense",
        "amount": "10000.00",
        "account_id": account_id,
        "category": "Housing",
        "frequency": "monthly",
        "day": today.day,
        "start_date": (today - timedelta(days=10)).isoformat(),
        "remind_days": 3,
        **fields,
    }
    response = client.post("/api/recurring", json=body, headers=headers)
    assert response.status_code == 201, response.json()
    return response.json()


def due(headers: Headers) -> list[dict[str, Any]]:
    response = client.get("/api/recurring/due", headers=headers)
    assert response.status_code == 200
    return response.json()["items"]


def rule(db: Session, key: str, **fields: Any) -> None:
    db.add(PayeeRule(user_id=user_id(db), payee_key=key, display=key, **fields))
    db.commit()


# EMIs


def test_emi_debit_records_emi_with_interest(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    home = loan(headers, b)
    body = entry(amount="7500.00", payee="HDFC LOAN ACH")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("recorded", None)

    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id) == ("emi", b, home)
    assert tx.amount == Decimal("7500.00")
    assert tx.interest == Decimal("261.39")  # 21632 × 14.5% ÷ 12
    assert stored(db_session, body["hash"]).transaction_id == tx.id


def test_emi_without_an_interest_split_is_not_offered(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers, balance="50000.00")
    loan(headers, b, interest_rate=None)  # no rate and no EMI count: no split
    result = one(headers, amount="7500.00", payee="HDFC LOAN ACH")
    assert (result["status"], result["reason"]) == ("review", "category")
    [tx] = transactions(db_session)
    assert tx.type == "expense"


def test_emi_on_another_account_is_not_matched(headers: Headers, db_session: Session) -> None:
    bank(headers, balance="50000.00")
    other = bank(headers, last4="5555", name="Other", balance="50000.00")
    loan(headers, other)
    one(headers, amount="7500.00", payee="HDFC LOAN ACH")
    [tx] = transactions(db_session)
    assert tx.type == "expense"


# SIPs


def test_sip_debit_records_estimated_units(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    f = fund(headers)
    s = sip(db_session, f, b)
    nav(db_session, f, "50.1234")
    body = entry(amount="5000.00", payee="BSE LIMITED")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "sip_units")

    assert transactions(db_session) == []
    [trade] = db_session.scalars(select(InvestmentTrade)).all()
    assert (trade.instrument_id, trade.account_id, trade.side, trade.sip_id) == (f, b, "buy", s)
    assert trade.quantity == Decimal("99.754")
    assert trade.price == Decimal("50.1234")
    assert trade.amount == Decimal("5000.00")
    assert trade.estimated is True
    saved = stored(db_session, body["hash"])
    assert saved.trade_id == trade.id
    assert saved.transaction_id is None
    assert saved.message == "Check the units against your fund statement"
    sips = client.get("/api/investments/sips", headers=headers).json()["sips"]
    assert next(x for x in sips if x["id"] == s)["due"] == []


def test_sip_uses_the_latest_nav_before_the_day(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    f = fund(headers)
    sip(db_session, f, b)
    nav(db_session, f, "40.0000", days_ago=5)
    nav(db_session, f, "50.0000", days_ago=2)
    one(headers, amount="5000.00", payee="BSE LIMITED")
    [trade] = db_session.scalars(select(InvestmentTrade)).all()
    assert (trade.price, trade.quantity) == (Decimal("50.0000"), Decimal("100.000"))


def test_sip_without_nav_records_spending_and_asks_for_the_nav(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers, balance="50000.00")
    f = fund(headers)
    s = sip(db_session, f, b)
    body = entry(amount="5000.00", payee="BSE LIMITED")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "expected")

    # The money left the bank, so it is recorded meanwhile: the balance stays right.
    [tx] = transactions(db_session)
    assert (tx.type, tx.category, tx.account_id) == ("expense", None, b)
    assert db_session.scalars(select(InvestmentTrade)).all() == []
    saved = stored(db_session, body["hash"])
    assert saved.transaction_id == tx.id and saved.trade_id is None
    assert saved.candidates == [
        {"kind": "sip", "id": s, "label": "Parag Parikh Flexi Cap SIP", "needs_nav": True}
    ]
    assert balance(headers, b) == "45000.00"


def test_sip_far_from_its_debit_day_is_not_matched(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    f = fund(headers)
    s = sip(db_session, f, b)
    row = db_session.get(Sip, s)
    assert row is not None
    row.start_date = today_india() - timedelta(days=200)
    row.day = (today_india() - timedelta(days=10)).day
    db_session.commit()
    nav(db_session, f, "50.0000")
    result = one(headers, amount="5000.00", payee="BSE LIMITED")
    assert (result["status"], result["reason"]) == ("review", "category")
    assert db_session.scalars(select(InvestmentTrade)).all() == []


# Recurring reminders


def test_rent_first_time_asks(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    rent = reminder(headers, b)
    body = entry(amount="10000.00", payee="Landlord Sharma")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "expected")

    [tx] = transactions(db_session)
    assert (tx.type, tx.category, tx.recurring_template_id) == ("expense", None, None)
    saved = stored(db_session, body["hash"])
    assert saved.message == "Is this your Rent?"
    assert saved.transaction_id == tx.id
    assert [(c["kind"], c["id"], c["label"]) for c in saved.candidates or []] == [
        ("template", rent["id"], "Rent")
    ]


def test_rent_with_rule_ticks_off_reminder(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    rent = reminder(headers, b)
    assert [i["template"]["id"] for i in due(headers)] == [rent["id"]]
    rule(db_session, "landlord sharma", template_id=rent["id"])

    result = one(headers, amount="10500.00", payee="Landlord Sharma")
    assert (result["status"], result["reason"]) == ("recorded", None)
    [tx] = transactions(db_session)
    assert (tx.type, tx.category, tx.recurring_template_id) == ("expense", "Housing", rent["id"])
    assert tx.amount == Decimal("10500.00")
    assert due(headers) == []


def test_transfer_reminder_records_a_transfer(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    savings = account(headers, "wallet", "0.00", name="Paytm")
    plan = reminder(
        headers, b, name="Top-up", type="transfer", category=None, to_account_id=savings
    )
    rule(db_session, "wallet top up", template_id=plan["id"])
    one(headers, amount="10000.00", payee="Wallet top up")
    [tx] = transactions(db_session)
    assert (tx.type, tx.to_account_id, tx.recurring_template_id) == (
        "transfer",
        savings,
        plan["id"],
    )


@pytest.mark.parametrize(
    ("amount", "matched"),
    [("11001.00", False), ("11000.00", True), ("9000.00", True), ("8999.99", False)],
)
def test_rent_amount_outside_ten_percent_not_matched(
    headers: Headers, db_session: Session, amount: str, matched: bool
) -> None:
    b = bank(headers, balance="50000.00")
    reminder(headers, b)
    result = one(headers, amount=amount, payee="Landlord Sharma")
    assert result["reason"] == ("expected" if matched else "category")


def test_rent_already_paid_this_month_is_not_matched(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    rent = reminder(headers, b)
    response = client.post(
        "/api/transactions",
        json={
            "type": "expense",
            "account_id": b,
            "amount": "10000.00",
            "date": today_india().isoformat(),
            "category": "Housing",
            "recurring_template_id": rent["id"],
        },
        headers=headers,
    )
    assert response.status_code == 201, response.json()
    # Another amount, so not the typed-in payment itself; but this month is already paid.
    assert one(headers, amount="10200.00", payee="Landlord Sharma")["reason"] == "category"


def test_two_candidates_never_guessed(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    rent = reminder(headers, b)
    maid = reminder(headers, b, name="Maid", amount="10200.00", category="Household")
    rule(db_session, "landlord sharma", template_id=None, category="Rent")
    body = entry(amount="10100.00", payee="Landlord Sharma")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "expected")
    [tx] = transactions(db_session)
    assert (tx.type, tx.category, tx.recurring_template_id) == ("expense", None, None)
    saved = stored(db_session, body["hash"])
    assert sorted(c["id"] for c in saved.candidates or []) == sorted([rent["id"], maid["id"]])
    assert len(due(headers)) == 2


def test_rule_narrows_to_its_template(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    rent = reminder(headers, b)
    reminder(headers, b, name="Maid", amount="10200.00", category="Household")
    rule(db_session, "landlord sharma", template_id=rent["id"])
    assert one(headers, amount="10100.00", payee="Landlord Sharma")["status"] == "recorded"
    [tx] = transactions(db_session)
    assert tx.recurring_template_id == rent["id"]


def test_emi_and_reminder_together_never_guessed(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    home = loan(headers, b)
    rent = reminder(headers, b, amount="7500.00")
    body = entry(amount="7500.00", payee="Landlord Sharma")
    assert send(headers, body).json()["results"][0]["reason"] == "expected"
    saved = stored(db_session, body["hash"])
    kinds = sorted((c["kind"], c["id"]) for c in saved.candidates or [])
    assert kinds == [("emi", home), ("template", rent["id"])]
    [tx] = transactions(db_session)
    assert (tx.type, tx.category) == ("expense", None)


def test_known_transfer_is_not_overridden(headers: Headers, db_session: Session) -> None:
    b = bank(headers, last4="1244", balance="50000.00")
    boi = bank(headers, last4="8650", name="BOI")
    loan(headers, b, emi_amount="20000.00", balance="500000.00")
    one(headers, amount="20000.00", last4="1244", payee="XX650")
    [tx] = transactions(db_session)
    assert (tx.type, tx.to_account_id) == ("transfer", boi)


def test_other_users_plans_are_not_matched(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    b = bank(headers, balance="50000.00")
    loan(headers, b)
    reminder(headers, b, amount="7500.00")
    other = auth(db_session, monkeypatch, email="other@example.com")
    bank(other, balance="50000.00")
    result = one(other, amount="7500.00", payee="HDFC LOAN ACH")
    assert result["reason"] == "category"


def test_sip_debited_after_a_holiday_settles_its_own_month(
    headers: Headers, db_session: Session
) -> None:
    # Debit day 30; 30 March was a holiday, so the bank debited on 1 April.
    b = bank(headers, balance="50000.00")
    f = fund(headers)
    s = sip(db_session, f, b)
    row = db_session.get(Sip, s)
    assert row is not None
    row.day, row.start_date = 30, date(2026, 3, 30)
    db_session.commit()
    for day in (date(2026, 4, 1), date(2026, 4, 30)):
        db_session.add(
            InstrumentPrice(user_id=user_id(db_session), instrument_id=f, date=day, price=50)
        )
    db_session.commit()

    late = one(headers, amount="5000.00", payee="BSE LIMITED", date="2026-04-01")
    assert late["reason"] == "sip_units"
    april = one(headers, amount="5000.00", payee="BSE LIMITED", date="2026-04-30")
    assert april["reason"] == "sip_units"
    trades = db_session.scalars(select(InvestmentTrade).order_by(InvestmentTrade.id)).all()
    assert [(t.date, t.sip_id) for t in trades] == [
        (date(2026, 4, 1), s),
        (date(2026, 4, 30), s),
    ]
    sips = client.get("/api/investments/sips", headers=headers).json()["sips"]
    assert "2026-03-30" not in next(x for x in sips if x["id"] == s)["due"]
    assert "2026-04-30" not in next(x for x in sips if x["id"] == s)["due"]


# An EMI already recorded for the period


def _home_loan(headers: Headers) -> tuple[int, int]:
    b = bank(headers, balance="50000.00")
    return b, loan(headers, b, balance="210000.00")


def _days_ago(n: int) -> str:
    return (today_india() - timedelta(days=n)).isoformat()


def _typed_emi(headers: Headers, b: int, home: int, days: int) -> int:
    return manual(
        headers,
        type="emi",
        account_id=b,
        to_account_id=home,
        amount="7500.00",
        date=_days_ago(days),
        interest="2000.00",
    )


def test_emi_typed_in_days_apart_is_not_recorded_twice(
    headers: Headers, db_session: Session
) -> None:
    b, home = _home_loan(headers)
    typed = _typed_emi(headers, b, home, 0)
    body = entry(amount="7500.00", payee="HDFC LOAN ACH", date=_days_ago(3))
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("recorded", None)
    [tx] = transactions(db_session)
    assert tx.id == typed
    assert stored(db_session, body["hash"]).transaction_id == typed
    assert balance(headers, b) == "42500.00"


def test_emi_already_recorded_from_a_message_asks(headers: Headers, db_session: Session) -> None:
    b, home = _home_loan(headers)
    first = entry(amount="7500.00", payee="HDFC LOAN ACH", date=_days_ago(1))
    assert send(headers, first).json()["results"][0]["status"] == "recorded"
    [emi] = transactions(db_session)
    second = entry(amount="7500.00", payee="HDFC LOAN EMI")
    result = send(headers, second).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "expected")

    emi_tx, spent = transactions(db_session)
    assert emi_tx.id == emi.id and emi_tx.type == "emi"
    assert (spent.type, spent.category) == ("expense", None)
    saved = stored(db_session, second["hash"])
    assert saved.transaction_id == spent.id
    assert [(c["kind"], c["id"]) for c in saved.candidates or []] == [
        ("emi", home),
        ("transaction", emi.id),
    ]
    assert balance(headers, b) == "35000.00"


def test_two_emis_already_recorded_asks(headers: Headers, db_session: Session) -> None:
    b, home = _home_loan(headers)
    ids = [_typed_emi(headers, b, home, days) for days in (2, 4)]
    body = entry(amount="7500.00", payee="HDFC LOAN ACH")
    assert send(headers, body).json()["results"][0]["reason"] == "expected"
    saved = stored(db_session, body["hash"])
    found = sorted(c["id"] for c in saved.candidates or [] if c["kind"] == "transaction")
    assert found == sorted(ids)
    assert len(transactions(db_session)) == 3


def test_emi_paid_last_period_does_not_stop_this_one(headers: Headers, db_session: Session) -> None:
    b, home = _home_loan(headers)
    _typed_emi(headers, b, home, 40)
    result = one(headers, amount="7500.00", payee="HDFC LOAN ACH")
    assert (result["status"], result["reason"]) == ("recorded", None)
    assert [t.type for t in transactions(db_session)] == ["emi", "emi"]
