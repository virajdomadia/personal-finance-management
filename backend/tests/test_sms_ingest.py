import hashlib
from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.main import app
from app.models.sms import AccountIdentifier, PayeeRule, SmsEntry
from app.models.transaction import Transaction
from app.models.user import User
from app.sms import ingest as ingest_module
from tests.test_accounts import Headers, auth, make

client = TestClient(app)

URL = "/api/sms/entries"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def account(headers: Headers, type_: str, balance: str, **extra: Any) -> int:
    if type_ == "bank":
        extra.setdefault("bank_kind", "savings")
    response = make(headers, type=type_, name=extra.pop("name", type_), balance=balance, **extra)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def bank(headers: Headers, last4: str = "1234", balance: str = "10000.00", **extra: Any) -> int:
    return account(headers, "bank", balance, last4=last4, **extra)


def card(headers: Headers, last4: str = "9876") -> int:
    return account(headers, "credit_card", "0.00", last4=last4, credit_limit="100000.00")


def sms_hash(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()


_counter = iter(range(1_000_000))


def entry(**fields: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "hash": sms_hash(f"sms-{next(_counter)}"),
        "sender": "AD-BOIIND",
        "bank": "boi",
        "kind": "debit",
        "amount": "243.00",
        "date": today_india().isoformat(),
        "last4": "1234",
        "payee": "Blinkit",
        "ref": None,
    }
    body.update(fields)
    return body


def send(headers: Headers, *entries: dict[str, Any]) -> Response:
    return client.post(URL, json={"entries": list(entries)}, headers=headers)


def one(headers: Headers, **fields: Any) -> dict[str, Any]:
    response = send(headers, entry(**fields))
    assert response.status_code == 200, response.json()
    return response.json()["results"][0]


def stored(db: Session, hash_: str) -> SmsEntry:
    found = db.scalar(select(SmsEntry).where(SmsEntry.hash == hash_))
    assert found is not None
    db.refresh(found)
    return found


def transactions(db: Session) -> list[Transaction]:
    db.expire_all()
    return list(db.scalars(select(Transaction).order_by(Transaction.id)))


def balance(headers: Headers, id: int) -> str:
    accounts = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a for a in accounts if a["id"] == id)["balance"]


def manual(headers: Headers, **fields: Any) -> int:
    response = client.post("/api/transactions", json=fields, headers=headers)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


# Categories and recording


def test_debit_with_known_merchant_records_expense(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    body = entry(amount="250.00", payee="swiggy@icici", ref="631529109575")
    result = send(headers, body).json()["results"][0]
    assert result == {"hash": body["hash"], "status": "recorded", "reason": None}

    [tx] = transactions(db_session)
    assert (tx.type, tx.category, tx.account_id, str(tx.amount)) == (
        "expense",
        "Food and dining",
        b,
        "250.00",
    )
    assert tx.source == "sms"
    shown = client.get(f"/api/transactions/{tx.id}", headers=headers).json()
    assert shown["from_sms"] is True
    assert shown["category"] == "Food and dining"
    assert stored(db_session, body["hash"]).transaction_id == tx.id
    assert balance(headers, b) == "9750.00"


def test_new_payee_records_uncategorised_and_asks(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(amount="120.00", payee="Ramesh Kirana")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "category")

    [tx] = transactions(db_session)
    assert tx.type == "expense"
    assert tx.category is None
    saved = stored(db_session, body["hash"])
    assert saved.message == "New payee: Ramesh Kirana"
    assert saved.transaction_id == tx.id

    listed = client.get("/api/transactions", headers=headers).json()
    assert listed["expense_by_category"] == [{"category": "Uncategorised", "amount": "120.00"}]
    assert listed["transactions"][0]["category"] is None


def test_phone_number_payee_is_named_by_upi_id(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="9876543210@ybl")
    send(headers, body)
    assert stored(db_session, body["hash"]).message == "New payee: 9876543210@ybl"


def test_credit_without_payee_records_income_and_asks(
    headers: Headers, db_session: Session
) -> None:
    fed = bank(headers, last4="1244", balance="19518.36")
    body = entry(
        sender="VM-FEDBNK",
        bank="federal",
        kind="credit",
        amount="15000.00",
        last4="1244",
        payee=None,
        ref="630508382540",
        balance="34518.36",
    )
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "category")
    [tx] = transactions(db_session)
    assert (tx.type, tx.category, tx.account_id) == ("income", None, fed)
    assert stored(db_session, body["hash"]).message == "New credit: the SMS names no payee"
    assert balance(headers, fed) == "34518.36"


def test_credit_ignores_builtin_merchants(headers: Headers, db_session: Session) -> None:
    bank(headers)
    result = one(headers, kind="credit", payee="swiggy@icici")
    assert (result["status"], result["reason"]) == ("review", "category")
    [tx] = transactions(db_session)
    assert (tx.type, tx.category) == ("income", None)


def test_user_rule_beats_builtin(headers: Headers, db_session: Session) -> None:
    bank(headers)
    user_id = db_session.scalar(select(User.id))
    db_session.add(
        PayeeRule(user_id=user_id, payee_key="swiggy@icici", display="Swiggy", category="Travel")
    )
    db_session.commit()

    assert one(headers, payee="Swiggy@ICICI")["status"] == "recorded"
    [tx] = transactions(db_session)
    assert tx.category == "Travel"


def test_rule_categorises_a_credit(headers: Headers, db_session: Session) -> None:
    bank(headers)
    user_id = db_session.scalar(select(User.id))
    db_session.add(
        PayeeRule(user_id=user_id, payee_key="acme ltd", display="Acme", category="Salary")
    )
    db_session.commit()

    assert one(headers, kind="credit", payee="ACME  Ltd", amount="50000.00")["status"] == "recorded"
    [tx] = transactions(db_session)
    assert (tx.type, tx.category) == ("income", "Salary")


def test_card_spend_records_on_the_card(headers: Headers, db_session: Session) -> None:
    bank(headers)
    c = card(headers)
    assert one(headers, kind="card_spend", last4="9876", payee="AMAZON")["status"] == "recorded"
    [tx] = transactions(db_session)
    assert (tx.account_id, tx.category) == (c, "Shopping")


# Duplicates


def test_same_hash_twice_records_once(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="swiggy@icici")
    first = send(headers, body).json()["results"]
    second = send(headers, body, body).json()["results"]
    assert first[0]["status"] == "recorded"
    assert [r["status"] for r in second] == ["duplicate", "duplicate"]
    assert [r["reason"] for r in second] == [None, None]
    assert len(transactions(db_session)) == 1
    assert db_session.scalar(select(func.count()).select_from(SmsEntry)) == 1


def test_concurrent_hash_conflict_is_duplicate(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    bank(headers)
    body = entry(payee="swiggy@icici")
    user_id = db_session.scalar(select(User.id))
    real = ingest_module._find_by_hash
    calls = 0

    def racing(db: Session, uid: int, hash_: str) -> SmsEntry | None:
        nonlocal calls
        calls += 1
        if calls == 1:  # another upload stores the same message between our check and insert
            db.add(
                SmsEntry(
                    user_id=uid,
                    hash=hash_,
                    sender="AD-BOIIND",
                    bank="boi",
                    kind="debit",
                    occurred_on=date.today(),
                    status="recorded",
                )
            )
            db.commit()
            return None
        return real(db, uid, hash_)

    monkeypatch.setattr(ingest_module, "_find_by_hash", racing)
    results = send(headers, body).json()["results"]
    assert results == [{"hash": body["hash"], "status": "duplicate", "reason": None}]
    assert transactions(db_session) == []
    count = select(func.count()).select_from(SmsEntry).where(SmsEntry.user_id == user_id)
    assert db_session.scalar(count) == 1


def test_same_ref_same_account_is_duplicate(headers: Headers, db_session: Session) -> None:
    bank(headers)
    assert one(headers, ref="631529109575", payee="Blinkit")["status"] == "recorded"
    again = entry(ref="631529109575", payee="Blinkit")
    result = send(headers, again).json()["results"][0]
    assert result["status"] == "duplicate"
    assert len(transactions(db_session)) == 1
    assert stored(db_session, again["hash"]).status == "duplicate"


def test_same_ref_other_account_is_not_duplicate(headers: Headers, db_session: Session) -> None:
    bank(headers)
    bank(headers, last4="5678", name="Other")
    one(headers, ref="631529109575")
    assert one(headers, ref="631529109575", last4="5678")["status"] == "recorded"
    assert len(transactions(db_session)) == 2


def test_matches_single_manual_entry_within_a_day(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    yesterday = (today_india() - timedelta(days=1)).isoformat()
    typed = manual(
        headers,
        type="expense",
        account_id=b,
        amount="300.00",
        date=yesterday,
        category="Groceries",
    )
    body = entry(amount="300.00", payee="Blinkit")
    assert send(headers, body).json()["results"][0]["status"] == "recorded"
    assert [t.id for t in transactions(db_session)] == [typed]
    assert stored(db_session, body["hash"]).transaction_id == typed
    assert balance(headers, b) == "9700.00"


def test_manual_two_days_away_is_not_matched(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    earlier = (today_india() - timedelta(days=2)).isoformat()
    manual(headers, type="expense", account_id=b, amount="300.00", date=earlier, category="Fuel")
    one(headers, amount="300.00", payee="Blinkit")
    assert len(transactions(db_session)) == 2


def test_manual_income_does_not_match_a_debit(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    today = today_india().isoformat()
    manual(headers, type="income", account_id=b, amount="300.00", date=today, category="Gift")
    one(headers, amount="300.00", payee="Blinkit")
    assert len(transactions(db_session)) == 2


def test_credit_matches_manual_transfer_in(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    other = bank(headers, last4="5678", name="Other")
    today = today_india().isoformat()
    typed = manual(
        headers, type="transfer", account_id=other, to_account_id=b, amount="500.00", date=today
    )
    assert one(headers, kind="credit", amount="500.00", payee=None)["status"] == "recorded"
    assert [t.id for t in transactions(db_session)] == [typed]


def test_two_manual_candidates_go_to_review(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    today = today_india()
    ids = [
        manual(
            headers,
            type="expense",
            account_id=b,
            amount="300.00",
            date=day.isoformat(),
            category="Groceries",
        )
        for day in (today - timedelta(days=1), today)
    ]
    body = entry(amount="300.00", payee="Blinkit")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "maybe_duplicate")
    assert len(transactions(db_session)) == 2
    saved = stored(db_session, body["hash"])
    assert saved.transaction_id is None
    first_day = (today - timedelta(days=1)).isoformat()
    assert saved.candidates == [
        {"kind": "transaction", "id": ids[0], "label": f"{first_day} · Groceries · ₹300"},
        {"kind": "transaction", "id": ids[1], "label": f"{today.isoformat()} · Groceries · ₹300"},
    ]


def test_manual_already_linked_is_not_matched_again(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    today = today_india().isoformat()
    manual(headers, type="expense", account_id=b, amount="300.00", date=today, category="Fuel")
    one(headers, amount="300.00", payee="Blinkit")
    one(headers, amount="300.00", payee="Blinkit")
    assert len(transactions(db_session)) == 2


# Accounts


def test_unknown_last4_asks_for_account(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(last4="0000")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "account")
    assert stored(db_session, body["hash"]).message == "Which account is XX0000?"
    assert transactions(db_session) == []


def test_last4_on_two_accounts_asks_for_account(headers: Headers, db_session: Session) -> None:
    bank(headers)
    bank(headers, name="Twin")
    result = one(headers)
    assert (result["status"], result["reason"]) == ("review", "account")
    assert transactions(db_session) == []


def test_archived_account_is_not_used(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    assert client.post(f"/api/accounts/{b}/archive", headers=headers).status_code in (200, 204)
    assert one(headers)["reason"] == "account"


def test_card_spend_ignores_bank_with_same_digits(headers: Headers, db_session: Session) -> None:
    bank(headers, last4="9876")
    c = card(headers)
    one(headers, kind="card_spend", last4="9876", payee="swiggy@icici")
    [tx] = transactions(db_session)
    assert tx.account_id == c


def test_debit_card_identifier_lands_on_bank(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    user_id = db_session.scalar(select(User.id))
    db_session.add(AccountIdentifier(user_id=user_id, account_id=b, last4="5555"))
    db_session.commit()

    assert one(headers, last4="5555", payee="swiggy@icici")["status"] == "recorded"
    [tx] = transactions(db_session)
    assert tx.account_id == b


def test_below_zero_goes_to_review_unrecorded(headers: Headers, db_session: Session) -> None:
    wallet = account(headers, "wallet", "100.00", name="Paytm")
    user_id = db_session.scalar(select(User.id))
    db_session.add(AccountIdentifier(user_id=user_id, account_id=wallet, last4="4321"))
    db_session.commit()

    body = entry(last4="4321", amount="500.00", payee="swiggy@icici")
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("review", "balance")
    saved = stored(db_session, body["hash"])
    assert "below ₹0" in (saved.message or "")
    assert saved.transaction_id is None
    assert transactions(db_session) == []


def test_card_statement_stored_without_transaction(headers: Headers, db_session: Session) -> None:
    c = card(headers)
    due = (today_india() + timedelta(days=15)).isoformat()
    body = entry(kind="card_statement", last4="9876", amount="12000.00", payee=None, due_date=due)
    result = send(headers, body).json()["results"][0]
    assert (result["status"], result["reason"]) == ("recorded", None)
    saved = stored(db_session, body["hash"])
    assert (saved.account_id, saved.transaction_id, saved.due_date.isoformat()) == (c, None, due)
    assert transactions(db_session) == []


def test_card_statement_for_unknown_card_asks(headers: Headers, db_session: Session) -> None:
    bank(headers, last4="9876")
    result = one(headers, kind="card_statement", last4="9876", amount="100.00", payee=None)
    assert (result["status"], result["reason"]) == ("review", "account")


def test_deleted_sms_transaction_is_not_brought_back(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="swiggy@icici")
    send(headers, body)
    [tx] = transactions(db_session)
    assert client.delete(f"/api/transactions/{tx.id}", headers=headers).status_code == 200
    saved = stored(db_session, body["hash"])
    assert (saved.status, saved.transaction_id) == ("ignored", None)

    assert send(headers, body).json()["results"][0]["status"] == "duplicate"
    assert transactions(db_session) == []
    assert stored(db_session, body["hash"]).status == "ignored"


def test_other_users_rules_and_accounts_unused(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    mine = bank(headers)
    other_headers = auth(db_session, monkeypatch, email="other@example.com")
    theirs = bank(other_headers, last4="7777")
    other_id = db_session.scalar(select(User.id).where(User.email == "other@example.com"))
    db_session.add_all(
        [
            PayeeRule(user_id=other_id, payee_key="ramesh", display="Ramesh", category="Gift"),
            AccountIdentifier(user_id=other_id, account_id=mine, last4="8888"),
        ]
    )
    db_session.commit()

    # Their card number, their identifier pointing at my account, and their rule: none apply.
    assert one(headers, last4="7777")["reason"] == "account"
    assert one(headers, last4="8888")["reason"] == "account"
    result = one(headers, payee="Ramesh")
    assert (result["status"], result["reason"]) == ("review", "category")
    [tx] = transactions(db_session)
    assert (tx.account_id, tx.category) == (mine, None)

    # The same hash from another user is that user's own message.
    body = entry(last4="7777", payee="Ramesh")
    send(headers, body)
    assert send(other_headers, body).json()["results"][0]["status"] == "recorded"
    assert [t.account_id for t in transactions(db_session)][-1] == theirs


# The batch


def test_each_entry_stands_alone(headers: Headers, db_session: Session) -> None:
    bank(headers)
    bodies = [entry(payee="swiggy@icici"), entry(last4="0000"), entry(payee="Ramesh")]
    results = send(headers, *bodies).json()["results"]
    assert [r["hash"] for r in results] == [b["hash"] for b in bodies]
    assert [r["status"] for r in results] == ["recorded", "review", "review"]
    assert len(transactions(db_session)) == 2


@pytest.mark.parametrize(
    "fields",
    [
        {"hash": "abc"},
        {"amount": 243.0},
        {"amount": None},
        {"amount": "0.00"},
        {"last4": "12a4"},
        {"date": (today_india() + timedelta(days=1)).isoformat()},
        {"kind": "refund"},
        {"sender": "x" * 21},
        {"text": "Debited Rs 243"},
    ],
)
def test_bad_entries_are_rejected(headers: Headers, fields: dict[str, Any]) -> None:
    assert send(headers, entry(**fields)).status_code == 422


def test_batch_size_limits(headers: Headers) -> None:
    assert send(headers).status_code == 422
    assert send(headers, *[entry(last4="0000") for _ in range(101)]).status_code == 422


def test_needs_login(headers: Headers) -> None:
    assert client.post(URL, json={"entries": [entry()]}).status_code == 401
