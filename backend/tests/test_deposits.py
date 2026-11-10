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
from tests.test_transactions import income, post

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
    for bad in ("10/06/2020", "2020-13-45", 20200610):
        response = ppf(headers, opened_on=bad)
        assert response.status_code == 422
        assert response.json()["detail"][0]["msg"] == "Enter a date, like 2026-01-15."


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


def test_an_rds_pay_from_can_only_be_changed_to_an_active_bank(headers: Headers) -> None:
    pay = bank(headers)
    card = make(headers, type="credit_card", name="Card", credit_limit="1000.00").json()["id"]
    old = bank(headers, "Old")
    client.post(f"/api/accounts/{old}/archive", headers=headers)
    created = rd(headers, pay).json()
    path = f"/api/accounts/{created['id']}"

    on_card = client.patch(path, json={"pay_from_id": card}, headers=headers)
    assert on_card.status_code == 422
    assert on_card.json()["detail"][0]["msg"] == "Choose a bank account."
    archived = client.patch(path, json={"pay_from_id": old}, headers=headers)
    assert archived.status_code == 422
    assert archived.json()["detail"][0]["msg"] == "Old is archived. Restore it to use it."
    assert one(headers, created["id"])["pay_from_id"] == pay
    other = bank(headers, "Other")
    assert client.patch(path, json={"pay_from_id": other}, headers=headers).status_code == 200


def test_an_unchanged_pay_from_is_neither_checked_nor_locked(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import accounts as routes

    pay = bank(headers)
    other = bank(headers, "Other")
    created = ppf(headers, pay_from_id=pay).json()

    def refuse(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("the unchanged bank must not be locked or checked")

    monkeypatch.setattr(routes, "_check_links", refuse)
    path = f"/api/accounts/{created['id']}"
    response = client.patch(path, json={"pay_from_id": pay, "name": "My PPF"}, headers=headers)
    assert response.status_code == 200
    assert one(headers, created["id"])["pay_from_id"] == pay
    # A different bank still goes through the check.
    with pytest.raises(AssertionError):
        client.patch(path, json={"pay_from_id": other}, headers=headers)


def test_a_changed_pay_from_is_locked_together_with_its_account(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.routes import transactions as routes

    pay = bank(headers)
    other = bank(headers, "Other")
    created = ppf(headers, pay_from_id=pay).json()
    calls: list[list[int | None]] = []
    real = routes.lock_accounts

    def spy(db: Session, user_id: int, ids: Any) -> Any:
        calls.append(sorted(ids))
        return real(db, user_id, ids)

    monkeypatch.setattr(routes, "lock_accounts", spy)
    path = f"/api/accounts/{created['id']}"

    assert client.patch(path, json={"pay_from_id": other}, headers=headers).status_code == 200
    assert calls == [sorted([created["id"], other])]
    assert one(headers, created["id"])["pay_from_id"] == other
    # An unchanged bank takes no extra lock, and a bad one is still refused.
    assert client.patch(path, json={"pay_from_id": other}, headers=headers).status_code == 200
    assert len(calls) == 1
    assert client.patch(path, json={"pay_from_id": 999999}, headers=headers).status_code == 422


def test_restoring_a_ppf_clears_an_archived_pay_from(headers: Headers) -> None:
    pay = bank(headers)
    created = ppf(headers, pay_from_id=pay, balance="0.00").json()
    assert client.post(f"/api/accounts/{created['id']}/archive", headers=headers).status_code == 200
    assert client.post(f"/api/accounts/{pay}/archive", headers=headers).status_code == 200

    restored = client.post(f"/api/accounts/{created['id']}/restore", headers=headers)

    assert restored.status_code == 200
    assert restored.json()["pay_from_id"] is None


def test_restoring_an_rd_whose_bank_is_archived_is_refused(headers: Headers) -> None:
    pay = bank(headers, "HDFC")
    created = rd(headers, pay, name="SBI RD", balance="0.00", deposits_paid=0).json()
    assert client.post(f"/api/accounts/{created['id']}/archive", headers=headers).status_code == 200
    assert client.post(f"/api/accounts/{pay}/archive", headers=headers).status_code == 200

    refused = client.post(f"/api/accounts/{created['id']}/restore", headers=headers)

    assert refused.status_code == 409
    assert refused.json()["detail"] == (
        "Restore or choose another bank for SBI RD first: HDFC is archived."
    )
    client.post(f"/api/accounts/{pay}/restore", headers=headers)
    assert client.post(f"/api/accounts/{created['id']}/restore", headers=headers).status_code == 200


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


def deposit_in(headers: Headers, pay: int, into: int, amount: str = "5000.00") -> Response:
    """A transfer from the bank into a deposit, dated today."""
    return post(
        headers,
        type="transfer",
        account_id=pay,
        to_account_id=into,
        amount=amount,
        date=today_india().isoformat(),
    )


def test_deposits_paid_cannot_go_below_the_months_recorded(headers: Headers) -> None:
    pay = bank(headers)
    created = rd(headers, pay).json()
    assert deposit_in(headers, pay, created["id"]).status_code == 201
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


def test_a_ppf_added_today_asks_for_no_back_interest(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A fixed date that is not a 31 March, so the test gives the same answer every day.
    fixed = date(2026, 11, 9)
    monkeypatch.setattr("app.api.routes.accounts.today_india", lambda: fixed)
    created = ppf(headers).json()

    # created_at is today, so no financial year that ended earlier is asked for.
    assert created["deposit"]["interest_due"] is None
    income(headers, created["id"], "10.00", category="Interest", date=fixed.isoformat())
    assert one(headers, created["id"])["deposit"]["interest_due"] is None


def test_a_transfer_into_a_ppf_counts_toward_this_years_deposits(headers: Headers) -> None:
    pay = bank(headers)
    created = ppf(headers).json()
    assert one(headers, created["id"])["deposit"]["deposited_this_year"] == "0.00"

    assert deposit_in(headers, pay, created["id"], "40000.00").status_code == 201
    assert deposit_in(headers, pay, created["id"], "2500.50").status_code == 201

    assert one(headers, created["id"])["deposit"]["deposited_this_year"] == "42500.50"


def test_a_ppf_shows_the_interest_due_for_a_year_that_has_ended(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = ppf(headers, balance="250000.00").json()  # added today
    today = today_india()
    ended = date(today.year if today <= date(today.year, 3, 31) else today.year + 1, 3, 31)
    monkeypatch.setattr("app.api.routes.accounts.today_india", lambda: ended)

    due = one(headers, created["id"])["deposit"]["interest_due"]

    # The whole financial year at 7.10% on 2,50,000 that never moved.
    assert due == {
        "year": f"{ended.year - 1}-{ended.year % 100:02d}",
        "amount": "17750.00",
        "date": ended.isoformat(),
    }


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

    assert counts[0] > 0
    assert counts[0] == counts[1]


# Transaction rules

PPF_ONLY = "A PPF account only takes deposits, interest and withdrawals to a bank."
RD_ONLY = "An RD only takes deposits, interest and withdrawals to a bank."


def tx(headers: Headers, **fields: Any) -> Response:
    return post(headers, date=today_india().isoformat(), **fields)


def test_a_deposit_refuses_expenses_and_emis(headers: Headers) -> None:
    pay = bank(headers)
    p = ppf(headers).json()["id"]
    r = rd(headers, pay).json()["id"]
    loan = make(headers, type="loan", name="Car", balance="50000.00").json()["id"]

    for target, message in ((p, PPF_ONLY), (r, RD_ONLY)):
        spent = tx(headers, type="expense", account_id=target, amount="10.00", category="Fuel")
        assert spent.status_code == 422
        assert messages(spent) == {"account_id": message}
        paid = tx(
            headers, type="emi", account_id=target, to_account_id=loan, amount="10.00", interest="1"
        )
        assert messages(paid) == {"account_id": message}
        into = tx(
            headers, type="emi", account_id=pay, to_account_id=target, amount="10.00", interest="1"
        )
        assert messages(into) == {"to_account_id": message}


def test_a_deposit_takes_only_interest_as_income(headers: Headers) -> None:
    p = ppf(headers).json()["id"]
    r = rd(headers, bank(headers)).json()["id"]

    wrong = tx(headers, type="income", account_id=p, amount="10.00", category="Salary")
    assert messages(wrong) == {"category": "Interest is the only income a PPF account takes."}
    wrong = tx(headers, type="income", account_id=r, amount="10.00", category="Salary")
    assert messages(wrong) == {"category": "Interest is the only income an RD takes."}
    paid = tx(headers, type="income", account_id=p, amount="10.00", category="Interest")
    assert paid.status_code == 201
    paid = tx(headers, type="income", account_id=r, amount="10.00", category="interest")
    assert paid.status_code == 201


def test_a_deposit_transfers_only_with_a_bank(headers: Headers) -> None:
    pay = bank(headers)
    p = ppf(headers).json()["id"]
    r = rd(headers, pay).json()["id"]
    cash = make(headers, type="cash", name="Wallet", balance="5000.00").json()["id"]

    into = tx(headers, type="transfer", account_id=cash, to_account_id=p, amount="10.00")
    assert messages(into) == {"account_id": PPF_ONLY}
    out = tx(headers, type="transfer", account_id=r, to_account_id=cash, amount="10.00")
    assert messages(out) == {"to_account_id": RD_ONLY}
    both = tx(headers, type="transfer", account_id=p, to_account_id=r, amount="10.00")
    assert messages(both) == {"account_id": RD_ONLY, "to_account_id": PPF_ONLY}

    ok = tx(headers, type="transfer", account_id=pay, to_account_id=p, amount="10.00")
    assert ok.status_code == 201
    ok = tx(headers, type="transfer", account_id=p, to_account_id=pay, amount="10.00")
    assert ok.status_code == 201


def test_editing_a_transaction_into_a_deposit_is_refused(headers: Headers) -> None:
    pay = bank(headers)
    p = ppf(headers).json()["id"]
    cash = make(headers, type="cash", name="Wallet", balance="5000.00").json()["id"]
    made = tx(headers, type="transfer", account_id=cash, to_account_id=pay, amount="10.00").json()

    edit = client.patch(
        f"/api/transactions/{made['id']}", json={"to_account_id": p}, headers=headers
    )
    assert edit.status_code == 422
    assert messages(edit) == {"account_id": PPF_ONLY}


def test_an_rd_with_more_transfers_than_its_tenure_can_still_be_renamed(
    headers: Headers,
) -> None:
    pay = bank(headers)
    created = rd(headers, pay, tenure_months=1, deposits_paid=1).json()
    assert deposit_in(headers, pay, created["id"]).status_code == 201  # a later month
    path = f"/api/accounts/{created['id']}"

    renamed = client.patch(path, json={"name": "Renamed"}, headers=headers)
    assert renamed.status_code == 200
    assert renamed.json()["deposit"]["deposits_paid"] == 2

    changed = client.patch(path, json={"tenure_months": 1}, headers=headers)
    assert changed.status_code == 422
    assert messages(changed) == {
        "deposits_paid": "Enter the instalments paid so far, from 0 to the tenure."
    }


# Close RD


def close(headers: Headers, id: int, **fields: Any) -> Response:
    body = {"amount": "100.00", "date": today_india().isoformat(), **fields}
    return client.post(f"/api/accounts/{id}/close-rd", json=body, headers=headers)


def rd_rows(headers: Headers, id: int) -> list[dict]:
    rows = client.get(f"/api/transactions?account_id={id}", headers=headers).json()
    return sorted(rows["transactions"], key=lambda t: (t["type"], t["amount"]))


def bank_balance(headers: Headers, id: int) -> str:
    return one(headers, id)["balance"]


def test_close_rd_above_balance_books_interest_then_pays_out(headers: Headers) -> None:
    pay = bank(headers, balance="1000.00")
    created = rd(headers, pay, balance="120000.00").json()

    response = close(headers, created["id"], amount="129098.90", account_id=pay)

    assert response.status_code == 200
    body = response.json()
    assert body["balance"] == "0.00"
    assert body["archived"] is True
    assert bank_balance(headers, pay) == "130098.90"
    interest, moved = rd_rows(headers, created["id"])
    assert (interest["type"], interest["amount"]) == ("income", "9098.90")
    assert (interest["category"], interest["note"]) == ("Interest", "Interest on closing")
    assert (moved["type"], moved["amount"], moved["note"]) == ("transfer", "129098.90", "RD closed")
    assert moved["to_account_id"] == pay
    assert {interest["date"], moved["date"]} == {today_india().isoformat()}


def test_close_rd_below_balance_books_a_fee(headers: Headers) -> None:
    pay = bank(headers, balance="1000.00")
    created = rd(headers, pay, balance="20000.00").json()

    response = close(headers, created["id"], amount="19800.00", account_id=pay)

    assert response.status_code == 200
    assert response.json()["balance"] == "0.00"
    assert bank_balance(headers, pay) == "20800.00"
    fee, moved = rd_rows(headers, created["id"])
    assert (fee["type"], fee["amount"]) == ("expense", "200.00")
    assert (fee["category"], fee["note"]) == ("Fees and charges", "Closed early")
    assert (moved["type"], moved["amount"]) == ("transfer", "19800.00")


def test_close_rd_at_the_balance_only_transfers(headers: Headers) -> None:
    pay = bank(headers, balance="1000.00")
    created = rd(headers, pay, balance="20000.00").json()

    assert close(headers, created["id"], amount="20000.00", account_id=pay).status_code == 200

    rows = rd_rows(headers, created["id"])
    assert [r["type"] for r in rows] == ["transfer"]


def test_close_rd_checks_its_input_and_writes_nothing_on_error(headers: Headers) -> None:
    pay = bank(headers)
    old = bank(headers, "Old")
    client.post(f"/api/accounts/{old}/archive", headers=headers)
    cash = make(headers, type="cash", name="Wallet", balance="5000.00").json()["id"]
    created = rd(headers, pay).json()
    today = today_india()
    opened = date.fromisoformat(created["opened_on"])

    bad = [
        ({"account_id": old}, "account_id"),
        ({"account_id": cash}, "account_id"),
        ({"account_id": created["id"]}, "account_id"),
        ({"account_id": 999999}, "account_id"),
        ({"amount": "0.00"}, "amount"),
        ({"amount": "-5.00"}, "amount"),
        ({"date": (today + timedelta(days=1)).isoformat()}, "date"),
        ({"date": (opened - timedelta(days=1)).isoformat()}, "date"),
    ]
    for fields, field in bad:
        response = close(headers, created["id"], **{"account_id": pay, **fields})
        assert response.status_code == 422, fields
        assert field in messages(response), fields
    empty = client.post(
        f"/api/accounts/{created['id']}/close-rd", json={"account_id": pay}, headers=headers
    )
    assert messages(empty).keys() == {"amount", "date"}

    assert rd_rows(headers, created["id"]) == []
    assert one(headers, created["id"])["archived"] is False


def test_close_rd_refuses_a_date_before_later_activity(headers: Headers) -> None:
    pay = bank(headers)
    created = rd(headers, pay).json()
    latest = today_india() - timedelta(days=1)
    sent = post(
        headers,
        type="transfer",
        account_id=pay,
        to_account_id=created["id"],
        amount="5000.00",
        date=latest.isoformat(),
    )
    assert sent.status_code == 201

    early = close(
        headers,
        created["id"],
        amount="10000.00",
        account_id=pay,
        date=(latest - timedelta(days=1)).isoformat(),
    )

    assert early.status_code == 422
    assert messages(early)["date"] == (
        f"The RD has transactions after this date. Choose {latest.isoformat()} or later."
    )
    assert one(headers, created["id"])["archived"] is False
    # On the day of the last transaction is fine.
    on_day = close(
        headers, created["id"], amount="10000.00", account_id=pay, date=latest.isoformat()
    )
    assert on_day.status_code == 200


def test_close_rd_refuses_other_accounts_and_a_second_close(headers: Headers) -> None:
    pay = bank(headers)
    p = ppf(headers).json()["id"]
    created = rd(headers, pay).json()

    assert close(headers, p, account_id=pay).status_code == 404
    assert close(headers, pay, account_id=pay).status_code == 404
    assert close(headers, 999999, account_id=pay).status_code == 404

    assert close(headers, created["id"], amount="5000.00", account_id=pay).status_code == 200
    again = close(headers, created["id"], amount="5000.00", account_id=pay)
    assert again.status_code == 409


def test_a_closed_rd_shows_no_interest_or_due_lines_and_stays_closed(headers: Headers) -> None:
    pay = bank(headers, balance="1000.00")
    created = rd(headers, pay, balance="120000.00", opened_on=first_of_month(5).isoformat()).json()
    assert close(headers, created["id"], amount="129098.90", account_id=pay).status_code == 200

    shown = client.get("/api/accounts?archived=true", headers=headers).json()["accounts"]
    closed = next(a for a in shown if a["id"] == created["id"])
    assert closed["deposit"]["interest_so_far"] == "0.00"
    assert closed["deposit"]["due"] == []
    assert closed["deposit"]["value_today"] == closed["balance"] == "0.00"

    restored = client.post(f"/api/accounts/{created['id']}/restore", headers=headers)
    assert restored.status_code == 409
    assert restored.json()["detail"] == "This RD was closed. Its record stays in the archive."


def test_an_archived_empty_rd_with_no_payout_can_be_restored(headers: Headers) -> None:
    pay = bank(headers)
    created = rd(headers, pay, balance="0.00", deposits_paid=0).json()
    assert client.post(f"/api/accounts/{created['id']}/archive", headers=headers).status_code == 200

    restored = client.post(f"/api/accounts/{created['id']}/restore", headers=headers)

    assert restored.status_code == 200
    assert restored.json()["archived"] is False


def test_a_loan_cannot_be_paid_from_a_ppf_or_rd(headers: Headers) -> None:
    pay = bank(headers)
    for deposit in (ppf(headers).json()["id"], rd(headers, pay).json()["id"]):
        response = make(
            headers,
            type="loan",
            name="Car",
            balance="1000.00",
            interest_rate="9.00",
            emi_amount="100.00",
            emis_left=10,
            pay_from_id=deposit,
        )
        assert response.status_code == 422
        assert "Choose the account EMIs are paid from." in response.text


def test_an_archived_ppf_shows_no_interest_due(headers: Headers) -> None:
    created = ppf(headers, name="Empty", balance="0.00").json()
    assert client.post(f"/api/accounts/{created['id']}/archive", headers=headers).status_code == 200
    shown = client.get("/api/accounts?archived=true", headers=headers).json()["accounts"]
    closed = next(a for a in shown if a["id"] == created["id"])
    assert closed["deposit"]["interest_due"] is None
