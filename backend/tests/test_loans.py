from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.api.routes.dashboard import today_india
from app.main import app
from tests.test_accounts import Headers, auth, locs, make

client = TestClient(app)

DAY = "2026-01-15"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def card(headers: Headers, balance: str = "21632.00", limit: str | None = "72000.00") -> int:
    response = make(
        headers, type="credit_card", name="HDFC Moneyback+", balance=balance, credit_limit=limit
    )
    assert response.status_code == 201
    return response.json()["id"]


def bank(headers: Headers, balance: str = "50000.00") -> int:
    response = make(headers, type="bank", name="SBI", bank_kind="savings", balance=balance)
    assert response.status_code == 201
    return response.json()["id"]


def make_loan(headers: Headers, **fields: Any) -> Response:
    body = {"type": "loan", "name": "Card loan", "balance": "21632.00", **fields}
    return make(headers, **body)


def loan(headers: Headers, **fields: Any) -> dict[str, Any]:
    response = make_loan(headers, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def accounts(headers: Headers) -> dict[str, Any]:
    return client.get("/api/accounts", headers=headers).json()


def get(headers: Headers, id: int) -> dict[str, Any]:
    return next(a for a in accounts(headers)["accounts"] if a["id"] == id)


def emi(headers: Headers, from_id: int, loan_id: int, amount: str, interest: str) -> Response:
    return client.post(
        "/api/transactions",
        json={
            "type": "emi",
            "date": DAY,
            "account_id": from_id,
            "to_account_id": loan_id,
            "amount": amount,
            "interest": interest,
        },
        headers=headers,
    )


# Loan accounts


def test_loan_response_carries_its_details(headers: Headers) -> None:
    pay = bank(headers)
    body = loan(
        headers,
        institution="HDFC",
        due_day=5,
        interest_rate="14.50",
        emi_amount="7500.00",
        emis_left=3,
        pay_from_id=pay,
    )
    assert body["type"] == "loan"
    assert body["balance"] == "21632.00"
    assert body["institution"] == "HDFC"
    assert body["due_day"] == 5
    assert body["interest_rate"] == "14.50"
    assert body["emi_amount"] == "7500.00"
    assert body["emis_left"] == 3
    assert body["pay_from_id"] == pay
    assert body["available_credit"] is None


def test_other_accounts_have_null_loan_fields(headers: Headers) -> None:
    body = make(headers).json()
    for field in ("interest_rate", "emi_amount", "emis_left", "pay_from_id", "next_emi"):
        assert body[field] is None


def test_loan_counts_as_owed_and_lowers_net_worth(headers: Headers) -> None:
    bank(headers, "50000.00")
    loan(headers, balance="20000.00")
    assert accounts(headers)["total_owe"] == "20000.00"
    dashboard = client.get("/api/dashboard", headers=headers).json()
    assert dashboard["net_worth"] == "30000.00"


def test_loan_balance_cannot_be_negative(headers: Headers) -> None:
    response = make_loan(headers, balance="-1.00")
    assert response.status_code == 422
    assert locs(response) == [["body", "balance"]]


@pytest.mark.parametrize(
    "field,value",
    [("interest_rate", "10.00"), ("emi_amount", "100.00"), ("emis_left", 3)],
)
def test_loan_fields_are_rejected_on_other_types(headers: Headers, field: str, value: Any) -> None:
    response = make(headers, **{field: value})
    assert response.status_code == 422
    assert locs(response) == [["body", field]]


@pytest.mark.parametrize("value", ["-1", "100.01", "10.123", "abc"])
def test_bad_interest_rate(headers: Headers, value: str) -> None:
    response = make_loan(headers, interest_rate=value)
    assert response.status_code == 422
    assert locs(response) == [["body", "interest_rate"]]


@pytest.mark.parametrize("value", [0, 601, "3", True, 1.5])
def test_bad_emis_left(headers: Headers, value: Any) -> None:
    response = make_loan(headers, emis_left=value)
    assert response.status_code == 422
    assert locs(response) == [["body", "emis_left"]]


def test_emi_amount_must_be_positive(headers: Headers) -> None:
    response = make_loan(headers, emi_amount="0")
    assert response.status_code == 422
    assert locs(response) == [["body", "emi_amount"]]


def test_pay_from_must_be_an_own_active_non_loan_account(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = loan(headers)["id"]
    assert locs(make_loan(headers, pay_from_id=other)) == [["body", "pay_from_id"]]
    assert locs(make_loan(headers, pay_from_id=999999)) == [["body", "pay_from_id"]]

    archived = bank(headers)
    client.post(f"/api/accounts/{archived}/archive", headers=headers)
    assert locs(make_loan(headers, pay_from_id=archived)) == [["body", "pay_from_id"]]

    stranger = auth(db_session, monkeypatch, "them@example.com")
    theirs = bank(stranger)
    assert locs(make_loan(headers, pay_from_id=theirs)) == [["body", "pay_from_id"]]


def test_loans_sort_after_other_types(headers: Headers) -> None:
    loan(headers, name="A loan")
    make(headers, type="wallet", name="Z wallet")
    names = [a["name"] for a in accounts(headers)["accounts"]]
    assert names == ["Z wallet", "A loan"]


def test_patch_updates_loan_details(headers: Headers) -> None:
    id = loan(headers, emi_amount="7500.00", emis_left=3)["id"]
    response = client.patch(
        f"/api/accounts/{id}",
        json={"emis_left": 5, "interest_rate": "12.00", "balance": "20000.00"},
        headers=headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["emis_left"] == 5
    assert body["interest_rate"] == "12.00"
    assert body["balance"] == "20000.00"


# Moving a loan off a card


def test_moved_from_card_keeps_total_owed(headers: Headers) -> None:
    hdfc = card(headers)
    body = loan(headers, pay_from_id=hdfc, moved_from_card=True)

    assert body["balance"] == "21632.00"
    assert get(headers, hdfc)["balance"] == "0.00"
    assert accounts(headers)["total_owe"] == "21632.00"

    moves = client.get("/api/transactions", headers=headers).json()["transactions"]
    assert len(moves) == 1
    assert moves[0]["type"] == "transfer"
    assert moves[0]["account_id"] == body["id"]
    assert moves[0]["to_account_id"] == hdfc
    assert moves[0]["amount"] == "21632.00"
    assert moves[0]["date"] == today_india().isoformat()


def test_moved_from_card_needs_a_card(headers: Headers) -> None:
    response = make_loan(headers, pay_from_id=bank(headers), moved_from_card=True)
    assert response.status_code == 422
    assert locs(response) == [["body", "moved_from_card"]]
    assert locs(make_loan(headers, moved_from_card=True)) == [["body", "moved_from_card"]]


def test_moved_from_card_is_create_only(headers: Headers) -> None:
    id = loan(headers)["id"]
    response = client.patch(f"/api/accounts/{id}", json={"moved_from_card": True}, headers=headers)
    assert response.status_code == 422


def test_card_available_credit_excludes_linked_loans(headers: Headers) -> None:
    hdfc = card(headers)
    loan(headers, pay_from_id=hdfc, moved_from_card=True)
    assert get(headers, hdfc)["available_credit"] == "50368.00"
    dashboard = client.get("/api/dashboard", headers=headers).json()
    assert dashboard["credit_used"] == {"percent": 30}


def test_archived_loans_do_not_block_credit(headers: Headers) -> None:
    hdfc = card(headers, balance="0.00")
    id = loan(headers, balance="1000.00", pay_from_id=hdfc)["id"]
    client.post(f"/api/accounts/{id}/archive", headers=headers)
    assert get(headers, hdfc)["available_credit"] == "72000.00"


# EMIs


def test_emi_moves_card_loan_and_spending(headers: Headers) -> None:
    hdfc = card(headers)
    id = loan(headers, pay_from_id=hdfc, moved_from_card=True, emi_amount="7500.00", emis_left=3)[
        "id"
    ]

    response = emi(headers, hdfc, id, "7500.00", "289.33")
    assert response.status_code == 201
    body = response.json()
    assert body["type"] == "emi"
    assert body["interest"] == "289.33"
    assert body["category"] == "Loan interest"

    assert get(headers, hdfc)["balance"] == "7500.00"
    assert get(headers, id)["balance"] == "14421.33"
    assert get(headers, id)["emis_left"] == 2
    assert get(headers, hdfc)["available_credit"] == "50078.67"

    listed = client.get("/api/transactions", headers=headers).json()
    assert listed["total_expense"] == "289.33"
    assert listed["total_income"] == "0.00"
    only = client.get("/api/transactions?type=emi", headers=headers).json()["transactions"]
    assert [t["id"] for t in only] == [body["id"]]


def test_emi_from_a_bank(headers: Headers) -> None:
    sbi = bank(headers, "10000.00")
    id = loan(headers, balance="5000.00")["id"]
    assert emi(headers, sbi, id, "1000.00", "100.00").status_code == 201
    assert get(headers, sbi)["balance"] == "9000.00"
    assert get(headers, id)["balance"] == "4100.00"


def test_emi_requires_interest(headers: Headers) -> None:
    sbi = bank(headers)
    id = loan(headers)["id"]
    response = client.post(
        "/api/transactions",
        json={"type": "emi", "date": DAY, "account_id": sbi, "to_account_id": id, "amount": "1"},
        headers=headers,
    )
    assert response.status_code == 422
    assert locs(response) == [["body", "interest"]]


def test_emi_interest_cannot_exceed_amount(headers: Headers) -> None:
    response = emi(headers, bank(headers), loan(headers)["id"], "100.00", "100.01")
    assert response.status_code == 422
    assert locs(response) == [["body", "interest"]]


def test_emi_interest_cannot_be_negative(headers: Headers) -> None:
    response = emi(headers, bank(headers), loan(headers)["id"], "100.00", "-1.00")
    assert response.status_code == 422
    assert locs(response) == [["body", "interest"]]


def test_emi_must_go_to_a_loan(headers: Headers) -> None:
    response = emi(headers, bank(headers), card(headers), "100.00", "0")
    assert response.status_code == 422
    assert locs(response) == [["body", "to_account_id"]]


def test_emi_cannot_be_paid_from_a_loan(headers: Headers) -> None:
    first = loan(headers)["id"]
    second = loan(headers, name="Other")["id"]
    response = emi(headers, first, second, "100.00", "0")
    assert response.status_code == 422
    assert locs(response) == [["body", "account_id"]]


def test_emi_principal_cannot_exceed_outstanding(headers: Headers) -> None:
    id = loan(headers, balance="1000.00")["id"]
    response = emi(headers, bank(headers), id, "1500.00", "400.00")
    assert response.status_code == 422
    assert locs(response) == [["body", "amount"]]
    assert emi(headers, bank(headers), id, "1500.00", "500.00").status_code == 201
    assert get(headers, id)["balance"] == "0.00"


def test_only_an_emi_has_interest(headers: Headers) -> None:
    response = client.post(
        "/api/transactions",
        json={
            "type": "expense",
            "date": DAY,
            "account_id": bank(headers),
            "amount": "10.00",
            "category": "Groceries",
            "interest": "1.00",
        },
        headers=headers,
    )
    assert response.status_code == 422
    assert locs(response) == [["body", "interest"]]


def test_emi_cannot_take_a_category(headers: Headers) -> None:
    response = client.post(
        "/api/transactions",
        json={
            "type": "emi",
            "date": DAY,
            "account_id": bank(headers),
            "to_account_id": loan(headers)["id"],
            "amount": "10.00",
            "interest": "1.00",
            "category": "Groceries",
        },
        headers=headers,
    )
    assert response.status_code == 422
    assert locs(response) == [["body", "category"]]


def test_editing_and_deleting_an_emi(headers: Headers) -> None:
    sbi = bank(headers, "10000.00")
    id = loan(headers, balance="5000.00", emi_amount="1000.00", emis_left=5)["id"]
    tx = emi(headers, sbi, id, "1000.00", "100.00").json()["id"]

    response = client.patch(f"/api/transactions/{tx}", json={"interest": "200.00"}, headers=headers)
    assert response.status_code == 200
    assert get(headers, id)["balance"] == "4200.00"

    assert client.delete(f"/api/transactions/{tx}", headers=headers).status_code == 200
    assert get(headers, id)["balance"] == "5000.00"
    assert get(headers, id)["emis_left"] == 5
    assert get(headers, sbi)["balance"] == "10000.00"


def test_transfers_take_and_prepay_a_loan(headers: Headers) -> None:
    sbi = bank(headers, "0.00")
    id = loan(headers, balance="0.00")["id"]

    def transfer(from_id: int, to_id: int, amount: str) -> Response:
        return client.post(
            "/api/transactions",
            json={
                "type": "transfer",
                "date": DAY,
                "account_id": from_id,
                "to_account_id": to_id,
                "amount": amount,
            },
            headers=headers,
        )

    assert transfer(id, sbi, "100000.00").status_code == 201  # the loan is paid into the bank
    assert get(headers, id)["balance"] == "100000.00"
    assert get(headers, sbi)["balance"] == "100000.00"
    assert transfer(sbi, id, "30000.00").status_code == 201  # a prepayment
    assert get(headers, id)["balance"] == "70000.00"
    overpay = transfer(sbi, id, "70000.01")
    assert overpay.status_code == 422
    assert locs(overpay) == [["body", "amount"]]


# The suggested next EMI


def test_next_emi_spreads_the_remaining_cost_without_a_rate(headers: Headers) -> None:
    hdfc = card(headers)
    id = loan(headers, pay_from_id=hdfc, moved_from_card=True, emi_amount="7500.00", emis_left=3)[
        "id"
    ]

    for expected in ("289.33", "289.34", "289.33"):
        suggestion = get(headers, id)["next_emi"]
        assert suggestion["interest"] == expected
        assert suggestion["amount"] == "7500.00"
        assert (
            emi(headers, hdfc, id, suggestion["amount"], suggestion["interest"]).status_code == 201
        )

    after = get(headers, id)
    assert after["balance"] == "0.00"
    assert after["emis_left"] == 0
    assert after["next_emi"] is None
    assert get(headers, hdfc)["balance"] == "22500.00"


def test_next_emi_uses_the_rate(headers: Headers) -> None:
    body = loan(headers, balance="100000.00", interest_rate="12.00", emi_amount="8885.00")
    assert body["next_emi"] == {"amount": "8885.00", "interest": "1000.00", "principal": "7885.00"}


def test_final_emi_is_the_outstanding_plus_interest(headers: Headers) -> None:
    body = loan(headers, balance="1000.00", interest_rate="12.00", emi_amount="8885.00")
    assert body["next_emi"] == {"amount": "1010.00", "interest": "10.00", "principal": "1000.00"}


def test_next_emi_interest_is_null_without_rate_or_count(headers: Headers) -> None:
    body = loan(headers, balance="1000.00", emi_amount="300.00")
    assert body["next_emi"] == {"amount": "300.00", "interest": None, "principal": None}


def test_no_next_emi_without_an_emi_amount(headers: Headers) -> None:
    assert loan(headers)["next_emi"] is None
