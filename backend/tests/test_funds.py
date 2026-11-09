from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.api.routes import funds
from app.api.routes.funds import Units, derive_symbol
from app.main import app
from tests.test_accounts import Headers, auth, locs
from tests.test_stocks import add_price, add_stock

client = TestClient(app)

URL = "/api/investments"
PARAG = "Parag Parikh Flexi Cap – Regular Growth"
UNITS = "Enter units above 0, with up to 3 decimals, like 35.552."
NAV = "Enter a NAV above 0, with up to 4 decimals, like 84.3793."
IN_USE = "This fund has transactions, NAVs or SIPs. Delete them first."


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(funds, "today_india", lambda: date(2026, 11, 9))
    return auth(db_session, monkeypatch)


def add_fund(headers: Headers, name: str = PARAG, **fields: Any) -> Response:
    return client.post(f"{URL}/funds", json={"name": name, **fields}, headers=headers)


def add_nav(headers: Headers, fund_id: int, day: str, nav: Any) -> Response:
    return client.post(
        f"{URL}/funds/{fund_id}/navs", json={"date": day, "nav": nav}, headers=headers
    )


def test_derive_symbol() -> None:
    assert derive_symbol(PARAG, set()) == "PPFCRG"
    assert derive_symbol("   ", set()) == "FUND"
    assert derive_symbol("–", set()) == "FUND"
    assert derive_symbol(PARAG, {"PPFCRG", "PPFCRG2"}) == "PPFCRG3"
    long = " ".join("A" for _ in range(25))
    assert derive_symbol(long, set()) == "A" * 20
    assert derive_symbol(long, {"A" * 20}) == "A" * 19 + "2"


def test_create_with_and_without_symbol(headers: Headers) -> None:
    first = add_fund(headers)
    assert first.status_code == 201
    assert first.json() == {
        "id": first.json()["id"],
        "symbol": "PPFCRG",
        "name": PARAG,
        "nav": None,
        "nav_date": None,
    }
    assert add_fund(headers).json()["symbol"] == "PPFCRG2"
    assert add_fund(headers, "Other", symbol=" mine ").json()["symbol"] == "MINE"


def test_duplicate_symbol_among_funds_only(headers: Headers) -> None:
    add_fund(headers, symbol="PPFCRG")
    response = add_fund(headers, "Another", symbol="ppfcrg")
    assert response.status_code == 422
    assert locs(response) == [["body", "symbol"]]
    assert response.json()["detail"][0]["msg"] == "You already have PPFCRG."
    other = add_fund(headers, "Another", symbol="X").json()["id"]
    response = client.patch(f"{URL}/funds/{other}", json={"symbol": "PPFCRG"}, headers=headers)
    assert response.status_code == 422
    add_stock(headers, "STK")
    assert add_fund(headers, "Same as stock", symbol="STK").status_code == 201


def test_name_rules(headers: Headers) -> None:
    for body in ({}, {"name": "  "}, {"name": "x" * 61}):
        response = client.post(f"{URL}/funds", json=body, headers=headers)
        assert response.status_code == 422
        assert locs(response) == [["body", "name"]]
    response = add_fund(headers, symbol="bad symbol")
    assert locs(response) == [["body", "symbol"]]


def test_patch_fund(headers: Headers) -> None:
    fund = add_fund(headers).json()["id"]
    response = client.patch(f"{URL}/funds/{fund}", json={"name": "New"}, headers=headers)
    assert response.status_code == 200
    assert response.json()["name"] == "New" and response.json()["symbol"] == "PPFCRG"
    response = client.patch(f"{URL}/funds/{fund}", json={"name": " "}, headers=headers)
    assert response.status_code == 422


def test_other_users_and_stocks_are_404(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    fund = add_fund(headers).json()["id"]
    stock = add_stock(headers).json()["id"]
    stranger = auth(db_session, monkeypatch, "other@example.com")
    for target in (stock, 0, 2**31, 99999):
        assert client.get(f"{URL}/funds/{target}/navs", headers=headers).status_code == 404
        assert add_nav(headers, target, "2026-11-01", "10").status_code == 404
        assert client.delete(f"{URL}/funds/{target}", headers=headers).status_code == 404
        patch = client.patch(f"{URL}/funds/{target}", json={"name": "x"}, headers=headers)
        assert patch.status_code == 404
    assert client.get(f"{URL}/funds/{fund}/navs", headers=stranger).status_code == 404
    assert client.delete(f"{URL}/funds/{fund}", headers=stranger).status_code == 404
    assert client.get(f"{URL}/funds", headers=stranger).json() == {"funds": []}
    detail = client.get(f"{URL}/funds/{stock}/navs", headers=headers).json()["detail"]
    assert detail == "Fund not found."


@pytest.mark.parametrize("nav", ["0", "0.0000", "1.23456", "-1", "abc", "1e3", "", 84.3793, 5])
def test_bad_nav_is_422(headers: Headers, nav: Any) -> None:
    fund = add_fund(headers).json()["id"]
    response = add_nav(headers, fund, "2026-11-01", nav)
    assert response.status_code == 422
    assert locs(response) == [["body", "nav"]]
    assert response.json()["detail"][0]["msg"] == NAV


def test_nav_upper_bound(headers: Headers) -> None:
    fund = add_fund(headers).json()["id"]
    assert add_nav(headers, fund, "2026-11-01", "10000000000").status_code == 422
    assert add_nav(headers, fund, "2026-11-01", "9999999999.9999").status_code == 201


def test_nav_date_rules(headers: Headers) -> None:
    fund = add_fund(headers).json()["id"]
    response = add_nav(headers, fund, "2026-11-10", "10")
    assert response.status_code == 422
    assert locs(response) == [["body", "date"]]
    assert response.json()["detail"][0]["msg"] == "The date can't be in the future."
    assert add_nav(headers, fund, "2026-11-09", "10").status_code == 201
    missing = client.post(f"{URL}/funds/{fund}/navs", json={"nav": "10"}, headers=headers)
    assert locs(missing) == [["body", "date"]]
    missing = client.post(f"{URL}/funds/{fund}/navs", json={"date": "2026-11-01"}, headers=headers)
    assert locs(missing) == [["body", "nav"]]
    assert missing.json()["detail"][0]["msg"] == NAV


def test_units_validator() -> None:
    class M(BaseModel):
        u: Units

    assert str(M(u="35.552").u) == "35.552"
    assert M(u="999999999999999.999")
    for bad in ("0", "35.5521", 35.552, "1000000000000000", "x", " "):
        with pytest.raises(ValidationError) as error:
            M(u=bad)
        assert UNITS in str(error.value)


def test_navs_newest_first_and_list_shows_four_decimals(headers: Headers) -> None:
    fund = add_fund(headers, "Zeta").json()["id"]
    add_fund(headers, "alpha")
    add_nav(headers, fund, "2026-10-01", "80.5")
    add_nav(headers, fund, "2026-11-05", "84.3793")
    add_nav(headers, fund, "2026-10-20", "82")
    navs = client.get(f"{URL}/funds/{fund}/navs", headers=headers).json()["navs"]
    assert [n["date"] for n in navs] == ["2026-11-05", "2026-10-20", "2026-10-01"]
    assert [n["nav"] for n in navs] == ["84.3793", "82.0000", "80.5000"]
    assert navs[0]["trade_id"] is None and set(navs[0]) == {"id", "date", "nav", "trade_id"}
    listed = client.get(f"{URL}/funds", headers=headers).json()["funds"]
    assert [f["name"] for f in listed] == ["alpha", "Zeta"]
    assert listed[0]["nav"] is None
    assert listed[1]["nav"] == "84.3793" and listed[1]["nav_date"] == "2026-11-05"


def test_nav_delete_is_fund_only(headers: Headers) -> None:
    fund = add_fund(headers).json()["id"]
    stock = add_stock(headers).json()["id"]
    nav = add_nav(headers, fund, "2026-11-01", "10").json()["id"]
    price = add_price(headers, stock, "2026-11-01", "100.00").json()["id"]
    assert client.delete(f"{URL}/navs/{price}", headers=headers).status_code == 404
    assert client.delete(f"{URL}/prices/{nav}", headers=headers).status_code == 404
    assert client.delete(f"{URL}/navs/0", headers=headers).status_code == 404
    assert client.delete(f"{URL}/navs/{nav}", headers=headers).json() == {"id": nav}
    assert client.delete(f"{URL}/prices/{price}", headers=headers).json() == {"id": price}


def test_delete_fund_refused_with_nav(headers: Headers) -> None:
    fund = add_fund(headers).json()["id"]
    nav = add_nav(headers, fund, "2026-11-01", "10").json()["id"]
    response = client.delete(f"{URL}/funds/{fund}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == IN_USE
    client.delete(f"{URL}/navs/{nav}", headers=headers)
    assert client.delete(f"{URL}/funds/{fund}", headers=headers).json() == {"id": fund}
    assert client.get(f"{URL}/funds", headers=headers).json() == {"funds": []}


def test_stock_routes_ignore_funds(headers: Headers) -> None:
    add_fund(headers)
    assert client.get(f"{URL}/stocks", headers=headers).json() == {"stocks": []}


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_blank_symbol_on_create_is_derived(headers: Headers, blank: str | None) -> None:
    response = add_fund(headers, symbol=blank)
    assert response.status_code == 201
    assert response.json()["symbol"] == "PPFCRG"


@pytest.mark.parametrize("blank", ["", "   ", None])
def test_blank_symbol_on_patch_keeps_current(headers: Headers, blank: str | None) -> None:
    fund = add_fund(headers, symbol="KEEP").json()["id"]
    response = client.patch(
        f"{URL}/funds/{fund}", json={"name": "Renamed", "symbol": blank}, headers=headers
    )
    assert response.status_code == 200
    assert response.json()["symbol"] == "KEEP" and response.json()["name"] == "Renamed"
