import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.api.routes import recurring, transactions
from app.main import app
from app.models.insurance import InsurancePolicy
from app.models.user import User
from tests.test_accounts import Headers, archive, auth, locs
from tests.test_deposits import rd
from tests.test_fund_trades import bank

client = TestClient(app)

URL = "/api/recurring"
TX = "/api/transactions"
TODAY = date(2026, 11, 9)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (recurring, transactions):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


@pytest.fixture
def other(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch, email="other@example.com")


def new(headers: Headers, account_id: int, **fields: Any) -> Response:
    body = {
        "name": "Rent",
        "type": "expense",
        "amount": "20000.00",
        "account_id": account_id,
        "category": "Housing",
        "frequency": "monthly",
        "day": 1,
        "start_date": "2026-10-01",
        "remind_days": 30,
        **fields,
    }
    return client.post(URL, json=body, headers=headers)


def made(headers: Headers, account_id: int, **fields: Any) -> dict[str, Any]:
    response = new(headers, account_id, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def listed(headers: Headers) -> list[dict[str, Any]]:
    response = client.get(URL, headers=headers)
    assert response.status_code == 200
    return response.json()["templates"]


def due_items(headers: Headers) -> list[dict[str, Any]]:
    response = client.get(f"{URL}/due", headers=headers)
    assert response.status_code == 200
    return response.json()["items"]


def record(headers: Headers, account_id: int, day: str, **fields: Any) -> Response:
    body = {
        "type": "expense",
        "account_id": account_id,
        "amount": "20000.00",
        "date": day,
        "category": "Housing",
        **fields,
    }
    return client.post(TX, json=body, headers=headers)


def add_policy(db: Session, template_id: int) -> int:
    user = db.query(User).order_by(User.id).first()
    assert user is not None
    policy = InsurancePolicy(
        user_id=user.id,
        kind="health",
        insurer="Star",
        plan="Family",
        policy_number="P1",
        insured="Me",
        sum_insured=500000,
        period_start=date(2026, 1, 1),
        period_end=date(2026, 12, 31),
        premium=20000,
        template_id=template_id,
    )
    db.add(policy)
    db.commit()
    return policy.id


def test_new_monthly_template_is_due_from_its_start(headers: Headers) -> None:
    account_id = bank(headers)
    body = made(headers, account_id, remind_days=None)
    assert body["due"] == ["2026-10-01", "2026-11-01"]
    assert body["coming_up"] is None  # the default reminder window is 3 days
    assert body["remind_days"] == 3
    assert body["recorded"] == 0
    assert body["policy_id"] is None
    assert body["account_name"] == "SBI"
    assert body["to_account_id"] is None
    assert body["to_account_name"] is None
    assert body["amount"] == "20000.00"
    assert body["month"] is None
    assert body["active"] is True
    assert listed(headers) == [body]


def test_yearly_default_remind_days_is_thirty(headers: Headers) -> None:
    account_id = bank(headers)
    body = made(headers, account_id, frequency="yearly", month=12, day=5, remind_days=None)
    assert body["remind_days"] == 30
    assert body["due"] == []
    assert body["coming_up"] == "2026-12-05"


def test_recording_with_the_template_settles_an_occurrence(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    response = record(headers, account_id, "2026-10-01", recurring_template_id=template_id)
    assert response.status_code == 201, response.json()
    assert response.json()["recurring_template_id"] == template_id
    [row] = listed(headers)
    assert row["due"] == ["2026-11-01"]
    assert row["recorded"] == 1
    assert [(i["occurrence"], i["state"]) for i in due_items(headers)] == [
        ("2026-11-01", "due"),
        ("2026-12-01", "coming_up"),
    ]


def test_due_items_order_and_shape(headers: Headers) -> None:
    account_id = bank(headers)
    rent = made(headers, account_id, name="Rent")
    gym = made(headers, account_id, name="Gym", day=12, start_date="2026-11-01", amount="1500.00")
    items = due_items(headers)
    assert [(i["template"]["id"], i["occurrence"], i["state"]) for i in items] == [
        (rent["id"], "2026-10-01", "due"),
        (rent["id"], "2026-11-01", "due"),
        (gym["id"], "2026-11-12", "coming_up"),
        (rent["id"], "2026-12-01", "coming_up"),
    ]
    assert items[0]["template"]["name"] == "Rent"


def test_templates_are_sorted_by_name(headers: Headers) -> None:
    account_id = bank(headers)
    made(headers, account_id, name="Zed")
    made(headers, account_id, name="Alpha")
    assert [t["name"] for t in listed(headers)] == ["Alpha", "Zed"]


def test_template_that_could_never_be_recorded_is_refused(headers: Headers) -> None:
    pay_from = bank(headers)
    deposit = rd(headers, pay_from).json()["id"]
    response = new(headers, deposit)
    assert response.status_code == 422
    assert locs(response) == [["body", "account_id"]]
    assert response.json()["detail"][0]["msg"] == (
        "An RD only takes deposits, interest and withdrawals to a bank."
    )


def test_future_start_is_allowed(headers: Headers) -> None:
    account_id = bank(headers)
    body = made(headers, account_id, start_date="2027-01-01")
    assert body["due"] == []
    assert body["coming_up"] is None  # beyond the reminder window


def test_emi_is_not_a_template_type(headers: Headers) -> None:
    account_id = bank(headers)
    response = new(headers, account_id, type="emi", category=None)
    assert response.status_code == 422
    assert locs(response) == [["body", "type"]]
    assert response.json()["detail"][0]["msg"] == "Choose expense, income or transfer."


def test_transfer_template(headers: Headers) -> None:
    source = bank(headers)
    target = bank(headers, name="HDFC")
    body = made(headers, source, type="transfer", to_account_id=target, category=None)
    assert body["to_account_name"] == "HDFC"
    same = new(headers, source, type="transfer", to_account_id=source, category=None)
    assert locs(same) == [["body", "to_account_id"]]


@pytest.mark.parametrize(
    ("fields", "field", "message"),
    [
        ({"frequency": "weekly"}, "frequency", "Choose monthly or yearly."),
        ({"frequency": None}, "frequency", "Choose monthly or yearly."),
        ({"day": 0}, "day", "Choose a day from 1 to 31."),
        ({"day": 32}, "day", "Choose a day from 1 to 31."),
        ({"day": None}, "day", "Choose a day from 1 to 31."),
        ({"day": True}, "day", "Choose a day from 1 to 31."),
        ({"frequency": "yearly"}, "month", "Choose a month."),
        ({"frequency": "yearly", "month": 13}, "month", "Choose a month."),
        ({"remind_days": 61}, "remind_days", "Enter a number of days from 0 to 60."),
        ({"remind_days": -1}, "remind_days", "Enter a number of days from 0 to 60."),
        ({"end_date": "2026-09-30"}, "end_date", "The end date can't be before the start."),
        ({"name": "  "}, "name", "Enter a name."),
        ({"name": "x" * 61}, "name", "Use 60 characters or fewer."),
        ({"start_date": None}, "start_date", "Choose a date."),
        ({"amount": "0"}, "amount", "Amount must be greater than 0."),
        ({"category": None}, "category", "Choose a category."),
    ],
)
def test_template_rules(headers: Headers, fields: dict, field: str, message: str) -> None:
    account_id = bank(headers)
    response = new(headers, account_id, **fields)
    assert response.status_code == 422
    assert [(e["loc"][-1], e["msg"]) for e in response.json()["detail"]] == [(field, message)]


def test_remind_days_zero_is_allowed(headers: Headers) -> None:
    account_id = bank(headers)
    assert made(headers, account_id, remind_days=0)["coming_up"] is None


def test_patch_changes_fields_and_revalidates(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    response = client.patch(
        f"{URL}/{template_id}", json={"amount": "21000.00", "name": "Flat rent"}, headers=headers
    )
    assert response.status_code == 200, response.json()
    assert response.json()["amount"] == "21000.00"
    assert response.json()["name"] == "Flat rent"
    bad = client.patch(f"{URL}/{template_id}", json={"day": 40}, headers=headers)
    assert locs(bad) == [["body", "day"]]
    changed = client.patch(f"{URL}/{template_id}", json={"type": "income"}, headers=headers)
    assert changed.status_code == 422  # a reminder's type can't change


def test_patch_to_an_unrecordable_account_is_refused(headers: Headers) -> None:
    pay_from = bank(headers)
    deposit = rd(headers, pay_from).json()["id"]
    template_id = made(headers, pay_from)["id"]
    response = client.patch(f"{URL}/{template_id}", json={"account_id": deposit}, headers=headers)
    assert locs(response) == [["body", "account_id"]]


def test_stopping_works_even_when_the_account_is_archived(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    archived = archive(headers, account_id)
    assert archived.status_code == 200, archived.json()
    response = client.patch(f"{URL}/{template_id}", json={"active": False}, headers=headers)
    assert response.status_code == 200, response.json()
    assert response.json()["active"] is False


def test_stopped_template_is_not_due(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    client.patch(f"{URL}/{template_id}", json={"active": False}, headers=headers)
    assert due_items(headers) == []
    [row] = listed(headers)
    assert row["due"] == [] and row["coming_up"] is None
    client.patch(f"{URL}/{template_id}", json={"active": True}, headers=headers)
    assert len(due_items(headers)) == 3


def test_skip_and_unskip(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    skip = client.post(
        f"{URL}/{template_id}/skip", json={"occurrence": "2026-10-01"}, headers=headers
    )
    assert skip.status_code == 200, skip.json()
    assert skip.json()["due"] == ["2026-11-01"]
    again = client.post(
        f"{URL}/{template_id}/skip", json={"occurrence": "2026-10-01"}, headers=headers
    )
    assert again.status_code == 200
    coming = client.post(
        f"{URL}/{template_id}/skip", json={"occurrence": "2026-12-01"}, headers=headers
    )
    assert coming.json()["coming_up"] is None
    undone = client.delete(f"{URL}/{template_id}/skip/2026-10-01", headers=headers)
    assert undone.status_code == 200
    assert undone.json()["due"] == ["2026-10-01", "2026-11-01"]
    nothing = client.delete(f"{URL}/{template_id}/skip/2026-10-01", headers=headers)
    assert nothing.status_code == 200


@pytest.mark.parametrize("occurrence", ["2026-10-02", "2026-09-01", "2027-03-01", None, "soon"])
def test_skipping_a_non_occurrence_is_refused(headers: Headers, occurrence: Any) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    response = client.post(
        f"{URL}/{template_id}/skip", json={"occurrence": occurrence}, headers=headers
    )
    assert response.status_code == 422
    assert locs(response) == [["body", "occurrence"]]
    if occurrence == "2026-10-02":
        assert response.json()["detail"][0]["msg"] == "That isn't a due date for this reminder."


def test_skipping_a_recorded_occurrence_is_refused(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    record(headers, account_id, "2026-10-01", recurring_template_id=template_id)
    response = client.post(
        f"{URL}/{template_id}/skip", json={"occurrence": "2026-10-01"}, headers=headers
    )
    assert response.status_code == 422


def test_delete_rules(headers: Headers) -> None:
    account_id = bank(headers)
    unused = made(headers, account_id, name="Unused")["id"]
    used = made(headers, account_id, name="Used")["id"]
    client.post(f"{URL}/{unused}/skip", json={"occurrence": "2026-10-01"}, headers=headers)
    record(headers, account_id, "2026-10-01", recurring_template_id=used)

    blocked = client.delete(f"{URL}/{used}", headers=headers)
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "This reminder has recorded transactions. Stop it instead."
    assert client.delete(f"{URL}/{unused}", headers=headers).json() == {"id": unused}
    assert [t["id"] for t in listed(headers)] == [used]


def test_deleting_a_policys_template_is_refused(headers: Headers, db_session: Session) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    policy_id = add_policy(db_session, template_id)
    assert listed(headers)[0]["policy_id"] == policy_id
    response = client.delete(f"{URL}/{template_id}", headers=headers)
    assert response.status_code == 409


def test_templates_are_per_user(headers: Headers, other: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    assert listed(other) == []
    assert due_items(other) == []
    for method, path, body in [
        ("patch", f"{URL}/{template_id}", {"name": "x"}),
        ("delete", f"{URL}/{template_id}", None),
        ("post", f"{URL}/{template_id}/skip", {"occurrence": "2026-10-01"}),
        ("delete", f"{URL}/{template_id}/skip/2026-10-01", None),
    ]:
        response = client.request(method, path, json=body, headers=other)
        assert response.status_code == 404, (method, path)
    assert client.patch(f"{URL}/99999999999", json={}, headers=headers).status_code == 404
    # someone else's account can't back a template
    theirs = bank(other)
    assert locs(new(headers, theirs)) == [["body", "account_id"]]


def test_unauthenticated() -> None:
    assert client.get(URL).status_code == 401


# Linking a transaction


def test_link_must_be_the_owners_template_of_the_same_type(
    headers: Headers, other: Headers
) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    income = record(
        headers,
        account_id,
        "2026-10-01",
        type="income",
        category="Salary",
        recurring_template_id=template_id,
    )
    assert income.status_code == 422
    assert locs(income) == [["body", "recurring_template_id"]]
    assert income.json()["detail"][0]["msg"] == "Choose a reminder of this type."

    theirs = made(other, bank(other))["id"]
    response = record(headers, account_id, "2026-10-01", recurring_template_id=theirs)
    assert locs(response) == [["body", "recurring_template_id"]]
    for bad in (999999, True, "1", 0, 2**40):
        response = record(headers, account_id, "2026-10-01", recurring_template_id=bad)
        assert response.status_code == 422, bad
        assert locs(response) == [["body", "recurring_template_id"]]
    assert listed(headers)[0]["recorded"] == 0


def test_edit_can_link_and_unlink(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    tx = record(headers, account_id, "2026-10-01").json()
    assert tx["recurring_template_id"] is None
    linked = client.patch(
        f"{TX}/{tx['id']}", json={"recurring_template_id": template_id}, headers=headers
    )
    assert linked.status_code == 200, linked.json()
    assert linked.json()["recurring_template_id"] == template_id
    assert listed(headers)[0]["due"] == ["2026-11-01"]
    # an edit that doesn't mention the link keeps it
    kept = client.patch(f"{TX}/{tx['id']}", json={"note": "Oct"}, headers=headers)
    assert kept.json()["recurring_template_id"] == template_id
    unlinked = client.patch(
        f"{TX}/{tx['id']}", json={"recurring_template_id": None}, headers=headers
    )
    assert unlinked.json()["recurring_template_id"] is None
    assert listed(headers)[0]["due"] == ["2026-10-01", "2026-11-01"]


def test_edit_link_of_wrong_type_is_refused(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id, type="income", category="Salary")["id"]
    tx = record(headers, account_id, "2026-10-01").json()
    response = client.patch(
        f"{TX}/{tx['id']}", json={"recurring_template_id": template_id}, headers=headers
    )
    assert locs(response) == [["body", "recurring_template_id"]]


def test_a_policys_template_cannot_be_linked_here(headers: Headers, db_session: Session) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id, name="Premium")["id"]
    add_policy(db_session, template_id)
    response = record(headers, account_id, "2026-10-01", recurring_template_id=template_id)
    assert response.status_code == 422
    assert locs(response) == [["body", "recurring_template_id"]]
    assert response.json()["detail"][0]["msg"] == "Renew the policy instead."


def test_transaction_rows_only_gain_the_new_key(headers: Headers) -> None:
    account_id = bank(headers)
    record(headers, account_id, "2026-10-01")
    [row] = client.get(TX, headers=headers).json()["transactions"]
    assert row.pop("recurring_template_id") is None
    assert set(row) == {
        "id",
        "type",
        "amount",
        "date",
        "account_id",
        "account_name",
        "to_account_id",
        "to_account_name",
        "category",
        "interest",
        "note",
        "editable",
    }


def test_deleting_a_transaction_reopens_its_occurrence(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    tx = record(headers, account_id, "2026-10-01", recurring_template_id=template_id).json()
    assert listed(headers)[0]["due"] == ["2026-11-01"]
    assert client.delete(f"{TX}/{tx['id']}", headers=headers).status_code == 200
    assert listed(headers)[0]["due"] == ["2026-10-01", "2026-11-01"]


def test_stopping_cannot_take_another_users_account(headers: Headers, other: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    theirs = bank(other, name="Secret")
    for body in ({"active": False, "account_id": theirs}, {"active": False, "account_id": 9999999}):
        response = client.patch(f"{URL}/{template_id}", json=body, headers=headers)
        assert response.status_code == 422
        assert locs(response) == [["body", "account_id"]]
        assert "Secret" not in response.text
    [row] = listed(headers)
    assert row["account_id"] == account_id and row["active"] is True


@pytest.mark.parametrize("field", ["amount", "start_date", "name"])
def test_stopping_still_needs_the_required_fields(headers: Headers, field: str) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    response = client.patch(
        f"{URL}/{template_id}", json={"active": False, field: None}, headers=headers
    )
    assert response.status_code == 422
    assert locs(response) == [["body", field]]


def test_any_shown_coming_up_date_can_be_skipped(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    for module in (recurring, transactions):
        monkeypatch.setattr(module, "today_india", lambda: date(2026, 11, 25))
    account_id = bank(headers)
    template_id = made(headers, account_id, start_date="2026-11-01", remind_days=60)["id"]
    [row] = listed(headers)
    assert row["due"] == ["2026-11-01"] and row["coming_up"] == "2026-12-01"
    first = client.post(
        f"{URL}/{template_id}/skip", json={"occurrence": "2026-12-01"}, headers=headers
    )
    assert first.status_code == 200, first.json()
    assert first.json()["coming_up"] == "2027-01-01"
    second = client.post(
        f"{URL}/{template_id}/skip", json={"occurrence": "2027-01-01"}, headers=headers
    )
    assert second.status_code == 200, second.json()
    again = client.post(
        f"{URL}/{template_id}/skip", json={"occurrence": "2026-12-01"}, headers=headers
    )
    assert again.status_code == 200


@pytest.mark.parametrize("module", ["recurring", "policies", "transactions", "stocks"])
def test_route_module_imports_on_its_own(module: str) -> None:
    """Each route module imports first in a fresh interpreter (no circular import)."""
    result = subprocess.run(
        [sys.executable, "-c", f"import app.api.routes.{module}"],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_template_of_an_archived_account_asks_for_nothing(headers: Headers) -> None:
    account_id = bank(headers)
    to_id = bank(headers, name="HDFC")
    made(headers, account_id, name="Rent")
    made(headers, account_id, name="Move", type="transfer", to_account_id=to_id, category=None)
    assert len(due_items(headers)) > 0
    assert archive(headers, to_id).status_code == 200
    rows = {r["name"]: r for r in listed(headers)}
    assert rows["Move"]["due"] == [] and rows["Move"]["coming_up"] is None
    assert rows["Rent"]["due"] != []
    assert {i["template"]["name"] for i in due_items(headers)} == {"Rent"}
    assert archive(headers, account_id).status_code == 200
    assert all(r["due"] == [] and r["coming_up"] is None for r in listed(headers))
    assert len(listed(headers)) == 2
    assert due_items(headers) == []


def test_skipped_occurrences_are_listed_oldest_first(headers: Headers) -> None:
    account_id = bank(headers)
    template_id = made(headers, account_id)["id"]
    assert listed(headers)[0]["skipped"] == []
    for day in ("2026-11-01", "2026-10-01"):
        client.post(f"{URL}/{template_id}/skip", json={"occurrence": day}, headers=headers)
    assert listed(headers)[0]["skipped"] == ["2026-10-01", "2026-11-01"]
    undone = client.delete(f"{URL}/{template_id}/skip/2026-10-01", headers=headers)
    assert undone.json()["skipped"] == ["2026-11-01"]
