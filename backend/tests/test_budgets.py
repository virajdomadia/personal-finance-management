from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import budgets, cash_flow
from app.main import app
from app.models.budget import Budget
from app.models.user import User
from tests.test_accounts import Headers, auth
from tests.test_cash_flow import account, categories, record

client = TestClient(app)

URL = "/api/budgets"
TODAY = date(2026, 11, 12)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(budgets, "today_india", lambda: TODAY)
    monkeypatch.setattr(cash_flow, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def my_id(db: Session) -> int:
    return db.scalars(select(User.id).where(User.email == "me@example.com")).one()


def month(headers: Headers, **params: str) -> dict[str, Any]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def put(headers: Headers, category_id: int, amount: Any) -> Any:
    return client.put(f"{URL}/{category_id}", json={"amount": amount}, headers=headers)


def set_budget(headers: Headers, category_id: int, amount: str) -> dict[str, Any]:
    response = put(headers, category_id, amount)
    assert response.status_code == 200, response.json()
    return response.json()


def line(body: dict[str, Any], name: str) -> dict[str, Any]:
    return next(b for b in body["budgets"] if b["name"] == name)


def figures(b: dict[str, Any]) -> tuple[Any, ...]:
    return (b["amount"], b["spent"], b["left"], b["remaining"], b["over_by"], b["percent"])


def setup_food(headers: Headers) -> tuple[int, dict[str, int]]:
    """Groceries ₹6,000 and Dining ₹1,200 under Food and dining, an EMI with ₹3,000 interest,
    and October's spending. Returns the bank and the category ids."""
    bank = account(headers, "bank", name="HDFC", bank_kind="savings", balance="100000.00")
    loan = account(headers, "loan", name="Car loan", balance="300000.00")
    record(headers, "2026-11-01", "income", bank, "80000.00", category="Salary")
    record(headers, "2026-11-03", "expense", bank, "6000.00", category="Groceries")
    record(headers, "2026-11-05", "expense", bank, "1200.00", category="Dining")
    record(headers, "2026-11-05", "emi", bank, "12000.00", to_account_id=loan, interest="3000.00")
    record(headers, "2026-11-08", "transfer", bank, "500.00", to_account_id=loan)
    record(headers, "2026-10-04", "expense", bank, "4000.00", category="Groceries")
    ids = categories(headers)
    for child in ("Groceries", "Dining"):
        response = client.patch(
            f"/api/categories/{ids[child]}",
            json={"parent_id": ids["Food and dining"]},
            headers=headers,
        )
        assert response.status_code == 200, response.json()
    return bank, ids


def test_a_parents_budget_counts_its_subcategories(headers: Headers) -> None:
    _, ids = setup_food(headers)
    saved = set_budget(headers, ids["Food and dining"], "8000")
    assert figures(saved) == ("8000.00", "7200.00", "800.00", "800.00", "0.00", 90)
    assert (saved["bar"], saved["over"], saved["active"], saved["since"]) == (
        90,
        False,
        True,
        "2026-11",
    )

    body = month(headers)
    assert (body["month"], body["is_current"], body["through"]) == ("2026-11", True, "2026-11-12")
    food = line(body, "Food and dining")
    assert figures(food) == figures(saved)
    assert (food["icon"], food["parent_id"], food["counted"]) == ("food", None, True)


def test_spent_matches_the_month_report(headers: Headers) -> None:
    _, ids = setup_food(headers)
    for name in ("Food and dining", "Dining", "Loan interest", "Housing"):
        set_budget(headers, ids[name], "1000")
    body = month(headers)
    report = client.get("/api/cash-flow", headers=headers).json()
    amounts = {g["id"]: g["amount"] for g in report["spending_by_category"]}
    for g in report["spending_by_category"]:
        amounts.update({c["id"]: c["amount"] for c in g["children"]})
    for b in body["budgets"]:
        assert b["spent"] == amounts.get(b["category_id"], "0.00"), b["name"]
    # The EMI's interest is spending; its principal and the transfer aren't.
    assert line(body, "Loan interest")["spent"] == "3000.00"


def test_over_budget_and_a_total_that_counts_nothing_twice(headers: Headers) -> None:
    _, ids = setup_food(headers)
    set_budget(headers, ids["Food and dining"], "8000")
    set_budget(headers, ids["Dining"], "1000")
    set_budget(headers, ids["Shopping"], "500.50")

    body = month(headers)
    dining = line(body, "Dining")
    assert figures(dining) == ("1000.00", "1200.00", "-200.00", "0.00", "200.00", 120)
    assert (dining["over"], dining["bar"], dining["counted"]) == (True, 100, False)
    assert (dining["parent_id"], dining["parent_name"]) == (
        ids["Food and dining"],
        "Food and dining",
    )
    # Each subcategory comes right after its parent.
    assert [b["name"] for b in body["budgets"]] == ["Food and dining", "Dining", "Shopping"]
    # Dining is inside Food and dining, so the total counts it once.
    assert body["total"] == {
        "amount": "8500.50",
        "spent": "7200.00",
        "left": "1300.50",
        "remaining": "1300.50",
        "over_by": "0.00",
        "percent": 85,
        "bar": 85,
        "over": False,
    }


def test_changing_this_month_keeps_last_months_history(
    headers: Headers, db_session: Session
) -> None:
    _, ids = setup_food(headers)
    groceries = ids["Groceries"]
    db_session.add(
        Budget(
            user_id=my_id(db_session),
            category_id=groceries,
            effective_from=date(2026, 10, 1),
            amount=Decimal("5000"),
        )
    )
    db_session.commit()
    assert line(month(headers), "Groceries")["since"] == "2026-10"

    set_budget(headers, groceries, "7000")
    october = line(month(headers, month="2026-10"), "Groceries")
    assert figures(october) == ("5000.00", "4000.00", "1000.00", "1000.00", "0.00", 80)
    assert month(headers, month="2026-10")["is_current"] is False
    november = line(month(headers), "Groceries")
    assert (november["amount"], november["since"]) == ("7000.00", "2026-11")

    # Going back to October's amount leaves no row for November.
    set_budget(headers, groceries, "5000.00")
    assert line(month(headers), "Groceries")["since"] == "2026-10"
    rows = db_session.scalars(select(Budget.effective_from).where(Budget.category_id == groceries))
    assert list(rows) == [date(2026, 10, 1)]


def test_removing_ends_the_budget_from_this_month(headers: Headers, db_session: Session) -> None:
    _, ids = setup_food(headers)
    groceries = ids["Groceries"]
    db_session.add(
        Budget(
            user_id=my_id(db_session),
            category_id=groceries,
            effective_from=date(2026, 10, 1),
            amount=Decimal("5000"),
        )
    )
    db_session.commit()

    response = client.delete(f"{URL}/{groceries}", headers=headers)
    assert response.status_code == 200, response.json()
    assert "Groceries" not in [b["name"] for b in month(headers)["budgets"]]
    assert "Groceries" in [c["name"] for c in month(headers)["unbudgeted"]]
    assert line(month(headers, month="2026-10"), "Groceries")["amount"] == "5000.00"

    # Set and removed in the same month: nothing is left behind.
    set_budget(headers, ids["Travel"], "100")
    client.delete(f"{URL}/{ids['Travel']}", headers=headers)
    assert db_session.scalar(select(Budget).where(Budget.category_id == ids["Travel"])) is None

    response = client.delete(f"{URL}/{ids['Travel']}", headers=headers)
    assert response.status_code == 404
    assert response.json()["detail"] == "There's no budget for this category."


def test_unbudgeted_categories_show_what_they_spent(headers: Headers) -> None:
    _, ids = setup_food(headers)
    set_budget(headers, ids["Food and dining"], "8000")
    body = month(headers)
    unbudgeted = {c["name"]: c for c in body["unbudgeted"]}
    assert "Food and dining" not in unbudgeted
    assert unbudgeted["Groceries"]["spent"] == "6000.00"
    assert unbudgeted["Groceries"]["parent_name"] == "Food and dining"
    assert unbudgeted["Travel"]["spent"] == "0.00"
    assert "Salary" not in unbudgeted  # income has no budgets


def test_an_empty_month_has_a_zero_total(headers: Headers) -> None:
    body = month(headers)
    assert body["budgets"] == []
    assert body["total"]["amount"] == "0.00"
    assert body["total"]["percent"] is None


@pytest.mark.parametrize(
    ("amount", "message"),
    [
        (None, "Enter the budget amount."),
        ("0", "Enter an amount above zero."),
        ("-5", "Enter an amount above zero."),
        ("12.345", "Use at most 2 decimal places."),
    ],
)
def test_amount_rules(headers: Headers, amount: Any, message: str) -> None:
    ids = categories(headers)
    response = put(headers, ids["Travel"], amount)
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == message


def test_only_live_expense_categories_of_your_own(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    ids = categories(headers)
    income = client.get("/api/categories", headers=headers).json()["income"]
    salary = next(c["id"] for c in income if c["name"] == "Salary")
    response = put(headers, salary, "100")
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "Budgets are for spending categories."

    client.patch(f"/api/categories/{ids['Travel']}", json={"archived": True}, headers=headers)
    response = put(headers, ids["Travel"], "100")
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "Travel is archived. Restore it to set a budget."

    client.post(
        f"/api/categories/{ids['Fuel']}/merge", json={"into_id": ids["Transport"]}, headers=headers
    )
    response = put(headers, ids["Fuel"], "100")
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "Fuel was merged into Transport. Set it there."

    assert put(headers, 2147483647, "100").status_code == 404
    other = auth(db_session, monkeypatch, email="other@example.com")
    assert put(other, ids["Housing"], "100").status_code == 404
    assert client.delete(f"{URL}/{ids['Housing']}", headers=other).status_code == 404


def test_a_future_month_is_refused(headers: Headers) -> None:
    response = client.get(URL, params={"month": "2026-12"}, headers=headers)
    assert response.status_code == 422
    assert client.get(URL, params={"month": "2026-13"}, headers=headers).status_code == 422


def test_an_archived_categorys_budget_is_inactive(headers: Headers) -> None:
    _, ids = setup_food(headers)
    set_budget(headers, ids["Housing"], "20000")
    set_budget(headers, ids["Shopping"], "1000")
    client.patch(f"/api/categories/{ids['Housing']}", json={"archived": True}, headers=headers)

    body = month(headers)
    housing = line(body, "Housing")
    assert (housing["active"], housing["note"], housing["counted"]) == (False, "Archived", False)
    assert body["total"]["amount"] == "1000.00"
    assert "Housing" not in [c["name"] for c in body["unbudgeted"]]

    assert client.delete(f"{URL}/{ids['Housing']}", headers=headers).status_code == 200
    assert "Housing" not in [b["name"] for b in month(headers)["budgets"]]


def test_a_budget_follows_a_merge(headers: Headers) -> None:
    bank, ids = setup_food(headers)
    record(headers, "2026-11-06", "expense", bank, "700.00", category="Swiggy")
    ids = categories(headers)
    set_budget(headers, ids["Swiggy"], "2000")
    client.post(
        f"/api/categories/{ids['Swiggy']}/merge",
        json={"into_id": ids["Entertainment"]},
        headers=headers,
    )

    moved = line(month(headers), "Entertainment")
    assert (moved["category_id"], moved["amount"], moved["spent"], moved["active"]) == (
        ids["Entertainment"],
        "2000.00",
        "700.00",
        True,
    )
    assert "Swiggy" not in [b["name"] for b in month(headers)["budgets"]]

    # Setting the target's own budget ends the one that came with the merge.
    set_budget(headers, ids["Entertainment"], "3000")
    names = [(b["name"], b["amount"]) for b in month(headers)["budgets"]]
    assert names == [("Entertainment", "3000.00")]


def test_a_merged_budget_is_inactive_when_the_target_has_one(headers: Headers) -> None:
    ids = categories(headers)
    set_budget(headers, ids["Fuel"], "2000")
    set_budget(headers, ids["Transport"], "3000")
    client.post(
        f"/api/categories/{ids['Fuel']}/merge", json={"into_id": ids["Transport"]}, headers=headers
    )
    body = month(headers)
    fuel = line(body, "Fuel")
    assert (fuel["active"], fuel["counted"]) == (False, False)
    assert fuel["note"] == "Merged into Transport, which has its own budget."
    assert body["total"]["amount"] == "3000.00"
    assert client.delete(f"{URL}/{ids['Fuel']}", headers=headers).status_code == 200
    assert [b["name"] for b in month(headers)["budgets"]] == ["Transport"]
