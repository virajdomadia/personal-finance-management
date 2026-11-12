"""The two sides of one transfer, and card bill payments, become one transfer."""

from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.models.sms import AccountIdentifier, PayeeRule
from app.models.user import User
from tests.test_accounts import Headers, auth
from tests.test_sms_ingest import (
    account,
    balance,
    bank,
    card,
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


def days_ago(n: int) -> str:
    return (today_india() - timedelta(days=n)).isoformat()


def user_id(db: Session) -> int:
    found = db.scalar(select(User.id).where(User.email == "me@example.com"))
    assert found is not None
    return found


def federal_debit(**fields: Any) -> dict[str, Any]:
    body = {
        "sender": "VM-FEDBNK",
        "bank": "federal",
        "kind": "debit",
        "amount": "20000.00",
        "last4": "1244",
        "payee": "XX650",
    }
    return entry(**{**body, **fields})


def boi_credit(**fields: Any) -> dict[str, Any]:
    body = {"kind": "credit", "amount": "20000.00", "last4": "8650", "payee": None}
    return entry(**{**body, **fields})


def assert_reviewless(db: Session, *hashes: str, tx_id: int) -> None:
    for hash_ in hashes:
        saved = stored(db, hash_)
        assert (saved.status, saved.reason, saved.message) == ("recorded", None, None)
        assert saved.candidates is None
        assert saved.transaction_id == tx_id


# Payee is one of the owner's own accounts


def test_imps_to_own_masked_account_is_transfer(headers: Headers, db_session: Session) -> None:
    fed = bank(headers, last4="1244", name="Federal", balance="50000.00")
    boi = bank(headers, last4="8650", name="BOI", balance="1000.00")
    debit = federal_debit()
    assert send(headers, debit).json()["results"][0]["status"] == "recorded"

    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id, tx.category) == ("transfer", fed, boi, None)
    assert tx.amount == Decimal("20000.00")

    credit = boi_credit(date=days_ago(0))
    assert send(headers, credit).json()["results"][0]["status"] == "recorded"
    assert [t.id for t in transactions(db_session)] == [tx.id]
    assert_reviewless(db_session, debit["hash"], credit["hash"], tx_id=tx.id)
    assert balance(headers, fed) == "30000.00"
    assert balance(headers, boi) == "21000.00"


@pytest.mark.parametrize("payee", ["X8650", "A/c XX8650", "xx650"])
def test_masked_payee_spellings(headers: Headers, db_session: Session, payee: str) -> None:
    fed = bank(headers, last4="1244", name="Federal", balance="50000.00")
    boi = bank(headers, last4="8650", name="BOI")
    send(headers, federal_debit(payee=payee))
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id) == ("transfer", fed, boi)


def test_masked_payee_matches_an_identifier(headers: Headers, db_session: Session) -> None:
    bank(headers, last4="1244", name="Federal", balance="50000.00")
    wallet = account(headers, "wallet", "0.00", name="Paytm")
    db_session.add(AccountIdentifier(user_id=user_id(db_session), account_id=wallet, last4="4650"))
    db_session.commit()
    send(headers, federal_debit())
    [tx] = transactions(db_session)
    assert (tx.type, tx.to_account_id) == ("transfer", wallet)


def test_masked_payee_matching_two_accounts_is_not_guessed(
    headers: Headers, db_session: Session
) -> None:
    fed = bank(headers, last4="1244", name="Federal", balance="50000.00")
    bank(headers, last4="8650", name="BOI")
    bank(headers, last4="1650", name="SBI")
    debit = federal_debit()
    result = send(headers, debit).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "category")
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id) == ("expense", fed, None)
    assert balance(headers, fed) == "30000.00"


def test_masked_payee_never_points_at_the_paying_account(
    headers: Headers, db_session: Session
) -> None:
    fed = bank(headers, last4="1244", name="Federal", balance="50000.00")
    send(headers, federal_debit(payee="XX244"))
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id) == ("expense", fed)


def test_masked_payee_ignores_archived_and_other_users_accounts(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    bank(headers, last4="1244", name="Federal", balance="50000.00")
    archived = bank(headers, last4="8650", name="Old BOI")
    assert client.post(f"/api/accounts/{archived}/archive", headers=headers).status_code in (
        200,
        204,
    )
    other = auth(db_session, monkeypatch, email="other@example.com")
    bank(other, last4="7650", name="Theirs")
    send(headers, federal_debit())
    [tx] = transactions(db_session)
    assert tx.type == "expense"


def test_credit_first_then_masked_debit_is_one_transfer(
    headers: Headers, db_session: Session
) -> None:
    fed = bank(headers, last4="1244", name="Federal", balance="50000.00")
    boi = bank(headers, last4="8650", name="BOI", balance="1000.00")
    credit = boi_credit()
    send(headers, credit)
    [income] = transactions(db_session)
    assert income.type == "income"

    debit = federal_debit()
    assert send(headers, debit).json()["results"][0]["status"] == "recorded"
    [tx] = transactions(db_session)
    assert (tx.id, tx.type, tx.account_id, tx.to_account_id, tx.category) == (
        income.id,
        "transfer",
        fed,
        boi,
        None,
    )
    assert_reviewless(db_session, debit["hash"], credit["hash"], tx_id=tx.id)
    assert balance(headers, fed) == "30000.00"
    assert balance(headers, boi) == "21000.00"


def test_later_credit_four_days_after_transfer_is_its_own(
    headers: Headers, db_session: Session
) -> None:
    bank(headers, last4="1244", name="Federal", balance="50000.00")
    boi = bank(headers, last4="8650", name="BOI", balance="1000.00")
    send(headers, federal_debit(date=days_ago(4)))
    send(headers, boi_credit())
    assert [t.type for t in transactions(db_session)] == ["transfer", "income"]
    assert balance(headers, boi) == "41000.00"


# Payee rules pointing at an account


def test_payee_rule_to_rd_records_transfer(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    start = today_india().replace(day=1)
    response = client.post(
        "/api/accounts",
        json={
            "type": "rd",
            "name": "SBI RD",
            "balance": "5000.00",
            "interest_rate": "7.00",
            "opened_on": start.isoformat(),
            "deposit_amount": "5000.00",
            "due_day": 1,
            "tenure_months": 24,
            "deposits_paid": 1,
            "pay_from_id": b,
        },
        headers=headers,
    )
    assert response.status_code == 201, response.json()
    rd = response.json()["id"]
    db_session.add(
        PayeeRule(
            user_id=user_id(db_session), payee_key="sbi rd", display="SBI RD", to_account_id=rd
        )
    )
    db_session.commit()
    rd_before = Decimal(balance(headers, rd))
    bank_before = Decimal(balance(headers, b))
    before = len(transactions(db_session))

    debit = entry(amount="5000.00", payee="SBI RD")
    assert send(headers, debit).json()["results"][0]["status"] == "recorded"
    new = transactions(db_session)[before:]
    assert [(t.type, t.account_id, t.to_account_id, t.category) for t in new] == [
        ("transfer", b, rd, None)
    ]
    assert Decimal(balance(headers, rd)) == rd_before + Decimal("5000.00")
    assert Decimal(balance(headers, b)) == bank_before - Decimal("5000.00")


def test_payee_rule_transfer_links_the_later_credit(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    other = bank(headers, last4="5678", name="Other", balance="0.00")
    db_session.add(
        PayeeRule(
            user_id=user_id(db_session), payee_key="self", display="Self", to_account_id=other
        )
    )
    db_session.commit()
    debit = entry(amount="1500.00", payee="SELF")
    send(headers, debit)
    credit = entry(kind="credit", amount="1500.00", last4="5678", payee="Viraj")
    assert send(headers, credit).json()["results"][0]["status"] == "recorded"
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id) == ("transfer", b, other)
    assert_reviewless(db_session, debit["hash"], credit["hash"], tx_id=tx.id)
    assert balance(headers, b) == "8500.00"
    assert balance(headers, other) == "1500.00"


def test_payee_rule_to_the_paying_account_is_not_used(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers)
    db_session.add(
        PayeeRule(user_id=user_id(db_session), payee_key="self", display="Self", to_account_id=b)
    )
    db_session.commit()
    one(headers, payee="SELF")
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id) == ("expense", b)


# Card bills


def card_spend(headers: Headers, amount: str = "3000.00") -> None:
    assert (
        one(headers, kind="card_spend", last4="9876", amount=amount, payee="AMAZON")["status"]
        == "recorded"
    )


def card_payment(**fields: Any) -> dict[str, Any]:
    body = {"kind": "card_payment", "last4": "9876", "amount": "3000.00", "payee": None}
    return entry(**{**body, **fields})


def test_card_bill_bank_first_then_card(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    c = card(headers)
    card_spend(headers)
    assert balance(headers, c) == "3000.00"  # owed

    debit = entry(amount="3000.00", payee=None, date=days_ago(2))
    send(headers, debit)
    paid = card_payment()
    assert send(headers, paid).json()["results"][0]["status"] == "recorded"

    spend, tx = transactions(db_session)
    assert spend.type == "expense"
    assert (tx.type, tx.account_id, tx.to_account_id, tx.category) == ("transfer", b, c, None)
    assert_reviewless(db_session, debit["hash"], paid["hash"], tx_id=tx.id)
    assert balance(headers, b) == "7000.00"
    assert balance(headers, c) == "0.00"


def test_card_bill_card_first_then_bank(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    c = card(headers)
    card_spend(headers)
    paid = card_payment(date=days_ago(1))
    result = send(headers, paid).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "card_payment")
    assert len(transactions(db_session)) == 1

    debit = entry(amount="3000.00", payee="CRED")
    assert send(headers, debit).json()["results"][0]["status"] == "recorded"
    spend, tx = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id, tx.category) == ("transfer", b, c, None)
    assert_reviewless(db_session, debit["hash"], paid["hash"], tx_id=tx.id)
    assert balance(headers, b) == "7000.00"
    assert balance(headers, c) == "0.00"


def test_card_payment_without_bank_debit_asks_which_account(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers)
    wallet = account(headers, "wallet", "100.00", name="Paytm")
    account(headers, "cash", "100.00", name="Cash")
    card(headers)
    paid = card_payment(amount="12345.50")
    result = send(headers, paid).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "card_payment")
    saved = stored(db_session, paid["hash"])
    assert saved.message == "Which account paid ₹12,345.50 to credit_card?"
    assert saved.transaction_id is None
    assert saved.candidates == [
        {"kind": "account", "id": b, "label": "bank"},
        {"kind": "account", "id": wallet, "label": "Paytm"},
    ]
    assert transactions(db_session) == []


def test_card_payment_ignores_a_debit_four_days_away(headers: Headers, db_session: Session) -> None:
    bank(headers)
    card(headers)
    send(headers, entry(amount="3000.00", payee=None, date=days_ago(4)))
    result = send(headers, card_payment()).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "card_payment")
    [tx] = transactions(db_session)
    assert tx.type == "expense"


def test_card_payment_ignores_a_debit_already_a_transfer(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    other = bank(headers, last4="5678", name="Other")
    card(headers)
    send(headers, entry(amount="3000.00", payee=None, ref="R9"))
    send(headers, entry(kind="credit", amount="3000.00", last4="5678", payee=None, ref="R9"))
    [tx] = transactions(db_session)
    assert (tx.type, tx.to_account_id) == ("transfer", other)
    result = send(headers, card_payment()).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "card_payment")
    assert len(transactions(db_session)) == 1


def test_card_payment_links_a_masked_transfer_to_the_card(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers)
    c = card(headers)
    debit = entry(amount="3000.00", payee="XX9876")
    send(headers, debit)
    paid = card_payment()
    assert send(headers, paid).json()["results"][0]["status"] == "recorded"
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id) == ("transfer", b, c)
    assert_reviewless(db_session, debit["hash"], paid["hash"], tx_id=tx.id)


def test_masked_debit_to_card_links_the_waiting_payment(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers)
    c = card(headers)
    paid = card_payment()
    send(headers, paid)
    debit = entry(amount="3000.00", payee="XX9876")
    send(headers, debit)
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id) == ("transfer", b, c)
    assert_reviewless(db_session, debit["hash"], paid["hash"], tx_id=tx.id)
    assert balance(headers, b) == "7000.00"


def test_wallet_too_low_for_card_bill_leaves_payment_waiting(
    headers: Headers, db_session: Session
) -> None:
    wallet = account(headers, "wallet", "100.00", name="Paytm")
    db_session.add(AccountIdentifier(user_id=user_id(db_session), account_id=wallet, last4="4321"))
    db_session.commit()
    card(headers)
    paid = card_payment()
    send(headers, paid)
    result = one(headers, last4="4321", amount="3000.00", payee=None)
    assert (result["status"], result["reason"]) == ("review", "balance")
    assert transactions(db_session) == []
    saved = stored(db_session, paid["hash"])
    assert (saved.status, saved.reason, saved.transaction_id) == ("review", "card_payment", None)


# The same reference on both sides


@pytest.mark.parametrize("credit_first", [False, True])
def test_same_ref_merges_into_transfer(
    headers: Headers, db_session: Session, credit_first: bool
) -> None:
    a = bank(headers)
    b = bank(headers, last4="5678", name="Other", balance="0.00")
    debit = entry(amount="700.00", payee="Viraj", ref="630508382540", date=days_ago(1))
    credit = entry(kind="credit", amount="700.00", last4="5678", payee="Viraj", ref="630508382540")
    for body in (credit, debit) if credit_first else (debit, credit):
        send(headers, body)

    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id, tx.category) == ("transfer", a, b, None)
    assert_reviewless(db_session, debit["hash"], credit["hash"], tx_id=tx.id)
    assert balance(headers, a) == "9300.00"
    assert balance(headers, b) == "700.00"


def test_same_ref_different_amount_is_not_merged(headers: Headers, db_session: Session) -> None:
    bank(headers)
    bank(headers, last4="5678", name="Other")
    send(headers, entry(amount="700.00", payee=None, ref="R1"))
    send(headers, entry(kind="credit", amount="701.00", last4="5678", payee=None, ref="R1"))
    assert [t.type for t in transactions(db_session)] == ["expense", "income"]


def test_other_users_same_ref_is_not_merged(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    bank(headers)
    other = auth(db_session, monkeypatch, email="other@example.com")
    bank(other, last4="5678", name="Theirs")
    send(headers, entry(amount="700.00", payee=None, ref="R1"))
    send(other, entry(kind="credit", amount="700.00", last4="5678", payee=None, ref="R1"))
    assert [t.type for t in transactions(db_session)] == ["expense", "income"]


# No evidence


def test_unrelated_equal_amounts_not_merged(headers: Headers, db_session: Session) -> None:
    a = bank(headers)
    b = bank(headers, last4="5678", name="Other")
    assert one(headers, amount="500.00", payee="swiggy@icici")["status"] == "recorded"
    refund = entry(kind="credit", amount="500.00", last4="5678", payee="Ramesh")
    result = send(headers, refund).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "maybe_transfer")

    spend, income = transactions(db_session)
    assert (spend.type, spend.account_id, spend.category) == ("expense", a, "Food and dining")
    assert (income.type, income.account_id) == ("income", b)
    saved = stored(db_session, refund["hash"])
    assert saved.message == "Is this a transfer between your accounts?"
    assert saved.transaction_id == income.id
    today = today_india().isoformat()
    assert saved.candidates == [
        {"kind": "transaction", "id": spend.id, "label": f"{today} · Food and dining · ₹500"}
    ]
    assert balance(headers, a) == "9500.00"
    assert balance(headers, b) == "10500.00"


def test_debit_after_unrelated_credit_asks_too(headers: Headers, db_session: Session) -> None:
    bank(headers)
    bank(headers, last4="5678", name="Other")
    send(headers, entry(kind="credit", amount="500.00", last4="5678", payee=None))
    body = entry(amount="500.00", payee=None)
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "maybe_transfer")
    assert [t.type for t in transactions(db_session)] == ["income", "expense"]


def test_same_account_equal_amounts_are_not_a_transfer(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    one(headers, amount="500.00", payee="swiggy@icici")
    result = one(headers, kind="credit", amount="500.00", payee="Ramesh")
    assert result["reason"] == "category"


def test_equal_amounts_four_days_apart_are_not_asked(headers: Headers, db_session: Session) -> None:
    bank(headers)
    bank(headers, last4="5678", name="Other")
    one(headers, amount="500.00", payee="swiggy@icici", date=days_ago(4))
    result = one(headers, kind="credit", amount="500.00", last4="5678", payee="Ramesh")
    assert result["reason"] == "category"


# A card payment proves money reached the card, not which debit paid it


def add_rule(db: Session, key: str, category: str) -> None:
    db.add(PayeeRule(user_id=user_id(db), payee_key=key, display=key, category=category))
    db.commit()


def test_categorised_debit_is_not_taken_by_card_payment(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers)
    card(headers)
    add_rule(db_session, "ramesh", "Gift")
    send(headers, entry(amount="3000.00", payee="Ramesh"))
    paid = card_payment()
    result = send(headers, paid).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "card_payment")

    [tx] = transactions(db_session)
    assert (tx.type, tx.category) == ("expense", "Gift")
    saved = stored(db_session, paid["hash"])
    assert saved.transaction_id is None
    today = today_india().isoformat()
    assert saved.candidates == [
        {"kind": "transaction", "id": tx.id, "label": f"{today} · Gift · ₹3,000"},
        {"kind": "account", "id": b, "label": "bank"},
    ]
    assert balance(headers, b) == "7000.00"


def test_card_first_then_categorised_debit_stays_expense(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers)
    card(headers)
    paid = card_payment()
    send(headers, paid)
    debit = entry(amount="3000.00", payee="swiggy@icici")
    assert send(headers, debit).json()["results"][0]["status"] == "recorded"

    [tx] = transactions(db_session)
    assert (tx.type, tx.category) == ("expense", "Food and dining")
    saved = stored(db_session, paid["hash"])
    assert (saved.status, saved.reason, saved.transaction_id) == ("review", "card_payment", None)
    assert saved.candidates is not None
    assert saved.candidates[0] == {"kind": "transaction", "id": tx.id, "label": _label_of(tx)}
    assert saved.candidates[1:] == [{"kind": "account", "id": b, "label": "bank"}]


def _label_of(tx: Any) -> str:
    return f"{tx.date.isoformat()} · {tx.category or tx.type} · ₹3,000"


def test_two_equal_uncategorised_debits_ask(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    card(headers)
    send(headers, entry(amount="3000.00", payee=None, date=days_ago(1)))
    send(headers, entry(amount="3000.00", payee=None))
    paid = card_payment()
    result = send(headers, paid).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "card_payment")
    assert [t.type for t in transactions(db_session)] == ["expense", "expense"]
    saved = stored(db_session, paid["hash"])
    assert saved.candidates is not None
    assert [c["kind"] for c in saved.candidates] == ["transaction", "transaction", "account"]
    assert balance(headers, b) == "4000.00"


def test_debit_with_two_waiting_card_payments_asks(headers: Headers, db_session: Session) -> None:
    bank(headers)
    card(headers)
    account(headers, "credit_card", "0.00", name="Other card", last4="1111", credit_limit="1000.00")
    first, second = card_payment(), card_payment(last4="1111")
    send(headers, first, second)
    send(headers, entry(amount="3000.00", payee=None))
    [tx] = transactions(db_session)
    assert tx.type == "expense"
    for body in (first, second):
        saved = stored(db_session, body["hash"])
        assert (saved.reason, saved.transaction_id) == ("card_payment", None)
        assert saved.candidates is not None
        assert saved.candidates[0]["id"] == tx.id


@pytest.mark.parametrize("payee", ["CRED Club", "BillDesk", "HDFC Bank", "Credit Card Payment"])
def test_categorised_bill_payee_still_pays_the_card(
    headers: Headers, db_session: Session, payee: str
) -> None:
    b = bank(headers)
    c = account(
        headers,
        "credit_card",
        "0.00",
        name="Regalia",
        last4="9876",
        credit_limit="100000.00",
        institution="HDFC",
    )
    add_rule(db_session, payee.casefold(), "Bills")
    debit = entry(amount="3000.00", payee=payee)
    send(headers, debit)
    paid = card_payment()
    assert send(headers, paid).json()["results"][0]["status"] == "recorded"
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id, tx.category) == ("transfer", b, c, None)
    assert_reviewless(db_session, debit["hash"], paid["hash"], tx_id=tx.id)


def test_card_first_then_bill_payee_pays_the_card(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    c = card(headers)
    add_rule(db_session, "cred club", "Bills")
    paid = card_payment()
    send(headers, paid)
    debit = entry(amount="3000.00", payee="CRED Club")
    send(headers, debit)
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id) == ("transfer", b, c)
    assert_reviewless(db_session, debit["hash"], paid["hash"], tx_id=tx.id)


# A transfer the owner typed in, told by both banks


def _typed_transfer(headers: Headers, days: int = 0) -> tuple[int, int, int]:
    a = bank(headers, last4="1111", name="A", balance="10000.00")
    b = bank(headers, last4="2222", name="B", balance="0.00")
    typed = manual(
        headers,
        type="transfer",
        account_id=a,
        to_account_id=b,
        amount="500.00",
        date=days_ago(days),
    )
    return a, b, typed


@pytest.mark.parametrize("credit_first", [False, True])
def test_typed_transfer_is_linked_by_both_sides(
    headers: Headers, db_session: Session, credit_first: bool
) -> None:
    a, b, typed = _typed_transfer(headers)
    debit = entry(kind="debit", amount="500.00", last4="1111", payee=None)
    credit = entry(kind="credit", amount="500.00", last4="2222", payee=None)
    send(headers, *((credit, debit) if credit_first else (debit, credit)))
    [tx] = transactions(db_session)
    assert tx.id == typed
    assert_reviewless(db_session, debit["hash"], credit["hash"], tx_id=typed)
    assert (balance(headers, a), balance(headers, b)) == ("9500.00", "500.00")


def test_typed_transfer_sides_arriving_days_later_still_link(
    headers: Headers, db_session: Session
) -> None:
    a, b, typed = _typed_transfer(headers, days=3)
    debit = entry(kind="debit", amount="500.00", last4="1111", payee=None)  # today
    credit = entry(kind="credit", amount="500.00", last4="2222", payee=None, date=days_ago(1))
    send(headers, debit, credit)
    [tx] = transactions(db_session)
    assert tx.id == typed
    assert_reviewless(db_session, debit["hash"], credit["hash"], tx_id=typed)
    assert (balance(headers, a), balance(headers, b)) == ("9500.00", "500.00")


@pytest.mark.parametrize("card_first", [False, True])
@pytest.mark.parametrize("days", [0, 2])
def test_typed_card_bill_is_linked_by_both_sides(
    headers: Headers, db_session: Session, card_first: bool, days: int
) -> None:
    a = bank(headers, last4="1111", name="A", balance="10000.00")
    c = card(headers)
    typed = manual(
        headers,
        type="transfer",
        account_id=a,
        to_account_id=c,
        amount="500.00",
        date=days_ago(days),
    )
    debit = entry(kind="debit", amount="500.00", last4="1111", payee="CRED")
    paid = card_payment(amount="500.00")
    send(headers, *((paid, debit) if card_first else (debit, paid)))
    [tx] = transactions(db_session)
    assert tx.id == typed
    assert_reviewless(db_session, debit["hash"], paid["hash"], tx_id=typed)
    assert (balance(headers, a), balance(headers, c)) == ("9500.00", "-500.00")


def test_one_typed_transaction_takes_one_message_per_side(
    headers: Headers, db_session: Session
) -> None:
    a, b, typed = _typed_transfer(headers)
    first = entry(kind="debit", amount="500.00", last4="1111", payee="Ramesh", ref="111")
    second = entry(kind="debit", amount="500.00", last4="1111", payee="Ramesh", ref="222")
    came = entry(kind="credit", amount="500.00", last4="2222", payee=None, ref="333")
    again = entry(kind="credit", amount="500.00", last4="2222", payee=None, ref="444")
    send(headers, first, second, came, again)
    assert stored(db_session, first["hash"]).transaction_id == typed
    assert stored(db_session, came["hash"]).transaction_id == typed
    for hash_ in (second["hash"], again["hash"]):
        own = stored(db_session, hash_).transaction_id
        assert own is not None and own != typed
    assert len(transactions(db_session)) == 3
