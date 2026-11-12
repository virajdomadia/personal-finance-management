"""The To review list: answering what SMS ingestion couldn't decide, payee rules, identifiers and
unparsed samples."""

from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade
from app.models.market import MarketCode
from app.models.sms import AccountIdentifier, PayeeRule
from tests.test_accounts import Headers, auth
from tests.test_sms_demat import demat, stock
from tests.test_sms_expected import fund, nav, reminder, sip, user_id
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
from tests.test_sms_transfers import add_rule, card_payment, days_ago

URL = "/api/sms/review"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def items(headers: Headers) -> list[dict[str, Any]]:
    response = client.get(URL, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()["items"]


def answer(headers: Headers, id_: int, **body: Any) -> Response:
    return client.post(f"{URL}/{id_}", json=body, headers=headers)


def answered(headers: Headers, id_: int, **body: Any) -> dict[str, Any] | None:
    response = answer(headers, id_, **body)
    assert response.status_code == 200, response.json()
    return response.json()


def item_for(headers: Headers, hash_: str, db: Session) -> dict[str, Any]:
    id_ = stored(db, hash_).id
    return next(i for i in items(headers) if i["id"] == id_)


def broker(headers: Headers, balance: str = "100000.00") -> int:
    return account(headers, "broker", balance, name="Zerodha")


# The list


def test_review_list_shows_open_items_newest_first(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    older = entry(amount="120.00", payee="Ramesh", date=days_ago(1))
    newer = entry(amount="80.00", payee="Suresh")
    send(headers, older, newer)
    one(headers, amount="250.00", payee="swiggy@icici")  # recorded: not listed
    got = items(headers)
    assert [i["id"] for i in got] == [
        stored(db_session, newer["hash"]).id,
        stored(db_session, older["hash"]).id,
    ]
    first = got[0]
    tx = transactions(db_session)[1]
    assert first == {
        "id": stored(db_session, newer["hash"]).id,
        "status": "review",
        "kind": "debit",
        "reason": "category",
        "message": "New payee: Suresh",
        "amount": "80.00",
        "date": today_india().isoformat(),
        "payee": "Suresh",
        "last4": "1234",
        "account_id": b,
        "account_name": "bank",
        "transaction_id": tx.id,
        "trade_id": None,
        "isin": None,
        "quantity": None,
        "candidates": None,
        "suggested_price": None,
    }


def test_other_users_review_item_is_404(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    other = auth(db_session, monkeypatch, email="other@example.com")
    id_ = stored(db_session, body["hash"]).id
    assert items(other) == []
    response = answer(other, id_, action="dismiss")
    assert response.status_code == 404
    assert answer(other, 2_000_000_000_000, action="dismiss").status_code == 404
    assert stored(db_session, body["hash"]).status == "review"


def test_answered_item_cannot_be_answered_again(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    id_ = stored(db_session, body["hash"]).id
    assert answered(headers, id_, action="dismiss") is None
    assert answer(headers, id_, action="dismiss").status_code == 409


def test_wrong_action_for_reason_is_422(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    id_ = stored(db_session, body["hash"]).id
    response = answer(headers, id_, action="units_ok")
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "action"]
    assert answer(headers, id_, action="nonsense").status_code == 422
    assert stored(db_session, body["hash"]).reason == "category"


# category


def test_category_action_records_and_remembers(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="Ramesh Kirana")
    send(headers, body)
    id_ = stored(db_session, body["hash"]).id
    assert answered(headers, id_, action="category", category="groceries") is None

    [tx] = transactions(db_session)
    assert tx.category == "Groceries"  # the known spelling
    saved = stored(db_session, body["hash"])
    assert (saved.status, saved.reason, saved.message) == ("recorded", None, None)
    [rule] = db_session.scalars(select(PayeeRule)).all()
    assert (rule.payee_key, rule.display, rule.category) == (
        "ramesh kirana",
        "Ramesh Kirana",
        "Groceries",
    )
    # The next SMS from that payee is categorised by the rule.
    assert one(headers, payee="Ramesh Kirana")["status"] == "recorded"
    assert transactions(db_session)[1].category == "Groceries"


def test_category_answer_categorises_same_payee_items(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    first, second = entry(payee="Ramesh"), entry(payee="Ramesh", amount="99.00")
    credit = entry(kind="credit", payee="Ramesh", amount="50.00")  # income: other categories
    other = entry(payee="Suresh")
    send(headers, first, second, credit, other)
    got = answered(
        headers, stored(db_session, first["hash"]).id, action="category", category="Gift"
    )
    assert got is None  # it left the list

    spent = [t for t in transactions(db_session) if t.type == "expense"]
    assert [(str(t.amount), t.category) for t in spent] == [
        ("243.00", "Gift"),
        ("99.00", "Gift"),
        ("243.00", None),
    ]
    for body in (first, second):
        assert stored(db_session, body["hash"]).status == "recorded"
    for body in (credit, other):
        assert stored(db_session, body["hash"]).reason == "category"


def test_category_without_remember_answers_only_this_one(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    first, second = entry(payee="Ramesh"), entry(payee="Ramesh", amount="99.00")
    send(headers, first, second)
    id_ = stored(db_session, first["hash"]).id
    assert answered(headers, id_, action="category", category="Gift", remember=False) is None
    assert db_session.scalars(select(PayeeRule)).all() == []
    assert stored(db_session, second["hash"]).reason == "category"


def test_category_is_required(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    response = answer(headers, stored(db_session, body["hash"]).id, action="category")
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"][-1] == "category"


# account


def test_account_answer_remembered_for_next_sms(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    first = entry(last4="4321", payee="swiggy@icici")
    second = entry(last4="4321", payee="Ramesh", amount="60.00")
    elsewhere = entry(last4="5555", payee="Ramesh", amount="70.00")
    send(headers, first, second, elsewhere)
    id_ = stored(db_session, first["hash"]).id
    assert answered(headers, id_, action="account", account_id=b) is None

    [identifier] = db_session.scalars(select(AccountIdentifier)).all()
    assert (identifier.account_id, identifier.last4) == (b, "4321")
    saved = stored(db_session, first["hash"])
    assert (saved.status, saved.account_id) == ("recorded", b)
    # The other open item for XX4321 is decided again: now it only lacks a category.
    again = stored(db_session, second["hash"])
    assert (again.account_id, again.reason) == (b, "category")
    assert stored(db_session, elsewhere["hash"]).reason == "account"
    # And the next SMS from that card needs no question.
    assert one(headers, last4="4321", payee="swiggy@icici")["status"] == "recorded"
    assert balance(headers, b) == "9454.00"


def test_account_without_remember_adds_no_identifier(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    body = entry(last4="4321", payee="swiggy@icici")
    send(headers, body)
    answered(
        headers, stored(db_session, body["hash"]).id, action="account", account_id=b, remember=False
    )
    assert db_session.scalars(select(AccountIdentifier)).all() == []
    assert stored(db_session, body["hash"]).status == "recorded"


def test_account_must_fit_the_message(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    b = bank(headers)
    spend = entry(kind="card_spend", last4="4321", payee="swiggy@icici")
    send(headers, spend)
    id_ = stored(db_session, spend["hash"]).id
    response = answer(headers, id_, action="account", account_id=b)  # a bank isn't a card
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "account_id"]
    other = auth(db_session, monkeypatch, email="other@example.com")
    theirs = card(other)
    assert answer(headers, id_, action="account", account_id=theirs).status_code == 422
    assert transactions(db_session) == []


# card_payment


def test_card_payment_account_records_transfer(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    c = card(headers)
    paid = card_payment()
    send(headers, paid)
    id_ = stored(db_session, paid["hash"]).id
    response = answer(headers, id_, action="account", account_id=c)
    assert response.status_code == 422  # the card can't pay itself
    assert answered(headers, id_, action="account", account_id=b) is None

    [tx] = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id, tx.category) == ("transfer", b, c, None)
    assert stored(db_session, paid["hash"]).transaction_id == tx.id
    assert balance(headers, b) == "7000.00"
    # The card's own number isn't remembered for the bank.
    assert db_session.scalars(select(AccountIdentifier)).all() == []


def test_card_payment_transfer_converts_the_debit(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    c = card(headers)
    add_rule(db_session, "ramesh", "Gift")
    debit = entry(amount="3000.00", payee="Ramesh")
    paid = card_payment()
    send(headers, debit, paid)
    [tx] = transactions(db_session)
    id_ = stored(db_session, paid["hash"]).id

    stranger = manual(
        headers, type="expense", account_id=b, amount="3000.00", date=days_ago(0), category="Gift"
    )
    response = answer(headers, id_, action="transfer", transaction_id=stranger)
    assert response.status_code == 422  # not one of its choices

    assert answered(headers, id_, action="transfer", transaction_id=tx.id) is None
    tx, _ = transactions(db_session)
    assert (tx.type, tx.account_id, tx.to_account_id, tx.category) == ("transfer", b, c, None)
    for body in (debit, paid):
        saved = stored(db_session, body["hash"])
        assert (saved.status, saved.transaction_id) == ("recorded", tx.id)
    assert balance(headers, b) == "4000.00"


# maybe_duplicate


def _typed_twice(headers: Headers, db: Session) -> tuple[int, list[int], dict[str, Any]]:
    b = bank(headers)
    typed = [
        manual(
            headers,
            type="expense",
            account_id=b,
            amount="243.00",
            date=days_ago(d),
            category="Groceries",
        )
        for d in (0, 1)
    ]
    body = entry()
    result = send(headers, body).json()["results"][0]
    assert result["reason"] == "maybe_duplicate"
    return b, typed, body


def test_same_links_the_typed_transaction(headers: Headers, db_session: Session) -> None:
    _, typed, body = _typed_twice(headers, db_session)
    id_ = stored(db_session, body["hash"]).id
    assert answer(headers, id_, action="same", transaction_id=999999).status_code == 422
    assert answered(headers, id_, action="same", transaction_id=typed[1]) is None
    saved = stored(db_session, body["hash"])
    assert (saved.status, saved.transaction_id) == ("recorded", typed[1])
    assert len(transactions(db_session)) == 2


def test_new_records_it_as_new(headers: Headers, db_session: Session) -> None:
    b, _, body = _typed_twice(headers, db_session)
    assert answered(headers, stored(db_session, body["hash"]).id, action="new") is None
    *_, tx = transactions(db_session)
    assert (tx.type, tx.category, tx.source) == ("expense", "Groceries", "sms")
    assert balance(headers, b) == "9271.00"


# maybe_transfer


def _maybe_transfer(
    headers: Headers, db: Session
) -> tuple[int, int, dict[str, Any], dict[str, Any]]:
    a = bank(headers)
    b = bank(headers, last4="5678", name="Other")
    spend = entry(amount="500.00", payee=None)
    refund = entry(kind="credit", amount="500.00", last4="5678", payee=None)
    send(headers, spend, refund)
    assert stored(db, refund["hash"]).reason == "maybe_transfer"
    return a, b, spend, refund


def test_transfer_merges_the_two_sides(headers: Headers, db_session: Session) -> None:
    a, b, spend, refund = _maybe_transfer(headers, db_session)
    expense, income = transactions(db_session)
    id_ = stored(db_session, refund["hash"]).id
    assert answered(headers, id_, action="transfer", transaction_id=expense.id) is None

    [tx] = transactions(db_session)
    assert (tx.id, tx.type, tx.account_id, tx.to_account_id) == (expense.id, "transfer", a, b)
    assert tx.category is None
    for body in (spend, refund):
        saved = stored(db_session, body["hash"])
        assert (saved.status, saved.reason, saved.transaction_id) == ("recorded", None, tx.id)
    assert (balance(headers, a), balance(headers, b)) == ("9500.00", "10500.00")
    assert items(headers) == []


def test_transfer_candidate_gone_is_409(headers: Headers, db_session: Session) -> None:
    _, _, _, refund = _maybe_transfer(headers, db_session)
    expense, _ = transactions(db_session)
    assert client.delete(f"/api/transactions/{expense.id}", headers=headers).status_code == 200
    response = answer(
        headers, stored(db_session, refund["hash"]).id, action="transfer", transaction_id=expense.id
    )
    assert response.status_code == 409
    assert "no longer" in response.json()["detail"]


def test_transfer_candidate_already_a_transfer_is_409(
    headers: Headers, db_session: Session
) -> None:
    _, b, _, refund = _maybe_transfer(headers, db_session)
    expense, income = transactions(db_session)
    expense.type, expense.to_account_id = "transfer", b
    db_session.commit()
    id_ = stored(db_session, refund["hash"]).id
    response = answer(headers, id_, action="transfer", transaction_id=expense.id)
    assert response.status_code == 409
    assert response.json()["detail"] == "That transaction is already a transfer."
    assert [t.id for t in transactions(db_session)] == [expense.id, income.id]
    assert stored(db_session, refund["hash"]).reason == "maybe_transfer"


def test_not_a_transfer_needs_a_category_when_uncategorised(
    headers: Headers, db_session: Session
) -> None:
    _, _, _, refund = _maybe_transfer(headers, db_session)
    id_ = stored(db_session, refund["hash"]).id
    assert answer(headers, id_, action="category").status_code == 422
    assert answered(headers, id_, action="category", category="Refund") is None
    _, income = transactions(db_session)
    assert (income.type, income.category) == ("income", "Refund")


def test_not_a_transfer_keeps_a_known_category(headers: Headers, db_session: Session) -> None:
    bank(headers)
    bank(headers, last4="5678", name="Other")
    send(headers, entry(kind="credit", amount="500.00", last4="5678", payee=None))
    spend = entry(amount="500.00", payee="swiggy@icici")
    send(headers, spend)
    saved = stored(db_session, spend["hash"])
    assert saved.reason == "maybe_transfer"
    # The spend already has its category, so "not a transfer" needs none.
    assert answered(headers, saved.id, action="category") is None
    assert stored(db_session, spend["hash"]).status == "recorded"
    assert transactions(db_session)[1].category == "Food and dining"


# expected


def test_expected_replaces_the_expense_with_the_reminder(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers, balance="50000.00")
    rent = reminder(headers, b)
    body = entry(amount="10000.00", payee="Landlord Sharma")
    send(headers, body)
    id_ = stored(db_session, body["hash"]).id
    assert answer(headers, id_, action="expected", kind="emi", id=rent["id"]).status_code == 422
    assert answered(headers, id_, action="expected", kind="template", id=rent["id"]) is None

    [tx] = transactions(db_session)
    assert (tx.type, tx.category, tx.recurring_template_id) == ("expense", "Housing", rent["id"])
    assert stored(db_session, body["hash"]).transaction_id == tx.id
    [rule] = db_session.scalars(select(PayeeRule)).all()
    assert (rule.payee_key, rule.template_id) == ("landlord sharma", rent["id"])
    assert balance(headers, b) == "40000.00"
    # Next month's rent from that payee ticks the reminder off by itself (rule narrows it).


def _sip_or_rent(headers: Headers, db: Session) -> tuple[int, int, int, dict[str, Any]]:
    b = bank(headers, balance="50000.00")
    f = fund(headers)
    s = sip(db, f, b)
    reminder(headers, b, amount="5000.00")
    body = entry(amount="5000.00", payee="BSE LIMITED")
    send(headers, body)
    assert stored(db, body["hash"]).reason == "expected"
    return b, f, s, body


def test_expected_sip_becomes_an_estimated_fund_buy(headers: Headers, db_session: Session) -> None:
    b, f, s, body = _sip_or_rent(headers, db_session)
    nav(db_session, f, "50.0000")
    id_ = stored(db_session, body["hash"]).id
    got = answered(headers, id_, action="expected", kind="sip", id=s)
    assert got is not None and got["reason"] == "sip_units"

    assert transactions(db_session) == []
    [trade] = db_session.scalars(select(InvestmentTrade)).all()
    assert (trade.sip_id, trade.quantity, trade.estimated) == (s, Decimal("100.000"), True)
    assert got["trade_id"] == trade.id and got["transaction_id"] is None
    assert balance(headers, b) == "45000.00"
    assert db_session.scalars(select(PayeeRule)).all() == []  # only reminders are remembered


def test_expected_that_cant_be_applied_changes_nothing(
    headers: Headers, db_session: Session
) -> None:
    b, _, s, body = _sip_or_rent(headers, db_session)  # the fund has no NAV
    id_ = stored(db_session, body["hash"]).id
    response = answer(headers, id_, action="expected", kind="sip", id=s)
    assert response.status_code == 422
    [tx] = transactions(db_session)
    saved = stored(db_session, body["hash"])
    assert (saved.reason, saved.transaction_id) == ("expected", tx.id)
    assert balance(headers, b) == "45000.00"


def test_expected_none_of_these_takes_a_category(headers: Headers, db_session: Session) -> None:
    _, _, _, body = _sip_or_rent(headers, db_session)
    id_ = stored(db_session, body["hash"]).id
    assert answered(headers, id_, action="category", category="Shopping", remember=False) is None
    [tx] = transactions(db_session)
    assert (tx.type, tx.category) == ("expense", "Shopping")


# sip_units


def _estimated(headers: Headers, db: Session) -> tuple[int, dict[str, Any]]:
    b = bank(headers, balance="50000.00")
    f = fund(headers)
    sip(db, f, b)
    nav(db, f, "50.1234")
    body = entry(amount="5000.00", payee="BSE LIMITED")
    send(headers, body)
    return f, body


def test_units_action_fixes_the_trade(headers: Headers, db_session: Session) -> None:
    f, body = _estimated(headers, db_session)
    id_ = stored(db_session, body["hash"]).id
    bad = answer(headers, id_, action="units", units="10.000", nav="50.1234")
    assert bad.status_code == 422  # doesn't match the amount
    assert answered(headers, id_, action="units", units="99.800", nav="50.1002") is None
    db_session.expire_all()
    [trade] = db_session.scalars(select(InvestmentTrade)).all()
    assert (trade.quantity, trade.price, trade.estimated) == (
        Decimal("99.800"),
        Decimal("50.1002"),
        False,
    )
    trades = client.get("/api/investments/fund-trades", headers=headers).json()["trades"]
    assert trades[0]["estimated"] is False
    assert stored(db_session, body["hash"]).status == "recorded"


def test_units_ok_keeps_them(headers: Headers, db_session: Session) -> None:
    _, body = _estimated(headers, db_session)
    trades = client.get("/api/investments/fund-trades", headers=headers).json()["trades"]
    assert trades[0]["estimated"] is True
    assert answered(headers, stored(db_session, body["hash"]).id, action="units_ok") is None
    db_session.expire_all()
    [trade] = db_session.scalars(select(InvestmentTrade)).all()
    assert (trade.quantity, trade.estimated) == (Decimal("99.754"), False)


def test_deleting_the_trade_ignores_its_entry(headers: Headers, db_session: Session) -> None:
    _, body = _estimated(headers, db_session)
    trade_id = stored(db_session, body["hash"]).trade_id
    assert (
        client.delete(f"/api/investments/fund-trades/{trade_id}", headers=headers).status_code
        == 200
    )
    saved = stored(db_session, body["hash"])
    assert (saved.status, saved.trade_id) == ("ignored", None)
    assert items(headers) == []


# demat


def test_trade_action_records_the_owned_stock(headers: Headers, db_session: Session) -> None:
    sid = stock(db_session, "INFY", "Infosys Ltd")
    db_session.add(
        InstrumentPrice(
            user_id=user_id(db_session),
            instrument_id=sid,
            date=today_india() - timedelta(days=1),
            price=Decimal("1490.5"),
        )
    )
    db_session.commit()
    z = broker(headers)
    result = demat(headers, ref="credit", payee="INFOSYS LIMITED", quantity="5")
    shown = item_for(headers, result["hash"], db_session)
    assert (shown["status"], shown["quantity"], shown["suggested_price"]) == (
        "draft",
        "5",
        "1490.50",
    )
    id_ = shown["id"]
    assert (
        answered(headers, id_, action="trade", stock_id=sid, account_id=z, price="1500.00") is None
    )

    [trade] = db_session.scalars(select(InvestmentTrade)).all()
    assert (trade.instrument_id, trade.side, trade.quantity, trade.price) == (
        sid,
        "buy",
        Decimal(5),
        Decimal("1500.00"),
    )
    saved = stored(db_session, result["hash"])
    assert (saved.status, saved.trade_id) == ("recorded", trade.id)
    assert balance(headers, z) == "92500.00"
    # Deleting the trade leaves the message known but ignored.
    assert client.delete(f"/api/investments/trades/{trade.id}", headers=headers).status_code == 200
    assert stored(db_session, result["hash"]).status == "ignored"


def test_trade_action_creates_stock_when_missing(headers: Headers, db_session: Session) -> None:
    db_session.add(
        MarketCode(
            kind="stock", code="HINDCOPPER", name="Hindustan Copper Limited", isin="INE531E01026"
        )
    )
    db_session.commit()
    z = broker(headers)
    result = demat(headers, ref="credit", quantity="10", isin="INE531E01026")
    id_ = stored(db_session, result["hash"]).id
    missing = answer(headers, id_, action="trade", account_id=z, price="300.00")
    assert missing.status_code == 422  # a new stock needs its symbol and name
    got = answered(
        headers,
        id_,
        action="trade",
        account_id=z,
        price="300.00",
        charges="5.00",
        symbol="hindcopper",
        name="Hindustan Copper",
    )
    assert got is None
    [created] = db_session.scalars(select(Instrument).where(Instrument.kind == "stock")).all()
    assert (created.symbol, created.name, created.source_code) == (
        "HINDCOPPER",
        "Hindustan Copper",
        "HINDCOPPER",
    )
    [trade] = db_session.scalars(select(InvestmentTrade)).all()
    assert (trade.instrument_id, trade.side, trade.amount) == (
        created.id,
        "buy",
        Decimal("3005.00"),
    )


def test_trade_action_failure_creates_no_stock(headers: Headers, db_session: Session) -> None:
    z = broker(headers, balance="0.00")
    result = demat(headers, ref="debit", quantity="10", payee="UNKNOWN CORP")
    id_ = stored(db_session, result["hash"]).id
    response = answer(
        headers, id_, action="trade", account_id=z, price="300.00", symbol="UNK", name="Unknown"
    )
    assert response.status_code == 422  # selling shares never held
    assert db_session.scalars(select(Instrument)).all() == []
    assert stored(db_session, result["hash"]).status == "draft"


def test_trade_with_unknown_direction_needs_a_side(headers: Headers, db_session: Session) -> None:
    sid = stock(db_session, "INFY", "Infosys Ltd")
    z = broker(headers)
    result = demat(headers, ref=None, payee="INFOSYS LIMITED", quantity="5")
    id_ = stored(db_session, result["hash"]).id
    response = answer(headers, id_, action="trade", stock_id=sid, account_id=z, price="100.00")
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "side"]
    got = answered(
        headers, id_, action="trade", stock_id=sid, account_id=z, price="100.00", side="buy"
    )
    assert got is None


# dismiss and retry


def test_dismiss_recorded_keeps_the_transaction(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    assert answered(headers, stored(db_session, body["hash"]).id, action="dismiss") is None
    [tx] = transactions(db_session)
    assert tx.category is None
    saved = stored(db_session, body["hash"])
    assert (saved.status, saved.transaction_id) == ("recorded", tx.id)


def test_dismiss_unrecorded_ignores(headers: Headers, db_session: Session) -> None:
    bank(headers)
    card(headers)
    paid = card_payment()
    send(headers, paid)
    assert answered(headers, stored(db_session, paid["hash"]).id, action="dismiss") is None
    saved = stored(db_session, paid["hash"])
    assert (saved.status, saved.transaction_id) == ("ignored", None)
    assert transactions(db_session) == []


def test_retry_after_the_balance_is_fixed(headers: Headers, db_session: Session) -> None:
    wallet = account(headers, "wallet", "100.00", name="Paytm")
    db_session.add(AccountIdentifier(user_id=user_id(db_session), account_id=wallet, last4="4321"))
    db_session.commit()
    body = entry(last4="4321", amount="500.00", payee="swiggy@icici")
    send(headers, body)
    id_ = stored(db_session, body["hash"]).id
    still = answered(headers, id_, action="retry")
    assert still is not None and still["reason"] == "balance"
    fixed = client.patch(f"/api/accounts/{wallet}", json={"balance": "1000.00"}, headers=headers)
    assert fixed.status_code == 200, fixed.json()
    assert answered(headers, id_, action="retry") is None
    [tx] = transactions(db_session)
    assert (tx.account_id, tx.category) == (wallet, "Food and dining")


# Payee rules


def test_payee_rules_list_edit_and_delete(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    b = bank(headers)
    rent = reminder(headers, b)
    uid = user_id(db_session)
    rule = PayeeRule(
        user_id=uid, payee_key="ramesh", display="Ramesh", category="Gift", template_id=rent["id"]
    )
    db_session.add(rule)
    db_session.commit()
    got = client.get("/api/payee-rules", headers=headers).json()["rules"]
    assert got == [
        {
            "id": rule.id,
            "payee_key": "ramesh",
            "display": "Ramesh",
            "category": "Gift",
            "to_account_id": None,
            "to_account_name": None,
            "template_id": rent["id"],
            "template_name": "Rent",
        }
    ]
    url = f"/api/payee-rules/{rule.id}"
    both = client.patch(url, json={"to_account_id": b}, headers=headers)
    assert both.status_code == 422  # a category and an account
    moved = client.patch(
        url, json={"category": None, "to_account_id": b, "template_id": None}, headers=headers
    )
    assert moved.status_code == 200, moved.json()
    assert moved.json()["to_account_name"] == "bank" and moved.json()["template_id"] is None
    assert client.patch(url, json={"template_id": rent["id"]}, headers=headers).status_code == 422

    other = auth(db_session, monkeypatch, email="other@example.com")
    assert client.get("/api/payee-rules", headers=other).json()["rules"] == []
    assert (
        client.patch(
            url, json={"category": "Gift", "to_account_id": None}, headers=other
        ).status_code
        == 404
    )
    assert client.delete(url, headers=other).status_code == 404
    assert client.delete(url, headers=headers).status_code == 200
    assert client.get("/api/payee-rules", headers=headers).json()["rules"] == []


def test_deleting_template_keeps_rule_without_link(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    rent = reminder(headers, b)
    db_session.add(
        PayeeRule(
            user_id=user_id(db_session),
            payee_key="sharma",
            display="Sharma",
            template_id=rent["id"],
        )
    )
    db_session.commit()
    assert client.delete(f"/api/recurring/{rent['id']}", headers=headers).status_code == 200
    [rule] = client.get("/api/payee-rules", headers=headers).json()["rules"]
    assert (rule["payee_key"], rule["template_id"]) == ("sharma", None)


# Identifiers


def test_identifiers_list_and_delete(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    b = bank(headers)
    found = AccountIdentifier(user_id=user_id(db_session), account_id=b, last4="4321")
    db_session.add(found)
    db_session.commit()
    got = client.get("/api/sms/identifiers", headers=headers).json()["identifiers"]
    assert got == [{"id": found.id, "account_id": b, "account_name": "bank", "last4": "4321"}]
    other = auth(db_session, monkeypatch, email="other@example.com")
    assert client.get("/api/sms/identifiers", headers=other).json()["identifiers"] == []
    assert client.delete(f"/api/sms/identifiers/{found.id}", headers=other).status_code == 404
    assert client.delete(f"/api/sms/identifiers/{found.id}", headers=headers).status_code == 200
    assert client.get("/api/sms/identifiers", headers=headers).json()["identifiers"] == []


# Samples


def test_sample_is_remasked(headers: Headers, db_session: Session) -> None:
    text = "Rs 1,234.50 debited from A/c 1234567 on 12-11-26. Ref 98765. Call 18001234."
    response = client.post(
        "/api/sms/samples", json={"sender": "AD-NEWBNK", "text": text}, headers=headers
    )
    assert response.status_code == 201, response.json()
    masked = "Rs 1,XXX.50 debited from A/c XXXXXXX on 12-11-26. Ref XXXXX. Call XXXXXXXX."
    assert response.json()["text"] == masked
    [shown] = client.get("/api/sms/samples", headers=headers).json()["samples"]
    assert (shown["sender"], shown["text"]) == ("AD-NEWBNK", masked)
    long = client.post("/api/sms/samples", json={"sender": "X", "text": "a" * 501}, headers=headers)
    assert long.status_code == 422


def test_samples_list_newest_fifty(headers: Headers, db_session: Session) -> None:
    for n in range(52):
        client.post(
            "/api/sms/samples", json={"sender": "AD-X", "text": f"sample {n:02d}"}, headers=headers
        )
    got = client.get("/api/sms/samples", headers=headers).json()["samples"]
    assert len(got) == 50
    assert got[0]["text"] == "sample 51" and got[-1]["text"] == "sample 02"
