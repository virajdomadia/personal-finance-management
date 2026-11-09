from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.api.routes import fund_trades, funds, sips
from app.main import app
from app.models.user import User
from tests.test_accounts import Headers, archive, auth, locs
from tests.test_fund_trades import bank, broker, buy, fund, patch, stock

client = TestClient(app)

URL = "/api/investments/sips"
TODAY = date(2026, 11, 9)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (funds, fund_trades, sips):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def new_sip(headers: Headers, fund_id: int, account_id: int, **fields: Any) -> Response:
    body = {
        "fund_id": fund_id,
        "account_id": account_id,
        "amount": "3000.00",
        "day": 5,
        "start_date": "2026-10-05",
        **fields,
    }
    return client.post(URL, json=body, headers=headers)


def made(headers: Headers, fund_id: int, account_id: int, **fields: Any) -> dict[str, Any]:
    response = new_sip(headers, fund_id, account_id, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def listed(headers: Headers, **params: Any) -> list[dict[str, Any]]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()["sips"]


def setup(headers: Headers) -> tuple[int, int]:
    return fund(headers), bank(headers)


def test_new_sip_is_due_from_its_start(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    body = made(headers, fund_id, account_id)
    assert body["due"] == ["2026-10-05", "2026-11-05"]
    assert body["due_date"] == "2026-10-05"
    assert body["instalments"] == 0
    assert body["amount"] == "3000.00"
    assert body["symbol"] == "PPFCF"
    assert body["fund_name"] == "Parag Parikh Flexi Cap"
    assert body["account_name"] == "SBI"
    assert body["active"] is True
    assert listed(headers) == [body]


def test_recording_fills_the_oldest_month(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    response = buy(
        headers, fund_id=fund_id, account_id=account_id, date="2026-10-05", sip_id=sip_id
    )
    assert response.status_code == 201, response.json()
    [row] = listed(headers)
    assert row["due"] == ["2026-11-05"]
    assert row["due_date"] == "2026-11-05"
    assert row["instalments"] == 1


def test_linked_opening_purchases_settle_months(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    response = buy(
        headers,
        fund_id=fund_id,
        account_id=account_id,
        date="2026-10-05",
        opening=True,
        sip_id=sip_id,
        nav=None,
    )
    assert response.status_code == 201, response.json()
    [row] = listed(headers)
    assert row["due"] == ["2026-11-05"]
    assert row["instalments"] == 1


def test_moving_an_instalment_reopens_its_month(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    trade = buy(headers, fund_id=fund_id, account_id=account_id, date="2026-10-05", sip_id=sip_id)
    assert patch(headers, trade.json()["id"], date="2026-11-05").status_code == 200
    [row] = listed(headers)
    assert row["due"] == ["2026-10-05"]
    assert row["instalments"] == 1


def test_stopped_sip_is_not_due(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    response = client.patch(f"{URL}/{sip_id}", json={"active": False}, headers=headers)
    assert response.status_code == 200
    assert response.json()["active"] is False
    assert response.json()["due"] == []
    assert response.json()["due_date"] is None


def test_stop_and_restart(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    client.patch(f"{URL}/{sip_id}", json={"active": False}, headers=headers)
    response = client.patch(f"{URL}/{sip_id}", json={"active": True}, headers=headers)
    assert response.json()["due"] == ["2026-10-05", "2026-11-05"]


def test_edit_amount_day_and_account(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    other = bank(headers, name="HDFC")
    sip_id = made(headers, fund_id, account_id)["id"]
    response = client.patch(
        f"{URL}/{sip_id}",
        json={"amount": "5000.00", "day": 10, "account_id": other},
        headers=headers,
    )
    body = response.json()
    assert response.status_code == 200, body
    assert (body["amount"], body["day"], body["account_name"]) == ("5000.00", 10, "HDFC")
    assert body["due"] == ["2026-10-10"]


def test_due_sip_list_is_oldest_first(headers: Headers, db_session: Session) -> None:
    fund_id, account_id = setup(headers)
    made(headers, fund_id, account_id, start_date="2026-11-05")
    older = made(headers, fund(headers, "OLD"), account_id, start_date="2026-09-05")
    made(headers, fund(headers, "FUT"), account_id, start_date="2026-12-05")
    user = db_session.query(User).one()
    due = sips.due_sip_list(db_session, user.id)
    assert len(due) == 2
    assert due[0].id == older["id"]
    assert due[0].due_date == "2026-09-05"


def test_list_filters_by_fund_and_orders_by_name(headers: Headers) -> None:
    account_id = bank(headers)
    first, second = fund(headers, "AAA"), fund(headers, "BBB")
    a = made(headers, first, account_id)
    b = made(headers, second, account_id)
    assert {s["id"] for s in listed(headers)} == {a["id"], b["id"]}
    assert [s["id"] for s in listed(headers, fund_id=second)] == [b["id"]]


def test_delete_rules(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    empty = made(headers, fund_id, account_id)["id"]
    response = client.delete(f"{URL}/{empty}", headers=headers)
    assert (response.status_code, response.json()) == (200, {"id": empty})
    assert listed(headers) == []
    used = made(headers, fund_id, account_id)["id"]
    buy(headers, fund_id=fund_id, account_id=account_id, date="2026-10-05", sip_id=used)
    response = client.delete(f"{URL}/{used}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "This SIP has instalments. Stop it instead."


@pytest.mark.parametrize(
    ("kind", "fields", "loc", "message"),
    [
        ("ok", {"fund_id": None}, "fund_id", "Choose a fund."),
        ("stock", {}, "fund_id", "Choose a fund."),
        ("ok", {"account_id": None}, "account_id", "Choose a bank account."),
        ("broker", {}, "account_id", "Choose a bank account."),
        ("archived", {}, "account_id", "Old is archived. Restore it to use it."),
        ("ok", {"amount": None}, "amount", "Enter the SIP amount."),
        ("ok", {"amount": "0.00"}, "amount", "Amount must be greater than 0."),
        ("ok", {"day": None}, "day", "Choose a day from 1 to 31."),
        ("ok", {"day": 0}, "day", "Choose a day from 1 to 31."),
        ("ok", {"day": 32}, "day", "Choose a day from 1 to 31."),
        ("ok", {"day": "5"}, "day", "Choose a day from 1 to 31."),
        ("ok", {"start_date": None}, "start_date", "Choose the first instalment's date."),
    ],
)
def test_field_rules(
    headers: Headers, kind: str, fields: dict[str, Any], loc: str, message: str
) -> None:
    fund_id, account_id = setup(headers)
    if kind == "stock":
        fund_id = stock(headers)
    elif kind == "broker":
        account_id = broker(headers)
    elif kind == "archived":
        account_id = bank(headers, name="Old")
        assert archive(headers, account_id).status_code == 200
    body = {
        "fund_id": fund_id,
        "account_id": account_id,
        "amount": "3000.00",
        "day": 5,
        "start_date": "2026-10-05",
        **fields,
    }
    response = client.post(URL, json=body, headers=headers)
    assert response.status_code == 422, response.json()
    assert locs(response) == [["body", loc]]
    assert response.json()["detail"][0]["msg"] == message


@pytest.mark.parametrize("field", ["fund_id", "start_date"])
def test_patch_forbids_fund_and_start(headers: Headers, field: str) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    value = fund_id if field == "fund_id" else "2026-10-06"
    response = client.patch(f"{URL}/{sip_id}", json={field: value}, headers=headers)
    assert response.status_code == 422


def test_patch_rules(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    for fields, loc in [
        ({"day": 0}, "day"),
        ({"amount": "0.00"}, "amount"),
        ({"account_id": broker(headers)}, "account_id"),
    ]:
        response = client.patch(f"{URL}/{sip_id}", json=fields, headers=headers)
        assert response.status_code == 422, response.json()
        assert locs(response) == [["body", loc]]


def test_sips_are_per_user(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    them = auth(db_session, monkeypatch, "them@example.com")
    assert listed(them) == []
    assert client.patch(f"{URL}/{sip_id}", json={"day": 6}, headers=them).status_code == 404
    assert client.delete(f"{URL}/{sip_id}", headers=them).status_code == 404
    response = new_sip(them, fund_id, bank(them))
    assert locs(response) == [["body", "fund_id"]]
    mine = new_sip(headers, fund_id, bank(them))
    assert locs(mine) == [["body", "account_id"]]
    assert client.patch(f"{URL}/0", json={"day": 6}, headers=headers).status_code == 404


@pytest.mark.postgres
def test_delete_loses_a_race_with_an_instalment(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    real = sips._instalments

    def late(db: Session, sip: Any) -> int:
        count = real(db, sip)
        buy(headers, fund_id=fund_id, account_id=account_id, date="2026-10-05", sip_id=sip_id)
        return count  # counted before the instalment landed

    monkeypatch.setattr(sips, "_instalments", late)
    response = client.delete(f"{URL}/{sip_id}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "This SIP has instalments. Stop it instead."


def test_restarting_a_sip_checks_its_bank(headers: Headers) -> None:
    fund_id, account_id = setup(headers)
    sip_id = made(headers, fund_id, account_id)["id"]
    stop = client.patch(f"{URL}/{sip_id}", json={"active": False}, headers=headers)
    assert stop.status_code == 200
    assert archive(headers, account_id).status_code == 200
    response = client.patch(f"{URL}/{sip_id}", json={"active": True}, headers=headers)
    assert response.status_code == 422, response.json()
    assert locs(response) == [["body", "account_id"]]
    assert response.json()["detail"][0]["msg"] == "SBI is archived. Restore it to use it."
    other = bank(headers, name="HDFC")
    response = client.patch(
        f"{URL}/{sip_id}", json={"active": True, "account_id": other}, headers=headers
    )
    assert response.status_code == 200, response.json()
    assert response.json()["active"] is True
