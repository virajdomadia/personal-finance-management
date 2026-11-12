"""Faster To review: categories suggested from the payee's history, which drafts are confident and
why, approving every confident draft at once, and payee rules made from an approved draft."""

import sys
from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.exceptions import RequestValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import dates
from app.models.sms import PayeeRule
from tests.test_accounts import Headers, auth
from tests.test_categories import patch
from tests.test_sms_expected import reminder
from tests.test_sms_ingest import (
    bank,
    card,
    client,
    entry,
    manual,
    send,
    stored,
    transactions,
)
from tests.test_sms_transfers import add_rule, card_payment

URL = "/api/sms/review"
TODAY = date(2026, 11, 13)


@pytest.fixture(autouse=True)
def frozen_today(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every module that imported `today_india` sees the same day, so nothing flakes at midnight."""
    original = dates.today_india
    for name, module in list(sys.modules.items()):
        if name.startswith(("app.", "tests.")) and getattr(module, "today_india", None) is original:
            monkeypatch.setattr(module, "today_india", lambda: TODAY)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def ago(n: int) -> str:
    return (TODAY - timedelta(days=n)).isoformat()


def review_list(headers: Headers) -> dict[str, Any]:
    response = client.get(URL, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def item(headers: Headers, db: Session, body: dict[str, Any]) -> dict[str, Any]:
    id_ = stored(db, body["hash"]).id
    return next(i for i in review_list(headers)["items"] if i["id"] == id_)


def waiting(headers: Headers, db: Session, **fields: Any) -> dict[str, Any]:
    """Sends one message and returns its review item."""
    body = entry(**fields)
    response = send(headers, body)
    assert response.status_code == 200, response.json()
    return item(headers, db, body)


def categorise(headers: Headers, id_: int, category: str) -> None:
    response = client.post(
        f"{URL}/{id_}",
        json={"action": "category", "category": category, "remember": False},
        headers=headers,
    )
    assert response.status_code == 200, response.json()


def history(headers: Headers, db: Session, payee: str, *categories: str, **fields: Any) -> None:
    """Past messages from `payee`, oldest first, each answered with its category but no rule."""
    for n, category in enumerate(categories):
        got = waiting(headers, db, payee=payee, date=ago(30 - n), **fields)
        assert got["reason"] == "category"
        categorise(headers, got["id"], category)


def approve(headers: Headers, *pairs: tuple[int, str]) -> dict[str, Any]:
    body = {"items": [{"id": i, "category": c} for i, c in pairs]}
    response = client.post(f"{URL}/approve", json=body, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def rules(db: Session) -> list[PayeeRule]:
    db.expire_all()
    return list(db.scalars(select(PayeeRule)))


# Suggestions from history


def test_payee_seen_three_times_arrives_suggested_and_confident(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh Kirana", "Groceries", "Groceries", "Groceries")
    got = waiting(headers, db_session, payee="Ramesh Kirana", amount="180.00")
    assert got["reason"] == "category"
    assert got["suggested_category"] == "Groceries"
    assert got["suggestion_source"] == "history"
    assert (got["history_count"], got["history_total"]) == (3, 3)
    assert got["confident"] is True
    assert got["why"] == "Groceries 3 of 3 times before"
    # Suggested only: nothing is categorised until the owner approves.
    assert transactions(db_session)[-1].category is None


def test_twice_before_is_suggested_but_not_confident(headers: Headers, db_session: Session) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Groceries")
    got = waiting(headers, db_session, payee="Ramesh")
    assert got["suggested_category"] == "Groceries"
    assert got["confident"] is False
    assert got["why"] == "Seen 2 times before"


def test_first_time_payee_has_no_suggestion(headers: Headers, db_session: Session) -> None:
    bank(headers)
    got = waiting(headers, db_session, payee="Ramesh")
    assert got["suggested_category"] is None
    assert got["suggestion_source"] is None
    assert got["confident"] is False
    assert got["why"] == "First time for this payee"


def test_mixed_history_needs_eighty_percent(headers: Headers, db_session: Session) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Gift", "Groceries", "Groceries")
    got = waiting(headers, db_session, payee="Ramesh")
    assert got["suggested_category"] == "Groceries"
    assert (got["history_count"], got["history_total"]) == (3, 4)
    assert got["confident"] is False  # 75%
    assert got["why"] == "Groceries only 3 of 4 times"

    history(
        headers, db_session, "Suresh", "Groceries", "Gift", "Groceries", "Groceries", "Groceries"
    )
    again = waiting(headers, db_session, payee="Suresh")
    assert (again["history_count"], again["history_total"]) == (4, 5)
    assert again["confident"] is True  # 80%
    assert again["why"] == "Groceries 4 of 5 times before"


def test_a_tie_goes_to_the_latest_category(headers: Headers, db_session: Session) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Gift", "Groceries")
    assert waiting(headers, db_session, payee="Ramesh")["suggested_category"] == "Groceries"


def test_only_recent_history_counts(headers: Headers, db_session: Session) -> None:
    bank(headers, balance="100000.00")
    history(headers, db_session, "Ramesh", *(["Gift"] * 3 + ["Groceries"] * 20))
    got = waiting(headers, db_session, payee="Ramesh")
    assert (got["suggested_category"], got["history_count"], got["history_total"]) == (
        "Groceries",
        20,
        20,
    )


def test_history_of_the_other_type_and_other_users_is_ignored(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift", kind="credit")
    other = auth(db_session, monkeypatch, email="other@example.com")
    bank(other)
    history(other, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    got = waiting(headers, db_session, payee="Ramesh")  # a debit: expense history only
    assert got["suggested_category"] is None
    assert got["confident"] is False


def test_archived_category_is_not_suggested(headers: Headers, db_session: Session) -> None:
    bank(headers)
    created = client.post(
        "/api/categories", json={"kind": "expense", "name": "Snacks"}, headers=headers
    )
    assert created.status_code == 201, created.json()
    history(headers, db_session, "Suresh", "Snacks", "Snacks", "Snacks")
    assert patch(headers, created.json()["id"], archived=True).status_code == 200
    got = waiting(headers, db_session, payee="Suresh")
    assert got["suggested_category"] is None
    assert got["confident"] is False


def test_a_rule_made_after_the_message_arrived_is_confident(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    add_rule(db_session, "ramesh", "Gift")
    got = item(headers, db_session, body)
    assert got["suggested_category"] == "Gift"
    assert got["suggestion_source"] == "rule"
    assert got["confident"] is True
    assert got["why"] == "Payee rule: Gift"


# What still needs a human


def test_an_item_offered_as_a_card_bill_payment_is_not_confident(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    card(headers)
    card(headers, last4="5555")
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    send(headers, card_payment(amount="3000.00"), card_payment(amount="3000.00", last4="5555"))
    got = waiting(headers, db_session, payee="Ramesh", amount="3000.00")
    assert got["suggested_category"] == "Gift"
    assert got["confident"] is False
    assert got["why"] == "May have paid a card bill"


def test_an_item_asked_about_as_a_transfer_is_not_confident(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    bank(headers, last4="4321", name="savings")
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    debit = entry(payee="Ramesh", amount="500.00")
    send(headers, debit)
    send(headers, entry(kind="credit", payee="Someone", amount="500.00", last4="4321"))
    got = item(headers, db_session, debit)
    assert got["confident"] is False
    assert got["why"] == "May be a transfer"


def test_a_payment_typed_in_since_is_not_confident(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    body = entry(payee="Ramesh", amount="640.00")
    send(headers, body)
    manual(
        headers,
        type="expense",
        account_id=b,
        amount="640.00",
        date=TODAY.isoformat(),
        category="Gift",
    )
    got = item(headers, db_session, body)
    assert got["confident"] is False
    assert got["why"] == "You may have typed this in"


def test_a_debit_that_may_be_a_regular_payment_is_not_confident(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers, balance="50000.00")
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    body = entry(payee="Ramesh", amount="10000.00")
    send(headers, body)
    reminder(headers, b)  # Rent for 10000.00, added after the message
    got = item(headers, db_session, body)
    assert got["confident"] is False
    assert got["why"] == "Might be your Rent"


def test_an_archived_account_is_not_confident(headers: Headers, db_session: Session) -> None:
    b = bank(headers)
    bank(headers, last4="4321", name="other")
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    body = entry(payee="Ramesh")
    send(headers, body)
    archived = client.post(f"/api/accounts/{b}/archive", headers=headers)
    assert archived.status_code == 200, archived.json()
    got = item(headers, db_session, body)
    assert got["confident"] is False
    assert got["why"] == "Its account is archived"


def test_other_reasons_are_never_confident_and_say_why(
    headers: Headers, db_session: Session
) -> None:
    b = bank(headers)
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    unknown = waiting(headers, db_session, payee="Ramesh", last4="0000")
    assert unknown["reason"] == "account"
    assert unknown["confident"] is False
    assert unknown["why"] == "Account unknown"
    assert unknown["suggested_account_id"] == b  # every earlier Ramesh message was in it
    no_payee = waiting(headers, db_session, payee=None, amount="77.00")
    assert no_payee["confident"] is False
    assert no_payee["why"] == "No payee in the SMS"
    assert no_payee["suggested_account_id"] is None


def test_account_is_not_suggested_when_history_used_several(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    bank(headers, last4="4321", name="other")
    history(headers, db_session, "Ramesh", "Gift")
    history(headers, db_session, "Ramesh", "Gift", last4="4321")
    unknown = waiting(headers, db_session, payee="Ramesh", last4="0000")
    assert unknown["suggested_account_id"] is None


def test_summary_totals_the_confident_items(headers: Headers, db_session: Session) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    history(headers, db_session, "Office", "Salary", "Salary", "Salary", kind="credit")
    waiting(headers, db_session, payee="Ramesh", amount="100.50")
    waiting(headers, db_session, payee="Ramesh", amount="20.25")
    waiting(headers, db_session, payee="Office", kind="credit", amount="5000.00")
    waiting(headers, db_session, payee="Stranger", amount="999.00")  # not confident
    assert review_list(headers)["confident"] == {
        "count": 3,
        "spent": "120.75",
        "received": "5000.00",
        "categories": [
            {"category": "Salary", "type": "income", "count": 1, "amount": "5000.00"},
            {"category": "Groceries", "type": "expense", "count": 2, "amount": "120.75"},
        ],
    }


# Approving every confident draft


def test_approve_categorises_confident_items_without_making_rules(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    first = waiting(headers, db_session, payee="Ramesh", amount="100.00")
    second = waiting(headers, db_session, payee="Ramesh", amount="50.00")
    unsure = waiting(headers, db_session, payee="Stranger", amount="70.00")
    got = approve(
        headers,
        (first["id"], "Groceries"),
        (second["id"], "Groceries"),
        (unsure["id"], "Gift"),
    )
    assert got["approved"] == 2
    assert got["skipped"] == [{"id": unsure["id"], "reason": "Not confident any more"}]
    assert got["learn"] == [{"entry_id": second["id"], "payee": "Ramesh", "category": "Groceries"}]
    assert rules(db_session) == []
    by_amount = {str(t.amount): t.category for t in transactions(db_session)}
    assert by_amount["100.00"] == "Groceries"
    assert by_amount["50.00"] == "Groceries"
    assert by_amount["70.00"] is None
    left = [i["id"] for i in review_list(headers)["items"]]
    assert left == [unsure["id"]]


def test_approve_skips_a_changed_suggestion(headers: Headers, db_session: Session) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    got = waiting(headers, db_session, payee="Ramesh")
    result = approve(headers, (got["id"], "Gift"))
    assert result["approved"] == 0
    assert result["skipped"] == [{"id": got["id"], "reason": "Its suggestion changed"}]
    assert stored(db_session, entry_hash(db_session, got["id"])).reason == "category"


def entry_hash(db: Session, id_: int) -> str:
    from app.models.sms import SmsEntry

    found = db.get(SmsEntry, id_)
    assert found is not None
    return found.hash


def test_approve_skips_answered_missing_and_other_users_items(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    got = waiting(headers, db_session, payee="Ramesh")
    categorise(headers, got["id"], "Groceries")
    other = auth(db_session, monkeypatch, email="other@example.com")
    bank(other)
    history(other, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    theirs = waiting(other, db_session, payee="Ramesh")
    result = approve(
        headers,
        (got["id"], "Groceries"),
        (theirs["id"], "Groceries"),
        (2_000_000_000_000, "Groceries"),
    )
    assert result["approved"] == 0
    assert result["skipped"] == [
        {"id": got["id"], "reason": "Already answered"},
        {"id": theirs["id"], "reason": "Not found"},
        {"id": 2_000_000_000_000, "reason": "Not found"},
    ]
    assert stored(db_session, entry_hash(db_session, theirs["id"])).reason == "category"


def test_approve_is_atomic_per_item(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    good = waiting(headers, db_session, payee="Ramesh", amount="100.00")
    bad = waiting(headers, db_session, payee="Ramesh", amount="66.00")

    from app.sms import review as review_module

    real = review_module.save_checks

    def failing(db: Session, user_id: int, accounts: Any, values: Any, **kw: Any) -> Any:
        if str(values["amount"]) == "66.00":
            raise RequestValidationError(
                [{"loc": ("body", "category"), "msg": "Nope.", "type": "value_error"}]
            )
        return real(db, user_id, accounts, values, **kw)

    monkeypatch.setattr(review_module, "save_checks", failing)
    result = approve(headers, (bad["id"], "Groceries"), (good["id"], "Groceries"))
    assert result["approved"] == 1
    assert result["skipped"] == [{"id": bad["id"], "reason": "Nope."}]
    by_amount = {str(t.amount): t.category for t in transactions(db_session)}
    assert by_amount == {**by_amount, "100.00": "Groceries", "66.00": None}
    assert stored(db_session, entry_hash(db_session, bad["id"])).status == "review"


def test_approve_from_a_rule_offers_nothing_to_learn(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    add_rule(db_session, "ramesh", "Gift")
    id_ = stored(db_session, body["hash"]).id
    result = approve(headers, (id_, "Gift"))
    assert (result["approved"], result["learn"]) == (1, [])
    assert transactions(db_session)[-1].category == "Gift"


def test_approve_takes_at_most_200_items(headers: Headers) -> None:
    body = {"items": [{"id": i, "category": "Gift"} for i in range(1, 202)]}
    response = client.post(f"{URL}/approve", json=body, headers=headers)
    assert response.status_code == 422
    empty = client.post(f"{URL}/approve", json={"items": []}, headers=headers)
    assert empty.status_code == 422


def test_single_answer_still_works_on_a_confident_item(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    got = waiting(headers, db_session, payee="Ramesh", amount="12.00")
    categorise(headers, got["id"], "Gift")  # the owner picked something else
    assert transactions(db_session)[-1].category == "Gift"


# Payee rules from an approved draft


def test_rule_from_an_entry_makes_the_next_message_automatic(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Groceries", "Groceries", "Groceries")
    got = waiting(headers, db_session, payee="Ramesh")
    approve(headers, (got["id"], "Groceries"))
    response = client.post(
        "/api/payee-rules", json={"entry_id": got["id"], "category": "groceries"}, headers=headers
    )
    assert response.status_code == 201, response.json()
    made = response.json()
    assert (made["payee_key"], made["display"], made["category"]) == (
        "ramesh",
        "Ramesh",
        "Groceries",
    )
    result = send(headers, entry(payee="Ramesh")).json()["results"][0]
    assert result["status"] == "recorded"
    assert transactions(db_session)[-1].category == "Groceries"


def test_rule_from_an_entry_updates_an_existing_rule(headers: Headers, db_session: Session) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    add_rule(db_session, "ramesh", "Gift")
    id_ = stored(db_session, body["hash"]).id
    response = client.post(
        "/api/payee-rules", json={"entry_id": id_, "category": "Groceries"}, headers=headers
    )
    assert response.status_code == 201, response.json()
    [rule] = rules(db_session)
    assert rule.category == "Groceries"


def test_rule_from_an_entry_checks_the_entry(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    bank(headers)
    mine = waiting(headers, db_session, payee="Ramesh")
    no_payee = waiting(headers, db_session, payee=None, amount="5.00")
    other = auth(db_session, monkeypatch, email="other@example.com")

    def post(h: Headers, **body: Any) -> int:
        return client.post("/api/payee-rules", json=body, headers=h).status_code

    assert post(other, entry_id=mine["id"], category="Gift") == 404
    assert post(headers, entry_id=2_000_000_000_000, category="Gift") == 404
    assert post(headers, entry_id=no_payee["id"], category="Gift") == 422
    assert post(headers, entry_id=mine["id"]) == 422
    assert rules(db_session) == []
