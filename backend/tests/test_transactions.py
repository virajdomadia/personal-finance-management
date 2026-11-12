from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.api.routes.accounts import fmt
from app.api.routes.dashboard import today_india
from app.main import app
from app.models.transaction import Transaction
from tests.test_accounts import Headers, auth, locs, make
from tests.test_loans import bank, emi, loan

client = TestClient(app)

URL = "/api/transactions"
DAY = "2026-01-15"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def account(headers: Headers, type_: str = "cash", balance: str = "1000.00", **extra: Any) -> int:
    if type_ == "bank":
        extra.setdefault("bank_kind", "savings")
    response = make(headers, type=type_, balance=balance, **extra)
    assert response.status_code == 201
    return response.json()["id"]


def balance_of(headers: Headers, id: int) -> str:
    accounts = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a for a in accounts if a["id"] == id)["balance"]


def post(headers: Headers, **fields: Any) -> Response:
    return client.post(URL, json={"date": DAY, **fields}, headers=headers)


def expense(headers: Headers, account_id: int, amount: str = "100.00", **fields: Any) -> Response:
    return post(
        headers,
        type="expense",
        account_id=account_id,
        amount=amount,
        category=fields.pop("category", "Groceries"),
        **fields,
    )


def income(headers: Headers, account_id: int, amount: str = "100.00", **fields: Any) -> Response:
    return post(
        headers,
        type="income",
        account_id=account_id,
        amount=amount,
        category=fields.pop("category", "Salary"),
        **fields,
    )


def transfer(headers: Headers, from_id: int, to_id: int, amount: str = "100.00") -> Response:
    return post(headers, type="transfer", account_id=from_id, to_account_id=to_id, amount=amount)


# Balances


def test_expense_reduces_a_bank_balance(headers: Headers) -> None:
    bank = account(headers, "bank")
    assert expense(headers, bank, "250.50").status_code == 201
    assert balance_of(headers, bank) == "749.50"


def test_income_raises_a_bank_balance(headers: Headers) -> None:
    bank = account(headers, "bank")
    assert income(headers, bank, "0.10").status_code == 201
    assert income(headers, bank, "0.20").status_code == 201
    assert balance_of(headers, bank) == "1000.30"


def test_expense_on_a_card_raises_what_is_owed(headers: Headers) -> None:
    card = account(headers, "credit_card", "500.00")
    assert expense(headers, card, "100.00").status_code == 201
    assert balance_of(headers, card) == "600.00"


def test_refund_on_a_card_lowers_what_is_owed(headers: Headers) -> None:
    card = account(headers, "credit_card", "500.00")
    assert income(headers, card, "100.00", category="Refund").status_code == 201
    assert balance_of(headers, card) == "400.00"


def test_card_bill_payment_lowers_both_balances_and_keeps_net_worth(headers: Headers) -> None:
    bank = account(headers, "bank", "1000.00")
    card = account(headers, "credit_card", "400.00")
    before = client.get("/api/dashboard", headers=headers).json()["net_worth"]

    assert transfer(headers, bank, card, "400.00").status_code == 201

    assert balance_of(headers, bank) == "600.00"
    assert balance_of(headers, card) == "0.00"
    assert client.get("/api/dashboard", headers=headers).json()["net_worth"] == before


def test_transfer_out_of_a_card_raises_what_is_owed(headers: Headers) -> None:
    card = account(headers, "credit_card", "0.00")
    cash = account(headers, "cash", "0.00")
    assert transfer(headers, card, cash, "300.00").status_code == 201
    assert balance_of(headers, card) == "300.00"
    assert balance_of(headers, cash) == "300.00"


def test_totals_and_available_credit_use_the_live_balance(headers: Headers) -> None:
    bank = account(headers, "bank", "1000.00")
    card = account(headers, "credit_card", "100.00", credit_limit="500.00")
    assert expense(headers, bank, "200.00").status_code == 201
    assert expense(headers, card, "50.00").status_code == 201

    body = client.get("/api/accounts", headers=headers).json()

    assert body["total_have"] == "800.00"
    assert body["total_owe"] == "150.00"
    assert next(a for a in body["accounts"] if a["id"] == card)["available_credit"] == "350.00"


def test_dashboard_credit_used_follows_card_spending(headers: Headers) -> None:
    card = account(headers, "credit_card", "0.00", credit_limit="1000.00")
    assert expense(headers, card, "250.00").status_code == 201
    assert client.get("/api/dashboard", headers=headers).json()["credit_used"] == {"percent": 25}


def test_archive_and_restore_report_the_live_balance(headers: Headers) -> None:
    bank = account(headers, "bank")
    assert expense(headers, bank, "100.00").status_code == 201

    archived = client.post(f"/api/accounts/{bank}/archive", headers=headers).json()
    restored = client.post(f"/api/accounts/{bank}/restore", headers=headers).json()

    assert archived["balance"] == "900.00"
    assert restored["balance"] == "900.00"


# Correcting an account's balance


def test_correcting_a_balance_keeps_transactions_and_lands_on_the_new_figure(
    headers: Headers,
) -> None:
    bank = account(headers, "bank", "1000.00")
    assert expense(headers, bank, "100.00").status_code == 201

    response = client.patch(f"/api/accounts/{bank}", json={"balance": "500.00"}, headers=headers)

    assert response.json()["balance"] == "500.00"
    assert client.get(URL, headers=headers).json()["transactions"][0]["amount"] == "100.00"
    assert expense(headers, bank, "50.00").status_code == 201
    assert balance_of(headers, bank) == "450.00"


def test_correcting_a_card_balance_lands_on_the_new_figure(headers: Headers) -> None:
    card = account(headers, "credit_card", "0.00")
    assert expense(headers, card, "100.00").status_code == 201

    response = client.patch(f"/api/accounts/{card}", json={"balance": "30.00"}, headers=headers)

    assert response.json()["balance"] == "30.00"


def test_renaming_an_account_leaves_its_balance_alone(headers: Headers) -> None:
    bank = account(headers, "bank", "1000.00")
    assert expense(headers, bank, "100.00").status_code == 201

    response = client.patch(f"/api/accounts/{bank}", json={"name": "Renamed"}, headers=headers)

    assert response.json()["balance"] == "900.00"


def test_a_correction_that_overflows_the_opening_balance_is_rejected(headers: Headers) -> None:
    bank = account(headers, "bank", "999999999999.00")
    assert expense(headers, bank, "999999999999.00").status_code == 201

    response = client.patch(
        f"/api/accounts/{bank}", json={"balance": "999999999999.00"}, headers=headers
    )

    assert response.status_code == 422
    assert locs(response) == [["body", "balance"]]


# Below zero


@pytest.mark.parametrize("type_", ["cash", "wallet"])
def test_spending_more_than_cash_or_a_wallet_holds_is_rejected(
    headers: Headers, type_: str
) -> None:
    id = account(headers, type_, "100.00")

    response = expense(headers, id, "100.01")

    assert response.status_code == 422
    assert locs(response) == [["body", "amount"]]
    assert balance_of(headers, id) == "100.00"


def test_spending_cash_down_to_exactly_zero_is_allowed(headers: Headers) -> None:
    cash = account(headers, "cash", "100.00")
    assert expense(headers, cash, "100.00").status_code == 201
    assert balance_of(headers, cash) == "0.00"


def test_a_bank_may_go_overdrawn(headers: Headers) -> None:
    bank = account(headers, "bank", "100.00")
    assert expense(headers, bank, "150.00").status_code == 201
    assert balance_of(headers, bank) == "-50.00"


def test_transfer_more_than_cash_holds_is_rejected(headers: Headers) -> None:
    cash = account(headers, "cash", "100.00")
    bank = account(headers, "bank", "0.00")
    assert transfer(headers, cash, bank, "100.01").status_code == 422


def test_raising_an_expense_past_what_cash_holds_is_rejected(headers: Headers) -> None:
    cash = account(headers, "cash", "100.00")
    id = expense(headers, cash, "50.00").json()["id"]

    response = client.patch(f"{URL}/{id}", json={"amount": "100.01"}, headers=headers)

    assert response.status_code == 422
    assert balance_of(headers, cash) == "50.00"


def test_deleting_income_that_has_been_spent_is_rejected(headers: Headers) -> None:
    cash = account(headers, "cash", "0.00")
    id = income(headers, cash, "100.00").json()["id"]
    assert expense(headers, cash, "80.00").status_code == 201

    response = client.delete(f"{URL}/{id}", headers=headers)

    assert response.status_code == 409
    assert balance_of(headers, cash) == "20.00"


def test_a_transaction_that_pushes_a_balance_past_the_maximum_is_rejected(
    headers: Headers,
) -> None:
    bank = account(headers, "bank", "999999999999.00")

    response = income(headers, bank, "1.00")

    assert response.status_code == 422
    assert locs(response) == [["body", "amount"]]


# Validation


def test_response_shape(headers: Headers) -> None:
    bank = account(headers, "bank", name="HDFC")

    response = expense(headers, bank, "1234.50", note="  Weekly shop  ")

    assert response.status_code == 201
    body = response.json()
    assert isinstance(body.pop("id"), int)
    assert body == {
        "type": "expense",
        "amount": "1234.50",
        "date": DAY,
        "account_id": bank,
        "account_name": "HDFC",
        "to_account_id": None,
        "to_account_name": None,
        "category": "Groceries",
        "interest": None,
        "note": "Weekly shop",
        "recurring_template_id": None,
        "from_sms": False,
        "editable": True,
    }


@pytest.mark.parametrize("amount", ["0", "0.00", "-5.00"])
def test_amount_must_be_positive(headers: Headers, amount: str) -> None:
    response = expense(headers, account(headers), amount)
    assert response.status_code == 422
    assert locs(response) == [["body", "amount"]]


@pytest.mark.parametrize("amount", ["1.234", "abc", 12.5, "1000000000000"])
def test_amount_format_uses_the_account_money_rules(headers: Headers, amount: Any) -> None:
    response = expense(headers, account(headers), amount)
    assert response.status_code == 422
    assert ["body", "amount"] in locs(response)


@pytest.mark.parametrize(
    ("missing", "loc"),
    [("amount", "amount"), ("account_id", "account_id"), ("date", "date"), ("type", "type")],
)
def test_required_fields_are_reported_against_their_field(
    headers: Headers, missing: str, loc: str
) -> None:
    body = {
        "type": "expense",
        "account_id": account(headers),
        "amount": "1.00",
        "category": "Food",
        "date": DAY,
    }
    del body[missing]

    response = client.post(URL, json=body, headers=headers)

    assert response.status_code == 422
    assert ["body", loc] in locs(response)


@pytest.mark.parametrize("type_", ["income", "expense"])
def test_income_and_expense_need_a_category(headers: Headers, type_: str) -> None:
    response = post(headers, type=type_, account_id=account(headers), amount="1.00")
    assert response.status_code == 422
    assert locs(response) == [["body", "category"]]


def test_transfer_needs_a_destination(headers: Headers) -> None:
    response = post(headers, type="transfer", account_id=account(headers), amount="1.00")
    assert response.status_code == 422
    assert locs(response) == [["body", "to_account_id"]]


def test_transfer_to_the_same_account_is_rejected(headers: Headers) -> None:
    id = account(headers)
    response = transfer(headers, id, id)
    assert response.status_code == 422
    assert locs(response) == [["body", "to_account_id"]]


def test_transfer_rejects_a_category(headers: Headers) -> None:
    response = post(
        headers,
        type="transfer",
        account_id=account(headers),
        to_account_id=account(headers),
        amount="1.00",
        category="Food",
    )
    assert response.status_code == 422
    assert locs(response) == [["body", "category"]]


def test_expense_rejects_a_destination(headers: Headers) -> None:
    response = expense(headers, account(headers), to_account_id=account(headers))
    assert response.status_code == 422
    assert locs(response) == [["body", "to_account_id"]]


def test_future_date_is_rejected(headers: Headers) -> None:
    tomorrow = (today_india() + timedelta(days=1)).isoformat()
    response = expense(headers, account(headers), date=tomorrow)
    assert response.status_code == 422
    assert locs(response) == [["body", "date"]]


def test_today_is_allowed(headers: Headers) -> None:
    response = expense(headers, account(headers), date=today_india().isoformat())
    assert response.status_code == 201


@pytest.mark.parametrize("value", ["15-01-2026", "2026-02-30", "yesterday", 20260115])
def test_malformed_date_is_rejected(headers: Headers, value: Any) -> None:
    response = expense(headers, account(headers), date=value)
    assert response.status_code == 422
    assert ["body", "date"] in locs(response)


def test_long_note_and_category_are_rejected(headers: Headers) -> None:
    id = account(headers)
    assert expense(headers, id, note="x" * 201).status_code == 422
    assert expense(headers, id, category="x" * 41).status_code == 422


def test_a_typed_category_matching_a_known_one_uses_its_spelling(headers: Headers) -> None:
    id = account(headers)
    assert expense(headers, id, category="  GROCERIES ").json()["category"] == "Groceries"
    assert expense(headers, id, category="Pet Food").json()["category"] == "Pet Food"
    assert expense(headers, id, category="pet food").json()["category"] == "Pet Food"


# Archived accounts


def test_new_transaction_on_an_archived_account_is_rejected(headers: Headers) -> None:
    id = account(headers)
    client.post(f"/api/accounts/{id}/archive", headers=headers)

    response = expense(headers, id)

    assert response.status_code == 422
    assert locs(response) == [["body", "account_id"]]


def test_transfer_to_an_archived_account_is_rejected(headers: Headers) -> None:
    source = account(headers)
    target = account(headers)
    client.post(f"/api/accounts/{target}/archive", headers=headers)

    response = transfer(headers, source, target)

    assert response.status_code == 422
    assert locs(response) == [["body", "to_account_id"]]


def test_transaction_on_an_archived_account_is_kept_but_locked(headers: Headers) -> None:
    id = account(headers)
    tx = expense(headers, id).json()["id"]
    client.post(f"/api/accounts/{id}/archive", headers=headers)

    listed = client.get(URL, headers=headers).json()["transactions"]
    edit = client.patch(f"{URL}/{tx}", json={"note": "x"}, headers=headers)
    delete = client.delete(f"{URL}/{tx}", headers=headers)

    assert [t["editable"] for t in listed] == [False]
    assert edit.status_code == 409
    assert delete.status_code == 409


# Reading


def test_list_is_newest_first_with_ties_by_most_recently_added(headers: Headers) -> None:
    id = account(headers)
    first = expense(headers, id, date="2026-01-10").json()["id"]
    second = expense(headers, id, date="2026-01-20").json()["id"]
    third = expense(headers, id, date="2026-01-10").json()["id"]

    listed = client.get(URL, headers=headers).json()["transactions"]

    assert [t["id"] for t in listed] == [second, third, first]


def test_filter_by_account_includes_both_sides_of_a_transfer(headers: Headers) -> None:
    a = account(headers)
    b = account(headers)
    c = account(headers)
    moved = transfer(headers, a, b).json()["id"]
    expense(headers, c)

    for side in (a, b):
        listed = client.get(URL, params={"account_id": side}, headers=headers).json()
        assert [t["id"] for t in listed["transactions"]] == [moved]


def test_filter_by_type(headers: Headers) -> None:
    id = account(headers)
    expense(headers, id)
    earned = income(headers, id).json()["id"]

    listed = client.get(URL, params={"type": "income"}, headers=headers).json()

    assert [t["id"] for t in listed["transactions"]] == [earned]


def test_filter_by_month_includes_its_first_and_last_day(headers: Headers) -> None:
    id = account(headers)
    expense(headers, id, date="2025-12-31")
    first = expense(headers, id, date="2026-01-01").json()["id"]
    last = expense(headers, id, date="2026-01-31").json()["id"]
    expense(headers, id, date="2026-02-01")

    listed = client.get(URL, params={"month": "2026-01"}, headers=headers).json()

    assert [t["id"] for t in listed["transactions"]] == [last, first]


@pytest.mark.parametrize("month", ["2026-13", "2026", "jan"])
def test_bad_month_is_rejected(headers: Headers, month: str) -> None:
    assert client.get(URL, params={"month": month}, headers=headers).status_code == 422


def test_totals_count_income_and_expense_but_not_transfers(headers: Headers) -> None:
    a = account(headers)
    b = account(headers)
    expense(headers, a, "100.10")
    expense(headers, a, "100.20")
    income(headers, a, "50.05")
    transfer(headers, a, b, "10.00")

    body = client.get(URL, headers=headers).json()

    assert body["total_expense"] == "200.30"
    assert body["total_income"] == "50.05"


def test_pagination_with_totals_over_every_match(headers: Headers) -> None:
    id = account(headers)
    ids = [expense(headers, id, "1.00").json()["id"] for _ in range(3)]

    page1 = client.get(URL, params={"limit": 2}, headers=headers).json()
    page2 = client.get(URL, params={"limit": 2, "offset": 2}, headers=headers).json()

    assert [t["id"] for t in page1["transactions"]] == [ids[2], ids[1]]
    assert page1["has_more"] is True
    assert [t["id"] for t in page2["transactions"]] == [ids[0]]
    assert page2["has_more"] is False
    assert page1["total_expense"] == "3.00"


def test_get_one(headers: Headers) -> None:
    id = expense(headers, account(headers)).json()["id"]
    response = client.get(f"{URL}/{id}", headers=headers)
    assert response.status_code == 200
    assert response.json()["id"] == id


def test_categories_are_the_defaults_plus_what_the_user_has_typed(headers: Headers) -> None:
    id = account(headers)
    expense(headers, id, category="Pet Food")
    income(headers, id, category="Side Gig")

    body = client.get(f"{URL}/categories", headers=headers).json()

    assert "Groceries" in body["expense"]
    assert "Pet Food" in body["expense"]
    assert "Salary" in body["income"]
    assert "Side Gig" in body["income"]
    assert "Side Gig" not in body["expense"]


# Changing


def test_editing_moves_the_money_between_accounts(headers: Headers) -> None:
    a = account(headers, "bank", "1000.00")
    b = account(headers, "bank", "1000.00")
    id = expense(headers, a, "100.00").json()["id"]

    response = client.patch(
        f"{URL}/{id}", json={"account_id": b, "amount": "60.00"}, headers=headers
    )

    assert response.status_code == 200
    assert balance_of(headers, a) == "1000.00"
    assert balance_of(headers, b) == "940.00"


def test_editing_cannot_change_the_type(headers: Headers) -> None:
    id = expense(headers, account(headers)).json()["id"]
    response = client.patch(f"{URL}/{id}", json={"type": "income"}, headers=headers)
    assert response.status_code == 422


def test_editing_can_clear_the_note(headers: Headers) -> None:
    id = expense(headers, account(headers), note="hello").json()["id"]
    response = client.patch(f"{URL}/{id}", json={"note": None}, headers=headers)
    assert response.json()["note"] is None


def test_editing_cannot_clear_a_required_field(headers: Headers) -> None:
    id = expense(headers, account(headers)).json()["id"]
    response = client.patch(f"{URL}/{id}", json={"category": None}, headers=headers)
    assert response.status_code == 422
    assert locs(response) == [["body", "category"]]


def test_deleting_puts_the_money_back(headers: Headers) -> None:
    bank = account(headers, "bank", "1000.00")
    id = expense(headers, bank, "100.00").json()["id"]

    response = client.delete(f"{URL}/{id}", headers=headers)

    assert response.status_code == 200
    assert balance_of(headers, bank) == "1000.00"
    assert client.get(f"{URL}/{id}", headers=headers).status_code == 404


# Access


def test_requests_without_a_session_return_401(headers: Headers) -> None:
    assert client.get(URL).status_code == 401
    assert client.get(f"{URL}/categories").status_code == 401
    assert client.post(URL, json={}).status_code == 401
    assert client.get(f"{URL}/1").status_code == 401
    assert client.patch(f"{URL}/1", json={}).status_code == 401
    assert client.delete(f"{URL}/1").status_code == 401


def test_another_users_transaction_behaves_as_if_missing(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers
) -> None:
    id = expense(headers, account(headers)).json()["id"]
    other = auth(db_session, monkeypatch, "other@example.com")

    assert client.get(URL, headers=other).json()["transactions"] == []
    assert client.get(f"{URL}/{id}", headers=other).status_code == 404
    assert client.patch(f"{URL}/{id}", json={"note": "x"}, headers=other).status_code == 404
    assert client.delete(f"{URL}/{id}", headers=other).status_code == 404


def test_another_users_account_cannot_be_used(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers
) -> None:
    theirs = account(headers, "bank", "1000.00")
    other = auth(db_session, monkeypatch, "other@example.com")
    mine = account(other)

    assert locs(expense(other, theirs)) == [["body", "account_id"]]
    assert locs(transfer(other, mine, theirs)) == [["body", "to_account_id"]]
    assert balance_of(headers, theirs) == "1000.00"


def test_another_users_categories_stay_private(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, headers: Headers
) -> None:
    expense(headers, account(headers), category="Secret Hobby")
    other = auth(db_session, monkeypatch, "other@example.com")

    assert "Secret Hobby" not in client.get(f"{URL}/categories", headers=other).json()["expense"]


@pytest.mark.parametrize("id", [0, -1, 2147483648])
def test_out_of_range_ids_return_404(headers: Headers, id: int) -> None:
    assert client.get(f"{URL}/{id}", headers=headers).status_code == 404
    assert client.delete(f"{URL}/{id}", headers=headers).status_code == 404


def test_out_of_range_account_id_is_a_field_error(headers: Headers) -> None:
    response = expense(headers, 2147483648)
    assert response.status_code == 422
    assert locs(response) == [["body", "account_id"]]


# Spending by category


def breakdown(headers: Headers, **params: Any) -> list[dict[str, str]]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200
    return response.json()["expense_by_category"]


def spend(category: str, amount: str) -> dict[str, str]:
    return {"category": category, "amount": amount}


def test_breakdown_groups_and_sorts(headers: Headers) -> None:
    a = account(headers)
    expense(headers, a, "100.00", category="Groceries")
    expense(headers, a, "50.00", category="Transport")
    expense(headers, a, "75.50", category="Groceries")
    expense(headers, a, "50.00", category="Bills")

    assert breakdown(headers) == [
        spend("Groceries", "175.50"),
        spend("Bills", "50.00"),
        spend("Transport", "50.00"),
    ]


def test_breakdown_names_uncategorised(headers: Headers, db_session: Session) -> None:
    a = account(headers)
    expense(headers, a, "100.00", category="Groceries")
    expense(headers, a, "20.00", category="Other")
    id = expense(headers, a, "30.00").json()["id"]
    tx = db_session.get(Transaction, id)
    assert tx is not None
    tx.category = None
    db_session.commit()

    assert breakdown(headers) == [
        spend("Groceries", "100.00"),
        spend("Uncategorised", "30.00"),
        spend("Other", "20.00"),
    ]


# Transactions recorded from SMS


def sms_expense(db: Session, headers: Headers, account_id: int, category: str | None) -> int:
    id = expense(headers, account_id, "40.00").json()["id"]
    tx = db.get(Transaction, id)
    assert tx is not None
    tx.category = category
    tx.source = "sms"
    db.commit()
    return id


def test_manual_create_still_needs_category(headers: Headers) -> None:
    response = post(headers, type="expense", account_id=account(headers), amount="10.00")
    assert response.status_code == 422
    assert locs(response) == [["body", "category"]]
    created = expense(headers, account(headers)).json()
    assert created["from_sms"] is False


def test_editing_note_of_uncategorised_sms_transaction_is_allowed(
    headers: Headers, db_session: Session
) -> None:
    id = sms_expense(db_session, headers, account(headers), None)
    response = client.patch(f"{URL}/{id}", json={"note": "Chai"}, headers=headers)
    assert response.status_code == 200, response.json()
    assert (response.json()["note"], response.json()["category"]) == ("Chai", None)
    assert response.json()["from_sms"] is True

    response = client.patch(f"{URL}/{id}", json={"category": "Food and dining"}, headers=headers)
    assert response.json()["category"] == "Food and dining"
    # Once categorised it can't go back to none.
    response = client.patch(f"{URL}/{id}", json={"category": None}, headers=headers)
    assert response.status_code == 422


def test_uncategorised_manual_transaction_still_needs_category_on_edit(
    headers: Headers, db_session: Session
) -> None:
    id = expense(headers, account(headers)).json()["id"]
    tx = db_session.get(Transaction, id)
    assert tx is not None
    tx.category = None
    db_session.commit()
    response = client.patch(f"{URL}/{id}", json={"note": "Chai"}, headers=headers)
    assert response.status_code == 422


def test_breakdown_emi_interest_only(headers: Headers) -> None:
    pay = bank(headers, balance="50000.00")
    loan_id = loan(
        headers, balance="21632.00", pay_from_id=pay, emi_amount="10000.00", emis_left=3
    )["id"]
    assert emi(headers, pay, loan_id, "10000.00", "1200.00").status_code == 201

    assert breakdown(headers) == [spend("EMI interest", "1200.00")]


def test_breakdown_top_four_plus_other(headers: Headers) -> None:
    a = account(headers, balance="100000.00")
    for category, amount in [
        ("Groceries", "600.00"),
        ("Bills", "500.00"),
        ("Transport", "400.00"),
        ("Dining", "300.00"),
        ("Fun", "200.00"),
        ("Gifts", "100.00"),
    ]:
        expense(headers, a, amount, category=category)

    assert breakdown(headers) == [
        spend("Groceries", "600.00"),
        spend("Bills", "500.00"),
        spend("Transport", "400.00"),
        spend("Dining", "300.00"),
        spend("Other", "300.00"),
    ]


def test_breakdown_merges_into_existing_other(headers: Headers) -> None:
    a = account(headers, balance="100000.00")
    for category, amount in [
        ("Groceries", "600.00"),
        ("Bills", "500.00"),
        ("Transport", "400.00"),
        ("Dining", "300.00"),
        ("Fun", "200.00"),
        ("Other", "250.00"),
    ]:
        expense(headers, a, amount, category=category)

    assert breakdown(headers)[-1] == spend("Other", "450.00")
    assert len(breakdown(headers)) == 5


def test_breakdown_large_other_still_shows_four_named(headers: Headers) -> None:
    a = account(headers, balance="100000.00")
    for category, amount in [
        ("Other", "900.00"),
        ("Groceries", "600.00"),
        ("Bills", "500.00"),
        ("Transport", "400.00"),
        ("Dining", "300.00"),
        ("Fun", "200.00"),
        ("Gifts", "100.00"),
    ]:
        expense(headers, a, amount, category=category)
    body = client.get(URL, headers=headers).json()

    assert body["expense_by_category"] == [
        spend("Groceries", "600.00"),
        spend("Bills", "500.00"),
        spend("Transport", "400.00"),
        spend("Dining", "300.00"),
        spend("Other", "1200.00"),
    ]
    total = sum((Decimal(s["amount"]) for s in body["expense_by_category"]), Decimal(0))
    assert fmt(total) == body["total_expense"]


def test_breakdown_sums_to_total_expense(headers: Headers) -> None:
    a = account(headers, balance="100000.00")
    for i, category in enumerate(["A", "B", "C", "D", "E", "F", "G"]):
        expense(headers, a, f"{10 + i}.33", category=category)
    body = client.get(URL, headers=headers).json()

    total = sum((Decimal(s["amount"]) for s in body["expense_by_category"]), Decimal(0))
    assert fmt(total) == body["total_expense"]
    assert len(body["expense_by_category"]) == 5


def test_breakdown_empty_month(headers: Headers) -> None:
    expense(headers, account(headers))
    assert breakdown(headers, month="2025-03") == []


def test_breakdown_ignores_transfers_and_income(headers: Headers) -> None:
    a, b = account(headers), account(headers)
    income(headers, a, "500.00")
    transfer(headers, a, b, "100.00")
    expense(headers, a, "20.00", category="Groceries")

    assert breakdown(headers) == [spend("Groceries", "20.00")]
