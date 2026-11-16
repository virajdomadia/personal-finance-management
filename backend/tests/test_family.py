"""Family members: profiles under the owner's login, kept apart from the owner's figures, and
the family portfolio that brings their investments together."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.main import app
from app.models.user import User
from tests.test_accounts import Headers, auth

client = TestClient(app)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def add(headers: Headers, name: str) -> int:
    response = client.post("/api/family/members", json={"name": name}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def as_(headers: Headers, member: int) -> Headers:
    return {**headers, "X-Profile": str(member)}


def broker(headers: Headers, name: str = "Zerodha") -> int:
    body = {"type": "broker", "name": name, "balance": "0.00"}
    return client.post("/api/accounts", json=body, headers=headers).json()["id"]


def ppf(headers: Headers, balance: str) -> int:
    body = {"type": "ppf", "name": "PPF", "balance": balance, "interest_rate": "7.10",
            "opened_on": "2020-06-10"}  # fmt: skip
    return client.post("/api/accounts", json=body, headers=headers).json()["id"]


def stock(headers: Headers, symbol: str, shares: int, price: str) -> None:
    account = broker(headers, f"Broker {symbol}")
    body: dict[str, Any] = {
        "stock": {"symbol": symbol, "name": f"{symbol} Ltd"},
        "trade": {"account_id": account, "date": today_india().isoformat(),
                  "quantity": shares, "price": price, "opening": True},
    }  # fmt: skip
    response = client.post("/api/investments/stocks/with-trade", json=body, headers=headers)
    assert response.status_code == 201, response.text


# Members


def test_add_rename_and_list_members(headers: Headers) -> None:
    papa = add(headers, "Papa")
    add(headers, "Mummy")
    renamed = client.patch(f"/api/family/members/{papa}", json={"name": "Dad"}, headers=headers)

    assert renamed.json() == {"id": papa, "name": "Dad"}
    family = client.get("/api/family", headers=headers).json()
    assert family["me"]["name"] == "Me"
    assert [m["name"] for m in family["members"]] == ["Dad", "Mummy"]


@pytest.mark.parametrize(
    ("name", "message"),
    [("", "Enter a name."), ("me", '"Me" is you. Choose another name.'),
     ("papa", "You already have papa.")],
)  # fmt: skip
def test_member_names_are_checked(headers: Headers, name: str, message: str) -> None:
    add(headers, "Papa")

    response = client.post("/api/family/members", json={"name": name}, headers=headers)

    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == message


def test_at_most_ten_members(headers: Headers) -> None:
    for i in range(10):
        add(headers, f"Member {i}")

    response = client.post("/api/family/members", json={"name": "One more"}, headers=headers)

    assert response.status_code == 409


def test_a_member_can_never_sign_in(headers: Headers, db_session: Session) -> None:
    papa = db_session.get(User, add(headers, "Papa"))

    assert papa is not None and papa.owner_id is not None
    assert papa.email.endswith("@members.invalid")


# Acting for a member


def test_a_members_data_is_kept_apart_from_the_owners(headers: Headers) -> None:
    papa = add(headers, "Papa")
    ppf(headers, "1000.00")
    ppf(as_(headers, papa), "50000.00")

    mine = client.get("/api/accounts", headers=headers).json()
    theirs = client.get("/api/accounts", headers=as_(headers, papa)).json()

    assert mine["total_have"] == "1000.00"
    assert theirs["total_have"] == "50000.00"
    assert [a["name"] for a in theirs["accounts"]] == ["PPF"]


def test_the_owners_own_id_is_the_owner(headers: Headers) -> None:
    me = client.get("/api/family", headers=headers).json()["me"]["id"]
    ppf(headers, "10.00")

    assert client.get("/api/accounts", headers=as_(headers, me)).json()["total_have"] == "10.00"


def test_someone_elses_member_is_refused(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = auth(db_session, monkeypatch, email="other@example.com")
    theirs = add(other, "Their dad")

    for profile in (str(theirs), "999999", "abc", "-1"):
        response = client.get("/api/accounts", headers={**headers, "X-Profile": profile})
        assert response.status_code == 404, profile


def test_sms_and_the_session_are_always_the_owners(headers: Headers) -> None:
    papa = add(headers, "Papa")

    session = client.get("/api/auth/session", headers=as_(headers, papa))
    review = client.get("/api/sms/review", headers=as_(headers, papa))

    assert session.json()["email"] == "me@example.com"
    assert review.status_code == 200


def test_family_routes_ignore_the_profile(headers: Headers) -> None:
    papa = add(headers, "Papa")

    family = client.get("/api/family", headers=as_(headers, papa)).json()

    assert [m["id"] for m in family["members"]] == [papa]


# Removing


def test_removing_a_member_needs_their_name_and_deletes_their_data(
    headers: Headers, db_session: Session
) -> None:
    papa = add(headers, "Papa")
    ppf(as_(headers, papa), "500.00")

    refused = client.delete(f"/api/family/members/{papa}?confirm=nope", headers=headers)
    removed = client.delete(f"/api/family/members/{papa}?confirm=PAPA", headers=headers)

    assert refused.status_code == 422
    assert removed.status_code == 200
    assert removed.json()["members"] == []
    assert db_session.get(User, papa) is None
    assert client.get("/api/accounts", headers=as_(headers, papa)).status_code == 404


def test_only_your_own_members_can_be_changed(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    other = auth(db_session, monkeypatch, email="other@example.com")
    theirs = add(other, "Their dad")

    rename = client.patch(f"/api/family/members/{theirs}", json={"name": "X"}, headers=headers)
    remove = client.delete(f"/api/family/members/{theirs}?confirm=Their dad", headers=headers)

    assert (rename.status_code, remove.status_code) == (404, 404)


# The family portfolio


def test_the_family_portfolio_adds_everyone_up(headers: Headers) -> None:
    papa = add(headers, "Papa")
    stock(headers, "INFY", 10, "1500.00")
    ppf(headers, "20000.00")
    stock(as_(headers, papa), "TCS", 5, "3000.00")

    body = client.get("/api/family/portfolio", headers=headers).json()

    me, dad = body["people"]
    assert (me["name"], me["is_me"], dad["name"]) == ("Me", True, "Papa")
    assert me["by_type"]["stocks"]["invested"] == "15000.00"
    assert me["by_type"]["deposits"]["value"] == "20000.00"
    assert me["overall"]["invested"] == "35000.00"
    assert dad["overall"]["invested"] == "15000.00"
    assert [h["symbol"] for h in dad["holdings"]] == ["TCS"]
    assert body["by_type"]["stocks"]["invested"] == "30000.00"
    assert body["overall"]["invested"] == "50000.00"
    # The owner's own Investments page is still only theirs.
    mine = client.get("/api/investments/portfolio", headers=headers).json()
    assert mine["overall"]["invested"] == "35000.00"


def test_an_empty_family_portfolio(headers: Headers) -> None:
    body = client.get("/api/family/portfolio", headers=headers).json()

    assert [p["name"] for p in body["people"]] == ["Me"]
    assert body["overall"] == {
        "invested": "0.00",
        "value": "0.00",
        "unrealised": "0.00",
        "unrealised_percent": "0.00",
    }
