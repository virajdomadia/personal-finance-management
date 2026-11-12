from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.categories import usable
from app.main import app
from app.models.category import Category
from app.models.recurring import RecurringTemplate
from app.models.sms import PayeeRule
from app.models.transaction import Transaction
from app.models.user import User
from tests.test_accounts import Headers, auth, locs
from tests.test_transactions import account, expense, income

client = TestClient(app)

URL = "/api/categories"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def tree(headers: Headers) -> dict[str, Any]:
    response = client.get(URL, headers=headers)
    assert response.status_code == 200
    return response.json()


def find(headers: Headers, name: str, kind: str = "expense") -> dict[str, Any]:
    return next(c for c in tree(headers)[kind] if c["name"] == name)


def create(headers: Headers, name: str, kind: str = "expense", **extra: Any) -> Response:
    return client.post(URL, json={"kind": kind, "name": name, **extra}, headers=headers)


def patch(headers: Headers, id: int, **body: Any) -> Response:
    return client.patch(f"{URL}/{id}", json=body, headers=headers)


def merge(headers: Headers, id: int, into_id: int) -> Response:
    return client.post(f"{URL}/{id}/merge", json={"into_id": into_id}, headers=headers)


def picker(headers: Headers, kind: str = "expense") -> list[str]:
    return client.get("/api/transactions/categories", headers=headers).json()[kind]


def template(headers: Headers, account_id: int, category: str) -> Response:
    return client.post(
        "/api/recurring",
        json={
            "name": "Order",
            "type": "expense",
            "amount": "300.00",
            "account_id": account_id,
            "category": category,
            "frequency": "monthly",
            "day": 5,
            "start_date": "2026-01-05",
        },
        headers=headers,
    )


def user_id(db: Session) -> int:
    found = db.scalar(select(User.id).order_by(User.id).limit(1))
    assert found is not None
    return found


def rule(db: Session, category: str) -> PayeeRule:
    made = PayeeRule(user_id=user_id(db), payee_key="swiggy", display="Swiggy", category=category)
    db.add(made)
    db.commit()
    return made


# Seeding and listing


def test_a_new_user_gets_the_defaults_with_icons_and_colours(headers: Headers) -> None:
    body = tree(headers)
    names = [c["name"] for c in body["expense"]]
    assert names[:3] == ["Groceries", "Food and dining", "Transport"]
    assert "Loan interest" in names
    groceries = body["expense"][0]
    assert groceries["icon"] == "groceries"
    assert groceries["colour"].startswith("#")
    assert groceries["archived"] is False
    assert [c["name"] for c in body["income"]][0] == "Salary"
    assert "food" in body["icons"]


def test_fixed_categories_are_marked(headers: Headers) -> None:
    assert find(headers, "Insurance")["fixed"] is True
    assert find(headers, "Loan interest")["fixed"] is True
    assert find(headers, "Interest", "income")["fixed"] is True
    assert find(headers, "Groceries")["fixed"] is False


def test_a_typed_category_joins_the_registry(headers: Headers) -> None:
    a = account(headers)
    assert expense(headers, a, category="Pet Food").json()["category"] == "Pet Food"
    assert expense(headers, a, category="pet FOOD").json()["category"] == "Pet Food"
    pet = find(headers, "Pet Food")
    assert pet["transaction_count"] == 2
    assert pet["icon"] is None


def test_counts_include_emi_interest_under_loan_interest(headers: Headers) -> None:
    a = account(headers)
    expense(headers, a, category="Groceries")
    income(headers, a, category="Salary")
    assert find(headers, "Groceries")["transaction_count"] == 1
    assert find(headers, "Salary", "income")["transaction_count"] == 1


def test_another_users_categories_are_private(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers
) -> None:
    id = create(headers, "Secret").json()["id"]
    other = auth(db_session, monkeypatch, "other@example.com")
    assert "Secret" not in [c["name"] for c in tree(other)["expense"]]
    assert patch(other, id, name="Mine").status_code == 404
    assert merge(other, id, find(other, "Groceries")["id"]).status_code == 404


# Creating


def test_create_with_icon_colour_and_parent(headers: Headers) -> None:
    food = find(headers, "Food and dining")
    response = create(headers, "Dining out", parent_id=food["id"], icon="food", colour="#AABBCC")
    assert response.status_code == 201
    body = response.json()
    assert (body["parent_id"], body["icon"], body["colour"]) == (food["id"], "food", "#aabbcc")
    names = [c["name"] for c in tree(headers)["expense"]]
    assert names[names.index("Food and dining") + 1] == "Dining out"


def test_create_refuses_a_name_in_use_ignoring_case(headers: Headers) -> None:
    response = create(headers, "groceries")
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "You already have Groceries."
    # The same name is fine in the other kind.
    assert create(headers, "Groceries", "income").status_code == 201


@pytest.mark.parametrize(
    "body,field",
    [
        ({"kind": "spend", "name": "X"}, "kind"),
        ({"kind": "expense", "name": " "}, "name"),
        ({"kind": "expense", "name": "x" * 41}, "name"),
        ({"kind": "expense", "name": "X", "icon": "rocket"}, "icon"),
        ({"kind": "expense", "name": "X", "colour": "red"}, "colour"),
    ],
)
def test_create_validates(headers: Headers, body: dict[str, Any], field: str) -> None:
    response = client.post(URL, json=body, headers=headers)
    assert response.status_code == 422
    assert ["body", field] in locs(response)


def test_create_refuses_a_parent_of_the_other_kind(headers: Headers) -> None:
    salary = find(headers, "Salary", "income")
    response = create(headers, "Bonus food", parent_id=salary["id"])
    assert locs(response) == [["body", "parent_id"]]


# Renaming


def test_rename_moves_transactions_templates_and_rules(
    headers: Headers, db_session: Session
) -> None:
    a = account(headers, "bank", "5000.00")
    tx = expense(headers, a, category="Groceries").json()["id"]
    tpl = template(headers, a, "Groceries").json()["id"]
    made = rule(db_session, "Groceries")

    response = patch(headers, find(headers, "Groceries")["id"], name="Kirana")

    assert response.status_code == 200
    assert response.json()["name"] == "Kirana"
    assert client.get(f"/api/transactions/{tx}", headers=headers).json()["category"] == "Kirana"
    db_session.expire_all()
    assert db_session.get(RecurringTemplate, tpl).category == "Kirana"  # type: ignore[union-attr]
    assert db_session.get(PayeeRule, made.id).category == "Kirana"  # type: ignore[union-attr]
    assert "Groceries" not in picker(headers)


def test_rename_to_another_categorys_name_suggests_merging(headers: Headers) -> None:
    response = patch(headers, find(headers, "Groceries")["id"], name="TRAVEL")
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "You already have Travel. Merge them instead."


def test_rename_can_change_case(headers: Headers) -> None:
    response = patch(headers, find(headers, "Groceries")["id"], name="GROCERIES")
    assert response.json()["name"] == "GROCERIES"


def test_fixed_categories_cant_be_renamed_archived_or_merged_away(headers: Headers) -> None:
    insurance = find(headers, "Insurance")["id"]
    assert locs(patch(headers, insurance, name="Cover")) == [["body", "name"]]
    assert locs(patch(headers, insurance, archived=True)) == [["body", "archived"]]
    assert locs(merge(headers, insurance, find(headers, "Health")["id"])) == [["body", "into_id"]]
    # Others can be merged into it, and it can be recoloured.
    assert patch(headers, insurance, colour="#000000").status_code == 200


# Merging


def test_merge_moves_everything_and_old_names_land_in_the_target(
    headers: Headers, db_session: Session
) -> None:
    a = account(headers, "bank", "5000.00")
    tx = expense(headers, a, category="Swiggy").json()["id"]
    expense(headers, a, category="swiggy")
    tpl = template(headers, a, "Swiggy").json()["id"]
    made = rule(db_session, "Swiggy")
    swiggy, food = find(headers, "Swiggy"), find(headers, "Food and dining")

    response = merge(headers, swiggy["id"], food["id"])

    assert response.status_code == 200
    body = response.json()
    assert (body["moved_transactions"], body["moved_templates"], body["moved_rules"]) == (2, 1, 1)
    assert body["category"]["transaction_count"] == 2
    assert client.get(f"/api/transactions/{tx}", headers=headers).json()["category"] == (
        "Food and dining"
    )
    db_session.expire_all()
    assert db_session.get(RecurringTemplate, tpl).category == "Food and dining"  # type: ignore[union-attr]
    assert db_session.get(PayeeRule, made.id).category == "Food and dining"  # type: ignore[union-attr]
    assert "Swiggy" not in [c["name"] for c in tree(headers)["expense"]]
    # An old client still sending the merged name lands in the target.
    assert expense(headers, a, category="Swiggy").json()["category"] == "Food and dining"
    # The name is free for a new category.
    assert create(headers, "Swiggy").status_code == 201


def test_merge_only_touches_its_own_kind(headers: Headers) -> None:
    a = account(headers, "bank", "5000.00")
    income(headers, a, category="Other")
    expense(headers, a, category="Other")
    merge(headers, find(headers, "Other")["id"], find(headers, "Shopping")["id"])
    rows = client.get("/api/transactions", headers=headers).json()["transactions"]
    assert sorted((t["type"], t["category"]) for t in rows) == [
        ("expense", "Shopping"),
        ("income", "Other"),
    ]


def test_merge_moves_subcategories_and_earlier_merges(
    headers: Headers, db_session: Session
) -> None:
    food = find(headers, "Food and dining")["id"]
    snacks = create(headers, "Snacks").json()["id"]
    chai = create(headers, "Chai", parent_id=snacks).json()["id"]
    old = create(headers, "Tea stalls").json()["id"]
    assert merge(headers, old, snacks).status_code == 200

    assert merge(headers, snacks, food).status_code == 200

    assert find(headers, "Chai")["parent_id"] == food
    assert db_session.get(Category, old).merged_into_id == food  # type: ignore[union-attr]
    assert expense(headers, account(headers), category="Tea stalls").json()["category"] == (
        "Food and dining"
    )
    assert chai


@pytest.mark.parametrize("case", ["itself", "archived", "own child", "two levels", "kind"])
def test_merge_refusals(headers: Headers, case: str) -> None:
    food = find(headers, "Food and dining")["id"]
    source = create(headers, "Snacks").json()["id"]
    if case == "itself":
        target = source
    elif case == "archived":
        target = create(headers, "Old").json()["id"]
        patch(headers, target, archived=True)
    elif case == "own child":
        target = create(headers, "Chips", parent_id=source).json()["id"]
    elif case == "two levels":
        create(headers, "Chips", parent_id=source)
        target = create(headers, "Dining", parent_id=food).json()["id"]
    else:
        target = find(headers, "Salary", "income")["id"]
    response = merge(headers, source, target)
    assert response.status_code == 422
    assert locs(response) == [["body", "into_id"]]


def test_a_merged_category_is_not_found(headers: Headers) -> None:
    snacks = create(headers, "Snacks").json()["id"]
    merge(headers, snacks, find(headers, "Food and dining")["id"])
    assert patch(headers, snacks, name="Again").status_code == 404


# Archiving


def test_archive_hides_from_pickers_but_keeps_history(headers: Headers) -> None:
    a = account(headers)
    tx = expense(headers, a, category="Fuel").json()["id"]
    fuel = find(headers, "Fuel")["id"]

    assert patch(headers, fuel, archived=True).json()["archived"] is True

    assert "Fuel" not in picker(headers)
    assert find(headers, "Fuel")["archived"] is True
    response = expense(headers, a, category="fuel")
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "Fuel is archived. Restore it to use it."
    # The old transaction keeps it, even when edited.
    edited = client.patch(f"/api/transactions/{tx}", json={"note": "Petrol"}, headers=headers)
    assert edited.json()["category"] == "Fuel"
    moved = client.patch(f"/api/transactions/{tx}", json={"category": "Transport"}, headers=headers)
    assert moved.json()["category"] == "Transport"
    back = client.patch(f"/api/transactions/{tx}", json={"category": "Fuel"}, headers=headers)
    assert back.status_code == 422

    assert patch(headers, fuel, archived=False).json()["archived"] is False
    assert "Fuel" in picker(headers)


def test_a_parent_with_live_subcategories_cant_be_archived(headers: Headers) -> None:
    food = find(headers, "Food and dining")["id"]
    dining = create(headers, "Dining", parent_id=food).json()["id"]
    response = patch(headers, food, archived=True)
    assert response.json()["detail"][0]["msg"] == (
        "Move or archive its subcategories first: Dining."
    )
    patch(headers, dining, archived=True)
    assert patch(headers, food, archived=True).status_code == 200
    # A subcategory can't come back while its parent is archived.
    assert locs(patch(headers, dining, archived=False)) == [["body", "archived"]]


def test_sms_skips_an_archived_category(headers: Headers, db_session: Session) -> None:
    patch(headers, find(headers, "Shopping")["id"], archived=True)
    assert usable(db_session, user_id(db_session), "expense", "Shopping") is None
    assert usable(db_session, user_id(db_session), "expense", "Fuel") == "Fuel"


# Nesting


def test_nest_and_unnest(headers: Headers) -> None:
    food = find(headers, "Food and dining")["id"]
    groceries = find(headers, "Groceries")["id"]
    assert patch(headers, groceries, parent_id=food).json()["parent_id"] == food
    assert patch(headers, groceries, parent_id=None).json()["parent_id"] is None


@pytest.mark.parametrize("case", ["itself", "grandchild", "has children", "kind"])
def test_nesting_refusals(headers: Headers, case: str) -> None:
    food = find(headers, "Food and dining")["id"]
    groceries = find(headers, "Groceries")["id"]
    if case == "itself":
        response = patch(headers, food, parent_id=food)
    elif case == "grandchild":
        patch(headers, groceries, parent_id=food)
        response = patch(headers, find(headers, "Fuel")["id"], parent_id=groceries)
    elif case == "has children":
        patch(headers, groceries, parent_id=food)
        response = patch(headers, food, parent_id=find(headers, "Shopping")["id"])
    else:
        response = patch(headers, food, parent_id=find(headers, "Salary", "income")["id"])
    assert response.status_code == 422
    assert locs(response) == [["body", "parent_id"]]


# Other writers use the registry


def test_templates_and_rules_use_the_registry_spelling(
    headers: Headers, db_session: Session
) -> None:
    a = account(headers, "bank", "5000.00")
    assert template(headers, a, "groceries").json()["category"] == "Groceries"
    made = rule(db_session, "Travel")
    response = client.patch(
        f"/api/payee-rules/{made.id}", json={"category": "food AND dining"}, headers=headers
    )
    assert response.json()["category"] == "Food and dining"


def test_transactions_store_the_registry_spelling(headers: Headers, db_session: Session) -> None:
    id = expense(headers, account(headers), category="  GROCERIES ").json()["id"]
    assert db_session.get(Transaction, id).category == "Groceries"  # type: ignore[union-attr]


def test_unauthenticated_is_refused() -> None:
    assert client.get(URL).status_code == 401
