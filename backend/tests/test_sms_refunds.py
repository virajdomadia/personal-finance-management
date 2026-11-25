"""Refunds from SMS: money back is a refund that lowers spending, not income.

A credit onto a credit card is a refund (payments onto a card are their own kind), and so is a
bank credit the phone flags as a refund or reversal. Anything else credited stays income.
"""

from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.api.categories import DEFAULTS
from app.models.category import Category
from tests.test_accounts import Headers, auth
from tests.test_sms_ingest import (
    TODAY,
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
from tests.test_sms_review import answered, item_for
from tests.test_sms_review_speed import history
from tests.test_sms_transfers import add_rule


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def credit(**fields: Any) -> dict[str, Any]:
    return entry(**{"kind": "credit", "amount": "799.00", **fields})


def test_a_credit_onto_a_card_is_a_refund_in_the_merchants_category(
    headers: Headers, db_session: Session
) -> None:
    c = card(headers)
    result = one(headers, **credit(last4="9876", payee="AMAZON"))

    assert result["status"] == "recorded"
    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.category, tx.refund_of_id) == (
        "refund",
        c,
        "Shopping",
        None,
    )


def test_a_bank_credit_flagged_as_a_refund_is_a_refund(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    add_rule(db_session, "blinkit", "Groceries")
    one(headers, **credit(payee="Blinkit", refund=True))

    [tx] = transactions(db_session)
    assert (tx.type, tx.category) == ("refund", "Groceries")


def test_a_plain_bank_credit_is_still_income(headers: Headers, db_session: Session) -> None:
    bank(headers)
    one(headers, **credit(payee="Ramesh"))
    one(headers, **credit(payee="Ramesh", refund=False, amount="10.00"))

    assert [t.type for t in transactions(db_session)] == ["income", "income"]


def test_refunds_lower_spending_and_are_not_income(headers: Headers, db_session: Session) -> None:
    c = card(headers)
    manual(
        headers,
        type="expense",
        account_id=c,
        amount="2000.00",
        date=TODAY.isoformat(),
        category="Shopping",
    )
    one(headers, **credit(last4="9876", payee="AMAZON"))

    month = client.get("/api/cash-flow", headers=headers).json()
    assert month["income"] == "0.00"
    assert month["spending"] == "1201.00"


def test_a_refund_is_never_paired_as_a_transfer(headers: Headers, db_session: Session) -> None:
    """Equal amounts out of one account and back into another would be asked about as a
    transfer; a refund is money back from a merchant, so it isn't."""
    bank(headers)
    card(headers)
    send(headers, entry(amount="799.00", payee="Ramesh"))
    body = credit(last4="9876", payee="AMAZON")
    send(headers, body)

    saved = stored(db_session, body["hash"])
    assert saved.status == "recorded"
    assert [t.type for t in transactions(db_session)] == ["expense", "refund"]


def test_a_refund_typed_in_by_hand_is_not_recorded_twice(
    headers: Headers, db_session: Session
) -> None:
    c = card(headers)
    typed = manual(
        headers,
        type="refund",
        account_id=c,
        amount="799.00",
        date=TODAY.isoformat(),
        category="Shopping",
    )
    body = credit(last4="9876", payee="AMAZON")
    send(headers, body)

    assert [t.id for t in transactions(db_session)] == [typed]
    assert stored(db_session, body["hash"]).transaction_id == typed


def test_a_refund_with_an_unknown_payee_asks_for_a_spending_category(
    headers: Headers, db_session: Session
) -> None:
    card(headers)
    body = credit(last4="9876", payee="Corner Shop")
    send(headers, body)

    item = item_for(headers, body["hash"], db_session)
    assert item["reason"] == "category"
    assert item["message"] == "New refund: Corner Shop"
    assert item["category_type"] == "expense"
    answered(headers, item["id"], action="category", category="Groceries", remember=True)
    [tx] = transactions(db_session)
    assert (tx.type, tx.category) == ("refund", "Groceries")

    # The rule it left categorises the payee's next refund, and its purchases.
    send(headers, credit(last4="9876", payee="Corner Shop", amount="5.00"))
    send(headers, entry(last4="9876", kind="card_spend", payee="Corner Shop", amount="7.00"))
    assert [(t.type, t.category) for t in transactions(db_session)][1:] == [
        ("refund", "Groceries"),
        ("expense", "Groceries"),
    ]


def test_income_items_still_ask_for_an_income_category(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    body = credit(payee="Ramesh")
    send(headers, body)
    assert item_for(headers, body["hash"], db_session)["category_type"] == "income"
    debit = entry(payee="Corner Shop")
    send(headers, debit)
    assert item_for(headers, debit["hash"], db_session)["category_type"] == "expense"


def test_a_refund_is_suggested_from_the_payees_purchases_but_never_auto_approved(
    headers: Headers, db_session: Session
) -> None:
    card(headers)
    shop = {"last4": "9876", "kind": "card_spend"}
    history(headers, db_session, "Corner Shop", "Groceries", "Groceries", "Groceries", **shop)
    body = credit(last4="9876", payee="Corner Shop")
    send(headers, body)

    item = item_for(headers, body["hash"], db_session)
    assert item["suggested_category"] == "Groceries"
    assert item["confident"] is False
    assert item["why"] == "A refund: check its category"


def test_new_users_get_no_refund_income_category(headers: Headers, db_session: Session) -> None:
    assert "Refund" not in [name for name, _, _ in DEFAULTS["income"]]
    names = [c["name"] for c in client.get("/api/categories", headers=headers).json()["income"]]
    assert "Refund" not in names
    assert "Salary" in names


def test_an_existing_refund_income_category_is_left_alone(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = auth(db_session, monkeypatch)
    client.get("/api/categories", headers=headers)  # seeds the defaults
    user_id = db_session.query(Category.user_id).first()[0]
    db_session.add(
        Category(
            user_id=user_id,
            kind="income",
            name="Refund",
            name_key="refund",
            icon="refund",
            colour="#669bbc",
        )
    )
    db_session.commit()
    b = bank(headers)
    income = manual(
        headers,
        type="income",
        account_id=b,
        amount="50.00",
        date=TODAY.isoformat(),
        category="Refund",
    )
    assert income
