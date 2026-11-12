"""After a rename, every old name still lands on the renamed category (review fixes 1, 2, 4, 5)."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.categories import category_family
from app.main import app
from app.models.category import Category
from app.models.sms import PayeeRule
from app.models.transaction import Transaction
from app.models.user import User
from tests.test_accounts import Headers, auth, locs
from tests.test_categories import create, find, patch, template, tree
from tests.test_sms_ingest import bank, one
from tests.test_transactions import account, expense, income

client = TestClient(app)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def owner(db: Session) -> int:
    found = db.scalar(select(User.id).order_by(User.id).limit(1))
    assert found is not None
    return found


def sms_categories(db: Session) -> list[str | None]:
    query = select(Transaction.category).where(Transaction.source == "sms")
    return list(db.scalars(query.order_by(Transaction.id)))


def live_names(headers: Headers, kind: str = "expense") -> list[str]:
    return [c["name"] for c in tree(headers)[kind]]


def rename(headers: Headers, old: str, new: str, kind: str = "expense") -> None:
    response = patch(headers, find(headers, old, kind)["id"], name=new)
    assert response.status_code == 200, response.json()


def test_sms_merchant_after_a_rename_uses_the_new_name(
    headers: Headers, db_session: Session
) -> None:
    bank(headers)
    rename(headers, "Food and dining", "Eating out")

    assert one(headers, payee="swiggy@icici")["status"] == "recorded"

    assert sms_categories(db_session) == ["Eating out"]
    assert "Food and dining" not in live_names(headers)


def test_rename_then_rename_keeps_every_old_name(headers: Headers, db_session: Session) -> None:
    bank(headers, balance="50000.00")
    rename(headers, "Food and dining", "Eating out")
    rename(headers, "Eating out", "Dining")

    one(headers, payee="swiggy@icici")
    a = account(headers, "cash", "5000.00")
    assert expense(headers, a, category="eating out").json()["category"] == "Dining"
    assert expense(headers, a, category="Food and dining").json()["category"] == "Dining"
    assert sms_categories(db_session) == ["Dining"]
    assert [n for n in live_names(headers) if n in {"Dining", "Eating out", "Food and dining"}] == [
        "Dining"
    ]


def test_template_and_rule_saves_after_a_rename(headers: Headers, db_session: Session) -> None:
    a = account(headers, "bank", "5000.00")
    rename(headers, "Groceries", "Kirana")
    assert template(headers, a, "groceries").json()["category"] == "Kirana"
    rule = PayeeRule(user_id=owner(db_session), payee_key="dmart", display="DMart", category="Fuel")
    db_session.add(rule)
    db_session.commit()
    response = client.patch(
        f"/api/payee-rules/{rule.id}", json={"category": "Groceries"}, headers=headers
    )
    assert response.json()["category"] == "Kirana"


def test_a_rule_left_on_a_shared_name_lands_on_the_renamed_category(
    headers: Headers, db_session: Session
) -> None:
    """Income and spending both have "Other", so the rename can't rewrite the rule."""
    bank(headers)
    rule = PayeeRule(
        user_id=owner(db_session), payee_key="kirana shop", display="Kirana", category="Other"
    )
    db_session.add(rule)
    db_session.commit()
    rename(headers, "Other", "Misc")

    db_session.expire_all()
    assert db_session.get(PayeeRule, rule.id).category == "Other"  # type: ignore[union-attr]
    assert one(headers, payee="Kirana Shop")["status"] == "recorded"
    assert one(headers, kind="credit", payee="Kirana Shop")["status"] == "recorded"

    assert sms_categories(db_session) == ["Misc", "Other"]
    assert "Other" not in live_names(headers)
    assert "Other" in live_names(headers, "income")


def test_a_category_can_be_renamed_back(headers: Headers) -> None:
    rename(headers, "Fuel", "Petrol")
    rename(headers, "Petrol", "Fuel")
    a = account(headers)
    assert expense(headers, a, category="petrol").json()["category"] == "Fuel"
    assert live_names(headers).count("Fuel") == 1


def test_filtering_finds_rows_left_under_an_old_name(headers: Headers, db_session: Session) -> None:
    """A row saved under the old name while a merge or rename ran is still found."""
    a = account(headers)
    id = expense(headers, a, category="Fuel").json()["id"]
    rename(headers, "Fuel", "Petrol")
    tx = db_session.get(Transaction, id)
    assert tx is not None
    tx.category = "Fuel"  # as if saved mid-rename
    db_session.commit()

    assert "Fuel" in category_family(db_session, owner(db_session), "Petrol")
    found = client.get("/api/transactions", params={"category": "Petrol"}, headers=headers)
    assert [t["id"] for t in found.json()["transactions"]] == [id]


def test_merged_names_are_in_the_family(headers: Headers, db_session: Session) -> None:
    snacks = create(headers, "Snacks").json()["id"]
    food = find(headers, "Food and dining")["id"]
    client.post(f"/api/categories/{snacks}/merge", json={"into_id": food}, headers=headers)
    assert "Snacks" in category_family(db_session, owner(db_session), "Food and dining")


@pytest.mark.parametrize("name", ["Uncategorised", " uncategorised "])
def test_uncategorised_is_reserved(headers: Headers, name: str) -> None:
    a = account(headers)
    response = expense(headers, a, category=name)
    assert locs(response) == [["body", "category"]]
    assert locs(income(headers, a, category=name)) == [["body", "category"]]
    assert locs(create(headers, name)) == [["body", "name"]]
    assert locs(patch(headers, find(headers, "Fuel")["id"], name=name)) == [["body", "name"]]


def test_aliases_stay_out_of_lists_and_counts(headers: Headers, db_session: Session) -> None:
    rename(headers, "Travel", "Trips")
    aliases = db_session.scalars(
        select(Category).where(Category.name == "Travel", Category.merged_into_id.is_not(None))
    ).all()
    assert len(aliases) == 1
    body: dict[str, Any] = tree(headers)
    assert "Travel" not in [c["name"] for c in body["expense"]]


def test_a_lost_race_to_create_a_name_is_a_conflict(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the name is taken between the read and the insert and still can't be read, it's a 409,
    not a 500."""
    from app.api import categories as cats

    a = account(headers)
    tree(headers)  # seeds the defaults
    monkeypatch.setattr(cats, "_find", lambda *args: None)
    response = expense(headers, a, category="Fuel")
    assert response.status_code == 409
