"""Faster To review: categories suggested from the payee's history, which drafts are confident and
why, approving every confident draft at once, and payee rules made from an approved draft."""

import sys
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.exceptions import RequestValidationError
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.api import dates
from app.models.sms import PayeeRule
from tests.test_accounts import Headers, auth
from tests.test_categories import find, patch
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
from tests.test_sms_transfers import add_rule, card_payment, user_id

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
    a = waiting(headers, db_session, payee="Ramesh", amount="100.50")
    b = waiting(headers, db_session, payee="Ramesh", amount="20.25")
    c = waiting(headers, db_session, payee="Office", kind="credit", amount="5000.00")
    waiting(headers, db_session, payee="Stranger", amount="999.00")  # not confident
    assert review_list(headers)["confident"] == {
        "count": 3,
        "total": 3,
        "ids": [a["id"], b["id"], c["id"]],
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


def test_rule_from_an_entry_never_overwrites_a_different_rule(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    body = entry(payee="Ramesh")
    send(headers, body)
    add_rule(db_session, "ramesh", "Groceries")
    id_ = stored(db_session, body["hash"]).id
    response = client.post(
        "/api/payee-rules", json={"entry_id": id_, "category": "Shopping"}, headers=headers
    )
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "Ramesh already has a payee rule (Groceries). Change it in Payee rules."
    )
    same = client.post(
        "/api/payee-rules", json={"entry_id": id_, "category": "groceries"}, headers=headers
    )
    assert same.status_code == 201, same.json()
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


# Payees set up as something other than a category


def transfer_rule(db: Session, key: str, to_account_id: int) -> None:
    db.add(PayeeRule(user_id=user_id(db), payee_key=key, display=key, to_account_id=to_account_id))
    db.commit()


def test_a_payee_set_as_a_transfer_is_never_approved_as_spending(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    savings = bank(headers, last4="4321", name="savings")
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    body = entry(payee="Ramesh")
    send(headers, body)
    transfer_rule(db_session, "ramesh", savings)
    got = item(headers, db_session, body)
    assert got["confident"] is False
    assert got["suggested_category"] is None
    assert got["why"] == "Payee is set as a transfer"
    assert review_list(headers)["confident"]["count"] == 0

    result = approve(headers, (got["id"], "Gift"))
    assert result["approved"] == 0
    assert result["skipped"] == [{"id": got["id"], "reason": "Not confident any more"}]
    assert transactions(db_session)[-1].category is None

    offer = client.post(
        "/api/payee-rules", json={"entry_id": got["id"], "category": "Gift"}, headers=headers
    )
    assert offer.status_code == 409
    assert offer.json()["detail"] == (
        "Ramesh is set up as a transfer or a regular payment. Change it in Payee rules."
    )
    [rule] = rules(db_session)
    assert (rule.category, rule.to_account_id) == (None, savings)


def test_a_payee_tied_to_a_reminder_is_not_confident(headers: Headers, db_session: Session) -> None:
    b = bank(headers, balance="50000.00")
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    body = entry(payee="Ramesh")
    send(headers, body)
    rent = reminder(headers, b)
    db_session.add(
        PayeeRule(
            user_id=user_id(db_session),
            payee_key="ramesh",
            display="Ramesh",
            category="Gift",
            template_id=rent["id"],
        )
    )
    db_session.commit()
    got = item(headers, db_session, body)
    assert got["confident"] is False
    assert got["why"] == "Payee is set as a regular payment"


def test_a_payee_that_is_one_of_your_accounts_is_not_confident(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    history(headers, db_session, "XX4321", "Gift", "Gift", "Gift")
    body = entry(payee="XX4321")
    send(headers, body)
    bank(headers, last4="4321", name="savings")  # added since: the payee is now the owner's own
    got = item(headers, db_session, body)
    assert got["confident"] is False
    assert got["why"] == "Payee is set as a transfer"


def test_rule_from_an_entry_needs_money_that_takes_a_category(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    card(headers)
    paid = card_payment(payee="Bank Transfer")
    send(headers, paid)
    id_ = stored(db_session, paid["hash"]).id
    response = client.post(
        "/api/payee-rules", json={"entry_id": id_, "category": "Gift"}, headers=headers
    )
    assert response.status_code == 422
    assert rules(db_session) == []


# Sources


def test_a_known_merchant_says_so(headers: Headers, db_session: Session) -> None:
    bank(headers)
    food = find(headers, "Food and dining")
    assert patch(headers, food["id"], archived=True).status_code == 200
    body = entry(payee="swiggy@icici", amount="250.00")
    send(headers, body)  # waits: its merchant category was archived
    assert patch(headers, food["id"], archived=False).status_code == 200
    got = item(headers, db_session, body)
    assert got["suggestion_source"] == "merchant"
    assert got["suggested_category"] == "Food and dining"
    assert got["confident"] is True
    assert got["why"] == "Known merchant: Swiggy"


def test_history_counts_only_settled_messages(headers: Headers, db_session: Session) -> None:
    bank(headers)
    for _ in range(3):
        open_ = waiting(headers, db_session, payee="Ramesh")
        tx = open_["transaction_id"]
        changed = client.patch(
            f"/api/transactions/{tx}", json={"category": "Gift"}, headers=headers
        )
        assert changed.status_code == 200, changed.json()
    got = waiting(headers, db_session, payee="Ramesh")
    assert got["suggested_category"] is None
    assert got["why"] == "First time for this payee"


def test_history_counts_old_names_as_the_category_they_became(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    gift = find(headers, "Gift")
    assert patch(headers, gift["id"], name="Presents").status_code == 200
    # One row still carries the old name (saved mid-rename, say).
    first = transactions(db_session)[0]
    first.category = "Gift"
    db_session.commit()
    got = waiting(headers, db_session, payee="Ramesh")
    assert (got["suggested_category"], got["history_count"], got["confident"]) == (
        "Presents",
        3,
        True,
    )


# More than one batch


def test_summary_covers_the_oldest_200_confident_items(
    headers: Headers, db_session: Session
) -> None:
    bank(headers, balance="1000000.00")
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    bodies = [entry(payee="Ramesh", amount=f"{n + 1}.00", date=ago(5)) for n in range(201)]
    for start in range(0, 201, 100):
        assert send(headers, *bodies[start : start + 100]).status_code == 200
    ids = [stored(db_session, b["hash"]).id for b in bodies]
    summary = review_list(headers)["confident"]
    assert (summary["count"], summary["total"]) == (200, 201)
    assert summary["ids"] == ids[:200]

    result = approve(headers, *((i, "Gift") for i in summary["ids"]))
    assert result["approved"] == 200
    after = review_list(headers)["confident"]
    assert (after["count"], after["total"], after["ids"]) == (1, 1, [ids[200]])


def test_approve_skips_money_changed_since_it_was_looked_at(
    headers: Headers, db_session: Session
) -> None:
    from app.sms import review as review_module

    bank(headers)
    history(headers, db_session, "Ramesh", "Gift", "Gift", "Gift")
    got = waiting(headers, db_session, payee="Ramesh", amount="40.00")
    real = review_module._lock_transactions

    def edited_meanwhile(db: Session, user_id: int, ids: Any, also: Any = ()) -> Any:
        txs, accounts = real(db, user_id, ids, also)
        for tx in txs.values():
            tx.amount = Decimal("41.00")  # another request changed it before the lock
        return txs, accounts

    monkeypatch_ = pytest.MonkeyPatch()
    monkeypatch_.setattr(review_module, "_lock_transactions", edited_meanwhile)
    try:
        result = approve(headers, (got["id"], "Gift"))
    finally:
        monkeypatch_.undo()
    assert result["approved"] == 0
    assert result["skipped"] == [
        {"id": got["id"], "reason": "This payment changed since. Check it again."}
    ]


# Query counts


class QueryCounter:
    def __init__(self, db: Session) -> None:
        self.engine = db.get_bind()
        self.count = 0

    def __enter__(self) -> "QueryCounter":
        event.listen(self.engine, "before_cursor_execute", self._hit)
        return self

    def __exit__(self, *_: object) -> None:
        event.remove(self.engine, "before_cursor_execute", self._hit)

    def _hit(self, *_: object) -> None:
        self.count += 1


def drafts(headers: Headers, db: Session, n: int, payee: str) -> list[int]:
    history(headers, db, payee, "Gift", "Gift", "Gift")
    bodies = [entry(payee=payee, amount=f"{k + 1}.{k % 10}0") for k in range(n)]
    assert send(headers, *bodies).status_code == 200
    return [stored(db, b["hash"]).id for b in bodies]


def test_listing_takes_about_the_same_queries_for_more_items(
    headers: Headers, db_session: Session
) -> None:
    bank(headers, balance="1000000.00")
    drafts(headers, db_session, 3, "Ramesh")
    with QueryCounter(db_session) as few:
        review_list(headers)
    drafts(headers, db_session, 30, "Suresh")
    with QueryCounter(db_session) as many:
        review_list(headers)
    assert many.count - few.count <= 5, (few.count, many.count)


def test_approving_takes_a_few_queries_per_item(headers: Headers, db_session: Session) -> None:
    bank(headers, balance="1000000.00")
    ids = drafts(headers, db_session, 20, "Ramesh")
    with QueryCounter(db_session) as counted:
        result = approve(headers, *((i, "Gift") for i in ids))
    assert result["approved"] == 20
    # About 12 per item: the entry lock and the same save checks a single answer runs.
    assert counted.count <= 30 + 13 * 20, counted.count
