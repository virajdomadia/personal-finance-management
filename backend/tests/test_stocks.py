from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.main import app
from app.models.stock import Stock, StockTrade
from tests.test_accounts import Headers, auth, locs, make

client = TestClient(app)

URL = "/api/investments"
BAD_SYMBOL = "Use 1 to 20 letters, digits, &, - or ."


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def add_stock(headers: Headers, symbol: str = "INFY", name: str = "Infosys") -> Response:
    return client.post(f"{URL}/stocks", json={"symbol": symbol, "name": name}, headers=headers)


def add_price(headers: Headers, stock_id: int, day: str, price: str) -> Response:
    return client.post(
        f"{URL}/stocks/{stock_id}/prices", json={"date": day, "price": price}, headers=headers
    )


def stocks(headers: Headers) -> list[dict[str, Any]]:
    return client.get(f"{URL}/stocks", headers=headers).json()["stocks"]


def test_create_stock_uppercases_and_trims_symbol(headers: Headers) -> None:
    response = add_stock(headers, " infy ")
    assert response.status_code == 201
    body = response.json()
    assert body["symbol"] == "INFY"
    assert body["name"] == "Infosys"
    assert body["price"] is None and body["price_date"] is None


@pytest.mark.parametrize("symbol", ["", "A" * 21, "IN FY", "INFY$"])
def test_bad_symbol_is_422(headers: Headers, symbol: str) -> None:
    response = add_stock(headers, symbol)
    assert response.status_code == 422
    assert locs(response) == [["body", "symbol"]]
    assert response.json()["detail"][0]["msg"] == BAD_SYMBOL


def test_symbol_allows_punctuation(headers: Headers) -> None:
    assert add_stock(headers, "m&m-x.1").json()["symbol"] == "M&M-X.1"


def test_duplicate_symbol_is_422(headers: Headers) -> None:
    add_stock(headers, "INFY")
    response = add_stock(headers, "infy")
    assert response.status_code == 422
    assert locs(response) == [["body", "symbol"]]
    assert response.json()["detail"][0]["msg"] == "You already have INFY."
    other = add_stock(headers, "TCS", "TCS").json()["id"]
    response = client.patch(f"{URL}/stocks/{other}", json={"symbol": "infy"}, headers=headers)
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "You already have INFY."
    # Keeping its own symbol (even in another case) is not a duplicate.
    response = client.patch(f"{URL}/stocks/{other}", json={"symbol": "tcs"}, headers=headers)
    assert response.status_code == 200


def test_patch_name_and_symbol(headers: Headers) -> None:
    id = add_stock(headers).json()["id"]
    response = client.patch(
        f"{URL}/stocks/{id}", json={"symbol": "wipro", "name": " Wipro Ltd "}, headers=headers
    )
    assert response.json()["symbol"] == "WIPRO"
    assert response.json()["name"] == "Wipro Ltd"


@pytest.mark.parametrize("name", ["", "   "])
def test_name_required(headers: Headers, name: str) -> None:
    response = add_stock(headers, "INFY", name)
    assert response.status_code == 422
    assert locs(response) == [["body", "name"]]


def test_stocks_sorted_by_symbol(headers: Headers) -> None:
    add_stock(headers, "TCS", "TCS")
    add_stock(headers, "INFY")
    assert [s["symbol"] for s in stocks(headers)] == ["INFY", "TCS"]


def test_stocks_are_per_user(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    mine = auth(db_session, monkeypatch)
    other = auth(db_session, monkeypatch, "other@example.com")
    id = add_stock(mine).json()["id"]
    assert add_stock(other).status_code == 201
    assert client.get(f"{URL}/stocks/{id}/prices", headers=other).status_code == 404
    assert add_price(other, id, "2026-01-10", "10").status_code == 404
    assert client.patch(f"{URL}/stocks/{id}", json={"name": "x"}, headers=other).status_code == 404
    assert client.delete(f"{URL}/stocks/{id}", headers=other).status_code == 404
    assert len(stocks(mine)) == 1


def test_huge_id_is_404(headers: Headers) -> None:
    assert client.get(f"{URL}/stocks/99999999999/prices", headers=headers).status_code == 404


def test_record_and_list_prices(headers: Headers) -> None:
    id = add_stock(headers).json()["id"]
    assert add_price(headers, id, "2026-01-15", "1500.5").status_code == 201
    assert add_price(headers, id, "2026-01-10", "1400").status_code == 201
    prices = client.get(f"{URL}/stocks/{id}/prices", headers=headers).json()["prices"]
    assert [(p["date"], p["price"]) for p in prices] == [
        ("2026-01-15", "1500.50"),
        ("2026-01-10", "1400.00"),
    ]
    assert set(prices[0]) == {"id", "date", "price"}
    assert stocks(headers)[0]["price"] == "1500.50"
    assert stocks(headers)[0]["price_date"] == "2026-01-15"


def test_same_day_prices_latest_recorded_wins(headers: Headers) -> None:
    id = add_stock(headers).json()["id"]
    add_price(headers, id, "2026-01-15", "100")
    add_price(headers, id, "2026-01-15", "110")
    assert stocks(headers)[0]["price"] == "110.00"
    assert add_price(headers, id, "2026-01-10", "50").status_code == 201
    assert stocks(headers)[0]["price"] == "110.00"


@pytest.mark.parametrize("price", ["0", "-1", "1.234"])
def test_price_rules(headers: Headers, price: str) -> None:
    id = add_stock(headers).json()["id"]
    response = add_price(headers, id, "2026-01-10", price)
    assert response.status_code == 422
    assert locs(response) == [["body", "price"]]


def test_price_required_and_future_date(headers: Headers) -> None:
    id = add_stock(headers).json()["id"]
    response = add_price(headers, id, "2999-01-01", "10")
    assert response.status_code == 422
    assert locs(response) == [["body", "date"]]
    assert response.json()["detail"][0]["msg"] == "The date can't be in the future."
    response = client.post(f"{URL}/stocks/{id}/prices", json={}, headers=headers)
    assert response.status_code == 422
    assert sorted(locs(response)) == [["body", "date"], ["body", "price"]]


def test_delete_price(headers: Headers) -> None:
    id = add_stock(headers).json()["id"]
    add_price(headers, id, "2026-01-10", "10")
    second = add_price(headers, id, "2026-01-15", "20").json()["id"]
    assert client.delete(f"{URL}/prices/{second}", headers=headers).json() == {"id": second}
    assert stocks(headers)[0]["price"] == "10.00"
    assert client.delete(f"{URL}/prices/{second}", headers=headers).status_code == 404
    assert client.delete(f"{URL}/prices/99999999999", headers=headers).status_code == 404


def test_delete_price_of_another_user_is_404(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    mine = auth(db_session, monkeypatch)
    other = auth(db_session, monkeypatch, "other@example.com")
    id = add_stock(mine).json()["id"]
    price = add_price(mine, id, "2026-01-10", "10").json()["id"]
    assert client.delete(f"{URL}/prices/{price}", headers=other).status_code == 404


def test_delete_stock_with_prices_is_409(headers: Headers) -> None:
    id = add_stock(headers).json()["id"]
    add_price(headers, id, "2026-01-10", "10")
    response = client.delete(f"{URL}/stocks/{id}", headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "This stock has trades or prices. Delete them first."
    empty = add_stock(headers, "TCS", "TCS").json()["id"]
    assert client.delete(f"{URL}/stocks/{empty}", headers=headers).json() == {"id": empty}
    assert [s["symbol"] for s in stocks(headers)] == ["INFY"]


def test_delete_stock_with_trades_is_409(headers: Headers, db_session: Session) -> None:
    id = add_stock(headers).json()["id"]
    stock = db_session.get(Stock, id)
    assert stock is not None
    account = make(headers, type="broker", name="Zerodha").json()["id"]
    db_session.add(
        StockTrade(
            user_id=stock.user_id,
            stock_id=id,
            account_id=account,
            side="buy",
            date=date(2026, 1, 1),
            quantity=1,
            price=Decimal(1),
            charges=Decimal(0),
        )
    )
    db_session.commit()
    assert client.delete(f"{URL}/stocks/{id}", headers=headers).status_code == 409


def test_requires_login() -> None:
    assert client.get(f"{URL}/stocks").status_code == 401
