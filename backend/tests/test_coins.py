from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.portfolio import fmt_coin, fmt_price
from app.api.routes import coins
from app.main import app
from app.models.investment import InstrumentPrice
from tests.test_accounts import Headers, auth, locs
from tests.test_funds import add_fund, add_nav
from tests.test_stocks import add_price, add_stock

client = TestClient(app)

URL = "/api/investments"
PRICE = "Enter a price above 0, with up to 4 decimals, like 7504827.5."
TICKER = "Enter the coin's ticker, like BTC."
IN_USE = "This coin has trades. Delete them first."


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(coins, "today_india", lambda: date(2026, 11, 9))
    return auth(db_session, monkeypatch)


def add_coin(headers: Headers, symbol: Any = "BTC", name: Any = "Bitcoin") -> Response:
    return client.post(f"{URL}/coins", json={"symbol": symbol, "name": name}, headers=headers)


def add_coin_price(headers: Headers, coin_id: int, day: Any, price: Any) -> Response:
    return client.post(
        f"{URL}/coins/{coin_id}/prices", json={"date": day, "price": price}, headers=headers
    )


def coin_list(headers: Headers) -> list[dict[str, Any]]:
    return client.get(f"{URL}/coins", headers=headers).json()["coins"]


def test_create_upper_cases_symbol(headers: Headers) -> None:
    response = add_coin(headers, "btc")
    assert response.status_code == 201
    assert response.json() == {
        "id": response.json()["id"],
        "symbol": "BTC",
        "name": "Bitcoin",
        "price": None,
        "price_date": None,
    }
    assert coin_list(headers) == [response.json()]


def test_list_sorted_by_name(headers: Headers) -> None:
    add_coin(headers, "ETH", "ethereum")
    add_coin(headers, "BTC", "Bitcoin")
    assert [c["symbol"] for c in coin_list(headers)] == ["BTC", "ETH"]


def test_duplicate_symbol(headers: Headers) -> None:
    add_coin(headers)
    response = add_coin(headers, "btc", "Other")
    assert response.status_code == 422
    assert locs(response) == [["body", "symbol"]]
    assert response.json()["detail"][0]["msg"] == "You already have BTC."


def test_same_symbol_as_stock_or_fund_allowed(headers: Headers) -> None:
    assert add_stock(headers, "BTC", "Stock").status_code == 201
    assert add_fund(headers, "Fund", symbol="BTC").status_code == 201
    assert add_coin(headers).status_code == 201


@pytest.mark.parametrize("symbol", [None, "", "  ", "BT-C", "B.C", "A" * 21, 5])
def test_bad_symbol(headers: Headers, symbol: Any) -> None:
    response = add_coin(headers, symbol)
    assert response.status_code == 422
    assert locs(response) == [["body", "symbol"]]
    assert response.json()["detail"][0]["msg"] == TICKER


def test_missing_symbol_field(headers: Headers) -> None:
    response = client.post(f"{URL}/coins", json={"name": "Bitcoin"}, headers=headers)
    assert locs(response) == [["body", "symbol"]]
    assert response.json()["detail"][0]["msg"] == TICKER


@pytest.mark.parametrize("name", [None, "", "   ", "x" * 61])
def test_bad_name(headers: Headers, name: Any) -> None:
    response = add_coin(headers, "BTC", name)
    assert response.status_code == 422
    assert locs(response) == [["body", "name"]]


def test_update(headers: Headers) -> None:
    coin = add_coin(headers).json()
    response = client.patch(
        f"{URL}/coins/{coin['id']}", json={"symbol": "xbt", "name": "Bit"}, headers=headers
    )
    assert response.status_code == 200
    assert (response.json()["symbol"], response.json()["name"]) == ("XBT", "Bit")
    other = add_coin(headers, "ETH", "Ether").json()
    clash = client.patch(f"{URL}/coins/{other['id']}", json={"symbol": "xbt"}, headers=headers)
    assert clash.status_code == 422
    assert locs(clash) == [["body", "symbol"]]
    same = client.patch(f"{URL}/coins/{other['id']}", json={"symbol": "eth"}, headers=headers)
    assert same.status_code == 200
    blank = client.patch(f"{URL}/coins/{other['id']}", json={"name": " "}, headers=headers)
    assert locs(blank) == [["body", "name"]]


def test_other_users_and_unknown_ids_are_404(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    coin = add_coin(headers).json()["id"]
    stranger = auth(db_session, monkeypatch, "other@example.com")
    for method, path in [
        ("patch", f"/coins/{coin}"),
        ("delete", f"/coins/{coin}"),
        ("get", f"/coins/{coin}/prices"),
        ("post", f"/coins/{coin}/prices"),
    ]:
        response = client.request(method, URL + path, json={}, headers=stranger)
        assert response.status_code == 404
        assert response.json()["detail"] == "Coin not found."
    assert client.get(f"{URL}/coins", headers=stranger).json() == {"coins": []}
    assert client.get(f"{URL}/coins/999999/prices", headers=headers).status_code == 404
    assert client.get(f"{URL}/coins/0/prices", headers=headers).status_code == 404


def test_stock_and_fund_ids_are_not_coins(headers: Headers) -> None:
    stock = add_stock(headers).json()["id"]
    fund = add_fund(headers).json()["id"]
    for other in (stock, fund):
        assert client.patch(f"{URL}/coins/{other}", json={}, headers=headers).status_code == 404
        assert client.delete(f"{URL}/coins/{other}", headers=headers).status_code == 404
        assert client.get(f"{URL}/coins/{other}/prices", headers=headers).status_code == 404
        assert add_coin_price(headers, other, "2026-11-01", "1").status_code == 404
    stock_price = add_price(headers, stock, "2026-11-01", "10").json()["id"]
    nav = add_nav(headers, fund, "2026-11-01", "10").json()["id"]
    for price_id in (stock_price, nav):
        response = client.delete(f"{URL}/coin-prices/{price_id}", headers=headers)
        assert response.status_code == 404


def test_coins_do_not_leak_into_stocks_and_funds(headers: Headers) -> None:
    coin = add_coin(headers).json()["id"]
    price = add_coin_price(headers, coin, "2026-11-01", "100").json()["id"]
    assert client.get(f"{URL}/stocks", headers=headers).json() == {"stocks": []}
    assert client.get(f"{URL}/funds", headers=headers).json() == {"funds": []}
    assert client.delete(f"{URL}/prices/{price}", headers=headers).status_code == 404
    assert client.delete(f"{URL}/navs/{price}", headers=headers).status_code == 404
    assert client.get(f"{URL}/coins/{coin}/prices", headers=headers).json()["prices"] != []


@pytest.mark.parametrize("price", ["0", "1.23456", "-1", "abc", "", 5, 1.5, "1e3", None])
def test_bad_price(headers: Headers, price: Any) -> None:
    coin = add_coin(headers).json()["id"]
    response = add_coin_price(headers, coin, "2026-11-01", price)
    assert response.status_code == 422
    assert locs(response) == [["body", "price"]]
    assert response.json()["detail"][0]["msg"] == PRICE


def test_future_and_missing_date(headers: Headers) -> None:
    coin = add_coin(headers).json()["id"]
    future = add_coin_price(headers, coin, "2026-11-10", "1")
    assert future.status_code == 422
    assert locs(future) == [["body", "date"]]
    assert future.json()["detail"][0]["msg"] == "The date can't be in the future."
    assert add_coin_price(headers, coin, "2026-11-09", "1").status_code == 201
    missing = add_coin_price(headers, coin, None, "1")
    assert locs(missing) == [["body", "date"]]


def test_prices_listed_newest_first_with_four_decimals(headers: Headers) -> None:
    coin = add_coin(headers).json()["id"]
    first = add_coin_price(headers, coin, "2026-11-01", "7504827.5")
    assert first.status_code == 201
    assert first.json() == {"id": first.json()["id"], "date": "2026-11-01", "price": "7504827.5000"}
    add_coin_price(headers, coin, "2026-11-05", "7600000")
    prices = client.get(f"{URL}/coins/{coin}/prices", headers=headers).json()["prices"]
    assert [(p["date"], p["price"]) for p in prices] == [
        ("2026-11-05", "7600000.0000"),
        ("2026-11-01", "7504827.5000"),
    ]
    assert coin_list(headers)[0]["price"] == "7600000.0000"
    assert coin_list(headers)[0]["price_date"] == "2026-11-05"


def test_delete_coin_deletes_its_prices(headers: Headers, db_session: Session) -> None:
    coin = add_coin(headers).json()["id"]
    other = add_coin(headers, "ETH", "Ether").json()["id"]
    add_coin_price(headers, coin, "2026-11-01", "5")
    add_coin_price(headers, coin, "2026-11-02", "6")
    kept = add_coin_price(headers, other, "2026-11-01", "7").json()["id"]
    assert client.delete(f"{URL}/coins/{coin}", headers=headers).json() == {"id": coin}
    assert [c["id"] for c in coin_list(headers)] == [other]
    remaining = db_session.scalars(select(InstrumentPrice.id)).all()
    assert remaining == [kept]
    assert client.delete(f"{URL}/coins/{coin}", headers=headers).status_code == 404


def test_fmt_coin_and_price() -> None:
    assert fmt_coin(Decimal("0.000000005")) == "0.00000001"
    assert fmt_coin(Decimal("0.00014067")) == "0.00014067"
    assert fmt_price(Decimal("7504827.5")) == "7504827.5000"


def test_delete_coin_with_a_trade_is_409(headers: Headers) -> None:
    from tests.test_crypto_trades import buy, exchange

    coin_id = add_coin(headers).json()["id"]
    assert buy(headers, coin_id=coin_id, account_id=exchange(headers)).status_code == 201
    assert client.get(f"{URL}/coins/{coin_id}/prices", headers=headers).json() == {"prices": []}
    response = client.delete(f"{URL}/coins/{coin_id}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == IN_USE
    # with a price too, the 409 leaves both in place
    add_coin_price(headers, coin_id, "2026-11-01", "5")
    assert client.delete(f"{URL}/coins/{coin_id}", headers=headers).status_code == 409
    assert len(client.get(f"{URL}/coins/{coin_id}/prices", headers=headers).json()["prices"]) == 1
