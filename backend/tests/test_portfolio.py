from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes import fund_trades, funds, sips
from app.main import app
from app.models.account import Account
from tests.test_accounts import Headers, archive, auth
from tests.test_fund_trades import add_nav, bank, fund, redeem
from tests.test_fund_trades import made as made_fund
from tests.test_sips import made as made_sip
from tests.test_trades import broker, made, stock

client = TestClient(app)

URL = "/api/investments/portfolio"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (funds, fund_trades, sips):
        monkeypatch.setattr(module, "today_india", lambda: date(2026, 11, 9))
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
    empty = {
        "invested": "0.00",
        "value": "0.00",
        "unrealised": "0.00",
        "unrealised_percent": "0.00",
        "realised": "0.00",
    }
    assert portfolio(headers) == {
        "funds": {"holdings": [], "by_fund": [], "closed": [], "totals": empty, "due_sips": []},
        "overall": empty,
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


def _dashboard(headers: Headers) -> dict[str, Any]:
    return client.get("/api/dashboard", headers=headers).json()


def _accounts(headers: Headers) -> dict[str, Any]:
    return client.get("/api/accounts", headers=headers).json()


def test_net_worth_counts_investments_at_current_value(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=10, price="500.00")
    price(headers, infy, "600.00")
    assert _accounts(headers)["total_have"] == "11000.00"
    dash = _dashboard(headers)
    assert dash["net_worth"] == "11000.00"
    assert dash["total_have"] == "11000.00"
    assert dash["investments"] == {
        "value": "6000.00",
        "unrealised": "1000.00",
        "unrealised_percent": "20.00",
    }


def test_buying_keeps_net_worth(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=10, price="500.00")
    assert _dashboard(headers)["net_worth"] == "10000.00"
    assert _accounts(headers)["total_have"] == "10000.00"


def test_dashboard_investments_null_without_holdings(headers: Headers) -> None:
    broker(headers)
    assert _dashboard(headers)["investments"] is None


def test_archive_broker_with_holdings_is_409(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=10, price="500.00")
    url = f"/api/accounts/{account}/archive"
    response = client.post(url, headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "Sell the shares held in Zerodha before archiving it."
    made(headers, stock_id=infy, account_id=account, side="sell", quantity=10, price="500.00")
    assert client.post(url, headers=headers).status_code == 200


STOCK_KEYS = ("holdings", "by_stock", "closed", "totals")


def opening(headers: Headers, fund_id: int, account_id: int, units: str, amount: str) -> None:
    made_fund(
        headers, fund_id=fund_id, account_id=account_id, opening=True, units=units, amount=amount
    )


def test_fund_figures(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    opening(headers, ppfcf, account, "253.462", "21000.00")
    add_nav(headers, ppfcf, "2026-11-05", "84.3793")
    body = portfolio(headers)["funds"]
    assert body["by_fund"] == [
        {
            "fund_id": ppfcf,
            "symbol": "PPFCF",
            "name": "Parag Parikh Flexi Cap",
            "units": "253.462",
            "invested": "21000.00",
            "average_nav": "82.8527",
            "nav": "84.3793",
            "nav_date": "2026-11-05",
            "value": "21386.95",
            "at_cost": False,
            "unrealised": "386.95",
            "unrealised_percent": "1.84",
        }
    ]
    holding = body["holdings"][0]
    assert holding["account_id"] == account
    assert holding["account_name"] == "SBI"
    assert holding["units"] == "253.462"
    assert body["totals"]["value"] == "21386.95"


def test_opening_only_fund_is_at_cost(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    opening(headers, ppfcf, account, "253.462", "21000.00")
    row = portfolio(headers)["funds"]["by_fund"][0]
    assert row["at_cost"] is True
    assert row["nav"] is None
    assert row["nav_date"] is None
    assert row["value"] == "21000.00"
    assert row["unrealised"] == "0.00"
    assert row["unrealised_percent"] == "0.00"


def test_closed_fund_position(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    opening(headers, ppfcf, account, "10", "800.00")
    assert redeem(headers, fund_id=ppfcf, account_id=account).status_code == 201
    body = portfolio(headers)["funds"]
    assert body["holdings"] == []
    assert body["closed"] == [
        {
            "fund_id": ppfcf,
            "symbol": "PPFCF",
            "name": "Parag Parikh Flexi Cap",
            "account_id": account,
            "account_name": "SBI",
            "realised": "60.00",
        }
    ]
    assert body["totals"]["realised"] == "60.00"


def test_overall_adds_stocks_and_funds(headers: Headers) -> None:
    broker_id, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=broker_id, quantity=10, price="500.00")
    price(headers, infy, "600.00")
    stock_only = portfolio(headers)
    account, ppfcf = bank(headers), fund(headers)
    opening(headers, ppfcf, account, "253.462", "21000.00")
    add_nav(headers, ppfcf, "2026-11-05", "84.3793")
    both = portfolio(headers)
    for key in STOCK_KEYS:
        assert both[key] == stock_only[key]
    assert both["overall"] == {
        "invested": "26000.00",
        "value": "27386.95",
        "unrealised": "1386.95",
        "unrealised_percent": "5.33",
        "realised": "0.00",
    }
    assert both["funds"]["totals"]["invested"] == "21000.00"


def test_due_sips_in_portfolio(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    plan = made_sip(headers, ppfcf, account)
    assert portfolio(headers)["funds"]["due_sips"] == [plan]


def test_buying_a_fund_keeps_net_worth(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    made_fund(headers, fund_id=ppfcf, account_id=account)
    dash = _dashboard(headers)
    assert dash["net_worth"] == "49999.85"
    assert dash["total_have"] == "49999.85"
    assert dash["investments"]["value"] == "2999.85"
    assert dash["investments"]["unrealised"] == "-0.15"


def test_dashboard_counts_stocks_and_funds(headers: Headers) -> None:
    broker_id, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=broker_id, quantity=10, price="500.00")
    account, ppfcf = bank(headers), fund(headers)
    opening(headers, ppfcf, account, "10", "800.00")
    assert _dashboard(headers)["investments"] == {
        "value": "5800.00",
        "unrealised": "0.00",
        "unrealised_percent": "0.00",
    }


def test_dashboard_investments_with_only_a_fund(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    assert _dashboard(headers)["investments"] is None
    opening(headers, ppfcf, account, "10", "800.00")
    assert _dashboard(headers)["investments"]["value"] == "800.00"


def test_archive_bank_with_units_is_409(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    opening(headers, ppfcf, account, "10", "800.00")
    response = archive(headers, account)
    assert response.status_code == 409
    assert response.json()["detail"] == "Redeem the fund units held in SBI before archiving it."
    assert redeem(headers, fund_id=ppfcf, account_id=account).status_code == 201
    assert archive(headers, account).status_code == 200


def test_archive_bank_with_active_sip_is_409(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    plan = made_sip(headers, ppfcf, account)
    response = archive(headers, account)
    assert response.status_code == 409
    assert response.json()["detail"] == "Stop the SIPs paid from SBI before archiving it."
    stopped = client.patch(
        f"/api/investments/sips/{plan['id']}",
        json={"account_id": account, "amount": "3000.00", "day": 5, "active": False},
        headers=headers,
    )
    assert stopped.status_code == 200, stopped.json()
    assert archive(headers, account).status_code == 200


def test_archive_plain_bank_still_works(headers: Headers) -> None:
    assert archive(headers, bank(headers)).status_code == 200
