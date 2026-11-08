from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import app
from app.models.account import Account
from tests.test_accounts import Headers, auth
from tests.test_trades import broker, made, stock

client = TestClient(app)

URL = "/api/investments/portfolio"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def price(headers: Headers, stock_id: int, value: str, day: str = "2026-02-01") -> None:
    response = client.post(
        f"/api/investments/stocks/{stock_id}/prices",
        json={"date": day, "price": value},
        headers=headers,
    )
    assert response.status_code == 201, response.json()


def portfolio(headers: Headers) -> dict[str, Any]:
    response = client.get(URL, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()


def test_holding_figures(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=10, price="100.00")
    made(headers, stock_id=infy, account_id=account, quantity=10, price="100.00", charges="20.00")
    price(headers, infy, "130.00")
    body = portfolio(headers)
    assert body["holdings"] == [
        {
            "stock_id": infy,
            "symbol": "INFY",
            "name": "INFY",
            "account_id": account,
            "account_name": "Zerodha",
            "shares": 20,
            "invested": "2020.00",
            "average_cost": "101.00",
            "price": "130.00",
            "price_date": "2026-02-01",
            "value": "2600.00",
            "at_cost": False,
            "unrealised": "580.00",
            "unrealised_percent": "28.71",
        }
    ]
    assert body["totals"] == {
        "invested": "2020.00",
        "value": "2600.00",
        "unrealised": "580.00",
        "unrealised_percent": "28.71",
        "realised": "0.00",
    }


def test_spec_example(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=10, price="100.00")
    made(headers, stock_id=infy, account_id=account, quantity=10, price="100.00", charges="20.00")
    # 20 shares, invested 2020; use a price giving invested 1020 instead: sell 10
    made(headers, stock_id=infy, account_id=account, side="sell", quantity=10, price="100.00")
    price(headers, infy, "130.00")
    holding = portfolio(headers)["holdings"][0]
    assert holding["invested"] == "1020.00"
    assert holding["average_cost"] == "102.00"
    assert holding["value"] == "1300.00"
    assert holding["unrealised"] == "280.00"
    assert holding["unrealised_percent"] == "27.45"
    assert holding["at_cost"] is False


def test_no_price_is_at_cost(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=10, price="100.00")
    holding = portfolio(headers)["holdings"][0]
    assert holding["price"] is None
    assert holding["price_date"] is None
    assert holding["value"] == holding["invested"] == "1000.00"
    assert holding["unrealised"] == "0.00"
    assert holding["unrealised_percent"] == "0.00"
    assert holding["at_cost"] is True


def test_trade_price_is_not_a_recorded_price(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=5, price="777.00")
    body = portfolio(headers)
    assert body["holdings"][0]["at_cost"] is True
    assert body["by_stock"][0]["at_cost"] is True


def test_by_stock_combines_brokers(headers: Headers) -> None:
    one, two = broker(headers, name="Zerodha"), broker(headers, name="Groww")
    infy = stock(headers)
    made(headers, stock_id=infy, account_id=one, quantity=10, price="100.00")
    made(headers, stock_id=infy, account_id=two, quantity=5, price="130.00")
    price(headers, infy, "150.00")
    body = portfolio(headers)
    assert [h["account_name"] for h in body["holdings"]] == ["Groww", "Zerodha"]
    assert len(body["by_stock"]) == 1
    row = body["by_stock"][0]
    assert row["shares"] == 15
    assert row["invested"] == "1650.00"
    assert row["average_cost"] == "110.00"
    assert row["value"] == "2250.00"
    assert row["unrealised"] == "600.00"
    assert row["unrealised_percent"] == "36.36"
    assert "account_id" not in row and "account_name" not in row


def test_closed_positions(headers: Headers) -> None:
    account, infy, tcs = broker(headers), stock(headers), stock(headers, "TCS")
    made(headers, stock_id=infy, account_id=account, quantity=10, price="100.00")
    made(headers, stock_id=infy, account_id=account, side="sell", quantity=10, price="120.00")
    made(headers, stock_id=tcs, account_id=account, quantity=1, price="50.00")
    body = portfolio(headers)
    assert [h["symbol"] for h in body["holdings"]] == ["TCS"]
    assert [h["symbol"] for h in body["by_stock"]] == ["TCS"]
    assert body["closed"] == [
        {
            "stock_id": infy,
            "symbol": "INFY",
            "name": "INFY",
            "account_id": account,
            "account_name": "Zerodha",
            "realised": "200.00",
        }
    ]
    assert body["totals"]["realised"] == "200.00"
    assert body["totals"]["invested"] == "50.00"


def test_archived_closed_position_still_counts(headers: Headers, db_session: Session) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=10, price="100.00")
    made(headers, stock_id=infy, account_id=account, side="sell", quantity=10, price="110.00")
    db_session.get(Account, account).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
    db_session.commit()
    body = portfolio(headers)
    assert body["closed"][0]["account_name"] == "Zerodha"
    assert body["totals"]["realised"] == "100.00"


def test_empty_portfolio(headers: Headers) -> None:
    assert portfolio(headers) == {
        "holdings": [],
        "by_stock": [],
        "closed": [],
        "totals": {
            "invested": "0.00",
            "value": "0.00",
            "unrealised": "0.00",
            "unrealised_percent": "0.00",
            "realised": "0.00",
        },
    }
