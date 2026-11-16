"""Fixed deposits: the maths, the account type, closing, renewing, and their upcoming items."""

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.api.deposits import (
    Dated,
    add_months,
    fd_interest_so_far,
    fd_maturity_value,
    fd_payout_amount,
    fd_value,
)
from app.main import app
from tests.test_accounts import Headers, auth

client = TestClient(app)
D = Decimal


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


# The maths


def test_one_year_compounds_four_quarters() -> None:
    # 1,00,000 at 7% for a year: 1,00,000 x 1.0175^4.
    one = [Dated(date(2026, 1, 1), D(100000))]
    assert fd_maturity_value(one, D(7), date(2027, 1, 1)) == D("107185.90")


def test_days_after_the_last_whole_quarter_earn_simple_interest() -> None:
    # 444 days: four whole quarters to 1 Jan 2027, then 79 days of simple interest.
    one = [Dated(date(2026, 1, 1), D(100000))]
    assert fd_maturity_value(one, D("7.25"), date(2027, 3, 21)) == D("109135.58")


def test_under_a_quarter_is_simple_interest() -> None:
    value = fd_value(D(50000), D("6.5"), date(2026, 1, 1), date(2026, 2, 15))
    assert value.quantize(D("0.01")) == D("50400.68")


def test_value_before_the_start_is_the_principal() -> None:
    assert fd_value(D(1000), D(7), date(2026, 5, 1), date(2026, 4, 1)) == D(1000)


def test_interest_so_far_stops_at_maturity_and_takes_off_what_is_recorded() -> None:
    one = [Dated(date(2026, 1, 1), D(100000))]
    maturity = date(2027, 1, 1)
    late = date(2030, 1, 1)
    assert fd_interest_so_far(one, D(7), late, maturity, D(0)) == D("7185.90")
    assert fd_interest_so_far(one, D(7), late, maturity, D("7000")) == D("185.90")
    assert fd_interest_so_far(one, D(7), late, maturity, D("9000")) == D("0.00")


def test_payout_amounts() -> None:
    assert fd_payout_amount(D(200000), D("7.1"), "monthly") == D("1183.33")
    assert fd_payout_amount(D(200000), D("7.1"), "quarterly") == D("3550.00")
    assert fd_payout_amount(D(200000), D("7.1"), "cumulative") is None


# The account type


def bank(headers: Headers, name: str = "SBI", balance: str = "100000.00") -> int:
    body = {"type": "bank", "bank_kind": "savings", "name": name, "balance": balance}
    return client.post("/api/accounts", json=body, headers=headers).json()["id"]


def fd(headers: Headers, **fields: Any) -> Response:
    today = today_india()
    body = {
        "type": "fd",
        "name": "SBI FD",
        "balance": "100000.00",
        "interest_rate": "7.00",
        "opened_on": add_months(today, -3).isoformat(),
        "matures_on": add_months(today, 9).isoformat(),
        "fd_payout": "cumulative",
        **fields,
    }
    return client.post("/api/accounts", json=body, headers=headers)


def messages(response: Response) -> dict[str, str]:
    return {e["loc"][-1]: e["msg"] for e in response.json()["detail"]}


def listing(headers: Headers, archived: bool = False) -> list[dict]:
    query = "?archived=true" if archived else ""
    return client.get(f"/api/accounts{query}", headers=headers).json()["accounts"]


def one(headers: Headers, id: int) -> dict:
    return next(a for a in listing(headers) + listing(headers, True) if a["id"] == id)


def test_create_a_cumulative_fd(headers: Headers) -> None:
    response = fd(headers)

    assert response.status_code == 201
    body = response.json()
    assert body["type"] == "fd"
    assert body["fd_payout"] == "cumulative"
    assert body["matures_on"] == add_months(today_india(), 9).isoformat()
    figures = body["deposit"]
    assert figures["kind"] == "fd"
    assert figures["principal"] == "100000.00"
    assert figures["maturity_value"] == "107185.90"
    assert figures["payout_amount"] is None
    assert figures["matured"] is False
    # One whole quarter has passed: 1,00,000 x 1.0175 - 1,00,000.
    assert figures["interest_so_far"] == "1750.00"
    assert figures["value_today"] == "101750.00"


def test_an_fd_counts_in_what_you_have(headers: Headers) -> None:
    fd(headers)
    response = client.get("/api/accounts", headers=headers).json()
    assert response["total_have"] == "100000.00"


def test_a_payout_fd_pays_interest_out_and_matures_at_its_principal(headers: Headers) -> None:
    body = fd(headers, balance="200000.00", interest_rate="7.10", fd_payout="quarterly").json()

    figures = body["deposit"]
    assert figures["payout"] == "quarterly"
    assert figures["payout_amount"] == "3550.00"
    assert figures["interest_so_far"] == "0.00"
    assert figures["maturity_value"] == "200000.00"


def test_each_missing_fd_field_gives_its_message(headers: Headers) -> None:
    body = {"type": "fd", "name": "FD", "balance": "0.00"}
    response = client.post("/api/accounts", json=body, headers=headers)

    assert response.status_code == 422
    assert messages(response) == {
        "interest_rate": "Enter the yearly interest rate.",
        "opened_on": "Choose the date it was opened.",
        "matures_on": "Choose the maturity date.",
        "fd_payout": "Choose how the interest is paid.",
    }


def test_maturity_must_come_after_opening(headers: Headers) -> None:
    today = today_india().isoformat()
    response = fd(headers, opened_on=today, matures_on=today)

    assert messages(response) == {
        "matures_on": "Choose a maturity date after the opening date.",
    }


def test_an_unknown_payout_is_refused(headers: Headers) -> None:
    assert messages(fd(headers, fd_payout="yearly")) == {"fd_payout": "Choose a kind of account."}


def test_rd_and_loan_fields_are_refused_on_an_fd(headers: Headers) -> None:
    response = fd(headers, tenure_months=12, emi_amount="100.00")

    assert messages(response) == {
        "emi_amount": "Not applicable to this account type.",
        "tenure_months": "Not applicable to this account type.",
    }


def test_fd_fields_are_refused_on_other_types(headers: Headers) -> None:
    body = {
        "type": "cash",
        "name": "Cash",
        "balance": "0.00",
        "matures_on": "2030-01-01",
        "fd_payout": "monthly",
    }
    response = client.post("/api/accounts", json=body, headers=headers)

    assert messages(response) == {
        "fd_payout": "Not applicable to this account type.",
        "matures_on": "Not applicable to this account type.",
    }


def test_an_fd_can_be_edited(headers: Headers) -> None:
    id_ = fd(headers).json()["id"]
    later = add_months(today_india(), 12).isoformat()

    response = client.patch(
        f"/api/accounts/{id_}",
        json={"matures_on": later, "fd_payout": "monthly", "interest_rate": "7.50"},
        headers=headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["matures_on"], body["fd_payout"]) == (later, "monthly")
    assert body["deposit"]["payout_amount"] == "625.00"


def test_the_pay_from_account_must_be_a_bank(headers: Headers) -> None:
    cash = client.post(
        "/api/accounts", json={"type": "cash", "name": "Cash", "balance": "0.00"}, headers=headers
    ).json()["id"]

    assert messages(fd(headers, pay_from_id=cash)) == {"pay_from_id": "Choose a bank account."}


def test_archiving_the_bank_clears_an_fds_link(headers: Headers) -> None:
    pay = bank(headers, balance="0.00")
    id_ = fd(headers, pay_from_id=pay).json()["id"]

    assert client.post(f"/api/accounts/{pay}/archive", headers=headers).status_code == 200
    assert one(headers, id_)["pay_from_id"] is None


# Transactions


def post(headers: Headers, **fields: Any) -> Response:
    body = {"date": today_india().isoformat(), **fields}
    return client.post("/api/transactions", json=body, headers=headers)


def test_an_fd_takes_money_only_from_a_bank_and_pays_only_to_one(headers: Headers) -> None:
    pay = bank(headers)
    id_ = fd(headers).json()["id"]
    cash = client.post(
        "/api/accounts", json={"type": "cash", "name": "Cash", "balance": "500.00"}, headers=headers
    ).json()["id"]

    into = post(headers, type="transfer", account_id=pay, to_account_id=id_, amount="5000.00")
    from_cash = post(headers, type="transfer", account_id=cash, to_account_id=id_, amount="10.00")
    spend = post(headers, type="expense", account_id=id_, amount="10.00", category="Groceries")

    assert into.status_code == 201
    assert messages(from_cash) == {
        "account_id": "An FD only takes deposits, interest and withdrawals to a bank."
    }
    assert messages(spend) == {
        "account_id": "An FD only takes deposits, interest and withdrawals to a bank."
    }
    assert one(headers, id_)["deposit"]["principal"] == "105000.00"


def test_an_fd_takes_only_interest_as_income(headers: Headers) -> None:
    id_ = fd(headers).json()["id"]

    salary = post(headers, type="income", account_id=id_, amount="10.00", category="Salary")

    assert messages(salary) == {"category": "Interest is the only income an FD takes."}


# Closing


def close(headers: Headers, id_: int, **fields: Any) -> Response:
    body = {"date": today_india().isoformat(), **fields}
    return client.post(f"/api/accounts/{id_}/close-fd", json=body, headers=headers)


def rows(headers: Headers, account_id: int) -> list[dict]:
    query = f"/api/transactions?account_id={account_id}"
    found = client.get(query, headers=headers).json()["transactions"]
    return sorted(found, key=lambda t: t["id"])


def test_close_fd_books_the_interest_and_pays_out(headers: Headers) -> None:
    pay = bank(headers, balance="1000.00")
    id_ = fd(headers).json()["id"]

    response = close(headers, id_, amount="107185.90", account_id=pay)

    assert response.status_code == 200
    body = response.json()
    assert (body["balance"], body["archived"]) == ("0.00", True)
    assert body["deposit"]["interest_so_far"] == "0.00"
    assert one(headers, pay)["balance"] == "108185.90"
    interest, moved = rows(headers, id_)
    assert (interest["type"], interest["amount"], interest["category"]) == (
        "income",
        "7185.90",
        "Interest",
    )
    assert (moved["type"], moved["note"]) == ("transfer", "FD closed")


def test_close_fd_refuses_an_rd_and_close_rd_refuses_an_fd(headers: Headers) -> None:
    pay = bank(headers)
    id_ = fd(headers).json()["id"]

    as_rd = client.post(
        f"/api/accounts/{id_}/close-rd",
        json={"amount": "1.00", "date": today_india().isoformat(), "account_id": pay},
        headers=headers,
    )

    assert as_rd.status_code == 404


def test_a_closed_fd_cannot_be_restored_or_closed_again(headers: Headers) -> None:
    pay = bank(headers)
    id_ = fd(headers).json()["id"]
    assert close(headers, id_, amount="100000.00", account_id=pay).status_code == 200

    again = close(headers, id_, amount="100000.00", account_id=pay)
    restore = client.post(f"/api/accounts/{id_}/restore", headers=headers)

    assert again.status_code == 409
    assert again.json()["detail"] == "This FD is already closed."
    assert restore.status_code == 409
    assert restore.json()["detail"] == "This FD was closed. Its record stays in the archive."


# Renewing


def renew(headers: Headers, id_: int, **fields: Any) -> Response:
    body = {
        "date": today_india().isoformat(),
        "interest_rate": "7.25",
        "matures_on": add_months(today_india(), 12).isoformat(),
        "fd_payout": "cumulative",
        **fields,
    }
    return client.post(f"/api/accounts/{id_}/renew-fd", json=body, headers=headers)


def test_renew_rolls_the_whole_amount_into_a_new_fd(headers: Headers) -> None:
    pay = bank(headers, balance="1000.00")
    old = fd(headers, institution="SBI").json()["id"]

    response = renew(headers, old, amount="107185.90", account_id=pay)

    assert response.status_code == 201
    new = response.json()
    assert new["id"] != old
    assert (new["type"], new["name"], new["institution"]) == ("fd", "SBI FD", "SBI")
    assert (new["balance"], new["interest_rate"]) == ("107185.90", "7.25")
    assert new["opened_on"] == today_india().isoformat()
    assert new["pay_from_id"] == pay
    assert new["deposit"]["principal"] == "107185.90"
    assert one(headers, old)["archived"] is True
    assert one(headers, old)["balance"] == "0.00"
    # The money went through the bank and back out, so the bank is where it was.
    assert one(headers, pay)["balance"] == "1000.00"
    (into,) = rows(headers, new["id"])
    assert (into["account_id"], into["note"]) == (pay, "Renewed from SBI FD")


def test_renew_part_and_keep_the_rest_in_the_bank(headers: Headers) -> None:
    pay = bank(headers, balance="0.00")
    old = fd(headers).json()["id"]

    response = renew(
        headers, old, amount="107185.90", reinvest="100000.00", account_id=pay, name="FD 2"
    )

    assert response.status_code == 201
    assert (response.json()["name"], response.json()["balance"]) == ("FD 2", "100000.00")
    assert one(headers, pay)["balance"] == "7185.90"


def test_renew_checks_its_input_and_writes_nothing_on_error(headers: Headers) -> None:
    pay = bank(headers)
    old = fd(headers).json()["id"]
    before = len(listing(headers))

    response = client.post(
        f"/api/accounts/{old}/renew-fd",
        json={
            "amount": "100.00",
            "reinvest": "200.00",
            "date": today_india().isoformat(),
            "account_id": pay,
        },
        headers=headers,
    )

    assert response.status_code == 422
    assert messages(response) == {
        "interest_rate": "Enter the yearly interest rate.",
        "fd_payout": "Choose how the interest is paid.",
        "matures_on": "Choose the maturity date.",
        "reinvest": "You can't renew more than the amount received.",
    }
    assert len(listing(headers)) == before
    assert one(headers, old)["archived"] is False


def test_renew_needs_a_maturity_after_the_renewal_date(headers: Headers) -> None:
    pay = bank(headers)
    old = fd(headers).json()["id"]

    response = renew(
        headers, old, amount="100000.00", account_id=pay, matures_on=today_india().isoformat()
    )

    assert messages(response) == {"matures_on": "Choose a maturity date after the renewal date."}


# Upcoming


def upcoming(headers: Headers) -> list[dict]:
    return client.get("/api/upcoming", headers=headers).json()["items"]


def test_maturity_in_the_window_is_money_into_the_bank(headers: Headers) -> None:
    pay = bank(headers)
    soon = today_india() + timedelta(days=10)
    id_ = fd(headers, pay_from_id=pay, matures_on=soon.isoformat()).json()["id"]

    (item,) = [i for i in upcoming(headers) if i["kind"] == "fd"]

    assert (item["date"], item["ref_id"], item["direction"]) == (soon.isoformat(), id_, "in")
    assert (item["name"], item["account_id"]) == ("SBI FD matures", pay)
    assert item["overdue"] is False


def test_a_matured_fd_stays_overdue_until_closed(headers: Headers) -> None:
    pay = bank(headers)
    today = today_india()
    id_ = fd(
        headers,
        pay_from_id=pay,
        opened_on=add_months(today, -13).isoformat(),
        matures_on=add_months(today, -1).isoformat(),
    ).json()["id"]

    assert one(headers, id_)["deposit"]["matured"] is True
    (item,) = [i for i in upcoming(headers) if i["kind"] == "fd"]
    assert item["overdue"] is True

    close(headers, id_, amount="107185.90", account_id=pay)
    assert [i for i in upcoming(headers) if i["kind"] == "fd"] == []


def test_a_far_maturity_is_not_listed(headers: Headers) -> None:
    fd(headers)
    assert [i for i in upcoming(headers) if i["kind"] == "fd"] == []


def test_a_monthly_payout_fd_lists_its_next_interest_payment(headers: Headers) -> None:
    pay = bank(headers)
    today = today_india()
    opened = add_months(today, -2) + timedelta(days=5)
    fd(
        headers,
        balance="120000.00",
        interest_rate="6.00",
        fd_payout="monthly",
        pay_from_id=pay,
        opened_on=opened.isoformat(),
    )

    payments = [i for i in upcoming(headers) if i["kind"] == "fd_interest"]

    assert len(payments) == 1
    (item,) = payments
    assert item["amount"] == "600.00"
    assert item["direction"] == "in"
    assert item["date"] == add_months(opened, 2).isoformat()
