from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.deposits import add_months
from app.main import app
from tests.test_accounts import Headers, auth, locs, make
from tests.test_transactions import income, post, transfer

client = TestClient(app)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def bank(headers: Headers, name: str = "SBI", balance: str = "100000.00") -> int:
    response = make(headers, type="bank", bank_kind="savings", name=name, balance=balance)
    return response.json()["id"]


def ppf(headers: Headers, **fields: Any) -> Response:
    body = {
        "type": "ppf",
        "name": "PPF",
        "balance": "250000.00",
        "interest_rate": "7.10",
        "opened_on": "2020-06-10",
        **fields,
    }
    return client.post("/api/accounts", json=body, headers=headers)


def first_of_month(back: int) -> date:
    today = today_india()
    return add_months(date(today.year, today.month, 1), -back)


def rd(headers: Headers, pay_from: int, **fields: Any) -> Response:
    body = {
        "type": "rd",
        "name": "SBI RD",
        "balance": "5000.00",
        "interest_rate": "7.00",
        "opened_on": first_of_month(2).isoformat(),
        "deposit_amount": "5000.00",
        "due_day": 1,
        "tenure_months": 24,
        "deposits_paid": 1,
        "pay_from_id": pay_from,
        **fields,
    }
    return client.post("/api/accounts", json=body, headers=headers)


def listing(headers: Headers) -> dict:
    return client.get("/api/accounts", headers=headers).json()


def one(headers: Headers, id: int) -> dict:
    return next(a for a in listing(headers)["accounts"] if a["id"] == id)


def messages(response: Response) -> dict[str, str]:
    return {e["loc"][-1]: e["msg"] for e in response.json()["detail"]}


def test_create_a_ppf(headers: Headers) -> None:
    response = ppf(headers)

    assert response.status_code == 201
    body = response.json()
    assert body["opened_on"] == "2020-06-10"
    assert body["interest_rate"] == "7.10"
    deposit = body["deposit"]
    assert deposit["kind"] == "ppf"
    assert deposit["maturity_date"] == "2036-04-01"
    assert deposit["year_limit"] == "150000.00"
    assert listing(headers)["total_have"] == "250000.00"


def test_create_an_rd(headers: Headers) -> None:
    response = rd(headers, bank(headers))

    assert response.status_code == 201
    body = response.json()
    assert body["deposit_amount"] == "5000.00"
    assert body["tenure_months"] == 24
    deposit = body["deposit"]
    assert deposit["kind"] == "rd"
    assert deposit["deposits_paid"] == 1
    assert deposit["deposits_left"] == 23
    assert deposit["deposited"] == "5000.00"
    assert deposit["maturity_value"] == "129098.90"
    assert deposit["maturity_date"] == add_months(first_of_month(2), 24).isoformat()


def test_other_accounts_have_no_deposit_fields(headers: Headers) -> None:
    body = make(headers).json()

    assert body["deposit"] is None
    assert body["opened_on"] is None
    assert body["deposit_amount"] is None
    assert body["tenure_months"] is None


def test_each_missing_ppf_field_gives_its_message(headers: Headers) -> None:
    body = {"type": "ppf", "name": "PPF", "balance": "0.00"}
    response = client.post("/api/accounts", json=body, headers=headers)

    assert response.status_code == 422
    assert messages(response) == {
        "interest_rate": "Enter the yearly interest rate.",
        "opened_on": "Choose the date it was opened.",
    }


def test_each_missing_rd_field_gives_its_message(headers: Headers) -> None:
    body = {"type": "rd", "name": "RD", "balance": "0.00"}
    response = client.post("/api/accounts", json=body, headers=headers)

    assert messages(response) == {
        "interest_rate": "Enter the yearly interest rate.",
        "opened_on": "Choose the date it was opened.",
        "pay_from_id": "Choose the bank the instalments come from.",
        "deposit_amount": "Enter the monthly instalment.",
        "due_day": "Choose the instalment day.",
        "tenure_months": "Enter the tenure in months, from 1 to 120.",
        "deposits_paid": "Enter the instalments paid so far, from 0 to the tenure.",
    }


def test_loan_only_fields_are_refused_on_a_ppf(headers: Headers) -> None:
    response = ppf(headers, emi_amount="100.00", due_day=5)

    assert response.status_code == 422
    assert messages(response) == {
        "due_day": "Not applicable to this account type.",
        "emi_amount": "Not applicable to this account type.",
    }


def test_deposit_fields_are_refused_on_other_types(headers: Headers) -> None:
    response = make(headers, deposit_amount="10.00", opened_on="2020-01-01")

    assert response.status_code == 422
    assert sorted(locs(response)) == [["body", "deposit_amount"], ["body", "opened_on"]]


def test_opened_on_cannot_be_in_the_future_or_malformed(headers: Headers) -> None:
    future = (today_india() + timedelta(days=1)).isoformat()

    response = ppf(headers, opened_on=future)
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "The date can't be in the future."
    assert ppf(headers, opened_on="10/06/2020").status_code == 422


def test_rd_numbers_are_checked(headers: Headers) -> None:
    pay = bank(headers)

    zero = rd(headers, pay, deposit_amount="0.00")
    assert zero.json()["detail"][0]["msg"] == "Instalment must be greater than 0."
    assert rd(headers, pay, tenure_months=121).status_code == 422
    assert rd(headers, pay, tenure_months=0).status_code == 422
    assert rd(headers, pay, deposits_paid=25).status_code == 422
    assert rd(headers, pay, deposits_paid=-1).status_code == 422


def test_pay_from_must_be_an_active_bank(headers: Headers) -> None:
    card = make(headers, type="credit_card", name="Card", credit_limit="1000.00").json()["id"]
    old = bank(headers, "Old")
    client.post(f"/api/accounts/{old}/archive", headers=headers)

    on_card = rd(headers, card)
    assert on_card.status_code == 422
    assert on_card.json()["detail"][0]["msg"] == "Choose a bank account."
    archived = rd(headers, old)
    assert archived.json()["detail"][0]["msg"] == "Old is archived. Restore it to use it."
    assert ppf(headers, pay_from_id=card).status_code == 422
    assert ppf(headers, pay_from_id=bank(headers, "Ok")).status_code == 201


def test_a_transfer_in_counts_as_an_instalment_and_removes_its_month(headers: Headers) -> None:
    pay = bank(headers)
    created = rd(headers, pay).json()
    earlier = add_months(first_of_month(2), 1).isoformat()
    before = created["deposit"]
    assert before["due"] == [earlier, first_of_month(0).isoformat()]

    sent = post(
        headers,
        type="transfer",
        account_id=pay,
        to_account_id=created["id"],
        amount="5000.00",
        date=today_india().isoformat(),
    )
    assert sent.status_code == 201
    after = one(headers, created["id"])["deposit"]
    assert after["deposits_paid"] == 2
    assert after["deposits_left"] == 22
    assert after["deposited"] == "10000.00"
    assert after["due"] == [earlier]

    client.delete(f"/api/transactions/{sent.json()['id']}", headers=headers)
    again = one(headers, created["id"])["deposit"]
    assert again["deposits_paid"] == 1
    assert again["due"] == before["due"]


def test_deposits_paid_cannot_go_below_the_months_recorded(headers: Headers) -> None:
    pay = bank(headers)
    created = rd(headers, pay, opened_on="2025-12-01").json()
    transfer(headers, pay, created["id"], "5000.00")  # the helper dates it 2026-01-15
    path = f"/api/accounts/{created['id']}"

    ok = client.patch(path, json={"deposits_paid": 1}, headers=headers)
    assert ok.status_code == 200
    assert ok.json()["deposit"]["deposits_paid"] == 1

    low = client.patch(path, json={"deposits_paid": 0}, headers=headers)
    assert low.status_code == 422
    assert low.json()["detail"][0]["loc"] == ["body", "deposits_paid"]
    assert low.json()["detail"][0]["msg"] == "More instalments are already recorded than that."


def test_editing_an_rd_keeps_its_figures(headers: Headers) -> None:
    created = rd(headers, bank(headers)).json()

    response = client.patch(
        f"/api/accounts/{created['id']}", json={"name": "Renamed"}, headers=headers
    )

    assert response.status_code == 200
    assert response.json()["deposit"] == created["deposit"]


def test_a_ppf_added_today_asks_for_no_back_interest(headers: Headers) -> None:
    created = ppf(headers).json()

    # created_at is today, so no financial year that ended earlier is asked for.
    assert created["deposit"]["interest_due"] is None
    income(headers, created["id"], "10.00", category="Interest", date=today_india().isoformat())
    assert one(headers, created["id"])["deposit"]["interest_due"] is None


def test_archiving_a_bank_paying_an_active_rd_is_refused(headers: Headers) -> None:
    pay = bank(headers, "HDFC")
    rd(headers, pay, name="SBI RD")

    response = client.post(f"/api/accounts/{pay}/archive", headers=headers)

    assert response.status_code == 409
    assert response.json()["detail"] == "Close or move the RD SBI RD before archiving HDFC."


def test_archiving_a_bank_clears_pay_from_on_a_ppf(headers: Headers) -> None:
    pay = bank(headers)
    created = ppf(headers, pay_from_id=pay).json()

    assert client.post(f"/api/accounts/{pay}/archive", headers=headers).status_code == 200
    assert one(headers, created["id"])["pay_from_id"] is None


def test_archiving_a_deposit_with_a_balance_is_refused(headers: Headers) -> None:
    created = ppf(headers, name="My PPF").json()

    response = client.post(f"/api/accounts/{created['id']}/archive", headers=headers)

    assert response.status_code == 409
    assert response.json()["detail"] == "Withdraw the balance from My PPF before archiving it."
    empty = ppf(headers, name="Empty", balance="0.00").json()
    assert client.post(f"/api/accounts/{empty['id']}/archive", headers=headers).status_code == 200


def test_listing_uses_a_bounded_number_of_queries(db_session: Session, headers: Headers) -> None:
    bind = db_session.get_bind()
    pay = bank(headers)
    counts = []
    for target in (1, 5):
        for n in range(len([a for a in listing(headers)["accounts"] if a["type"] == "rd"]), target):
            assert rd(headers, pay, name=f"RD{n}").status_code == 201
            assert ppf(headers, name=f"PPF{n}").status_code == 201
        seen: list[str] = []

        def record(
            conn: Any, cursor: Any, statement: str, *args: Any, log: list[str] = seen
        ) -> None:
            log.append(statement)

        event.listen(bind, "before_cursor_execute", record)
        try:
            assert client.get("/api/accounts", headers=headers).status_code == 200
        finally:
            event.remove(bind, "before_cursor_execute", record)
        counts.append(len(seen))

    assert counts[0] == counts[1]
