from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes import coins, crypto_trades, dashboard, fund_trades, funds, sips
from app.api.routes import portfolio as portfolio_route
from app.main import app
from app.models.account import Account
from tests.test_accounts import Headers, archive, auth
from tests.test_coins import add_coin_price
from tests.test_crypto_trades import coin, exchange
from tests.test_crypto_trades import existing as existing_coin
from tests.test_crypto_trades import made as made_coin
from tests.test_crypto_trades import sell as sell_coin
from tests.test_deposits import ppf, rd
from tests.test_fund_trades import add_nav, bank, fund, redeem
from tests.test_fund_trades import made as made_fund
from tests.test_sips import made as made_sip
from tests.test_trades import broker, made, stock

client = TestClient(app)

URL = "/api/investments/portfolio"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (funds, fund_trades, sips, coins, crypto_trades):
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
            "in_goal": None,
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
        "crypto": {"holdings": [], "by_coin": [], "closed": [], "totals": empty},
        "overall": empty,
        "deposits": {"value": "0.00", "interest_estimate": "0.00", "accounts": []},
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


# Deposits (PPF and RD) on the portfolio and the dashboard

TODAY = date(2026, 11, 9)


@pytest.fixture
def deposit_day(monkeypatch: pytest.MonkeyPatch) -> None:
    for module in (portfolio_route, dashboard):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)


def _both_deposits(headers: Headers) -> tuple[int, int]:
    pay = bank(headers)
    ppf_id = ppf(headers, balance="100000.00", name="PPF").json()["id"]
    rd_id = rd(
        headers, pay, balance="10000.00", opened_on="2026-09-01", deposits_paid=2, name="SBI RD"
    ).json()["id"]
    return ppf_id, rd_id


def test_deposits_in_the_portfolio(headers: Headers, deposit_day: None) -> None:
    ppf_id, rd_id = _both_deposits(headers)
    deposits = portfolio(headers)["deposits"]
    assert deposits == {
        "value": "110000.00",
        "interest_estimate": "4229.16",
        "accounts": [
            {
                "account_id": ppf_id,
                "name": "PPF",
                "type": "ppf",
                "balance": "100000.00",
                "maturity_date": "2036-04-01",
                "interest_estimate": "4142.00",
            },
            {
                "account_id": rd_id,
                "name": "SBI RD",
                "type": "rd",
                "balance": "10000.00",
                "maturity_date": "2028-09-01",
                "interest_estimate": "87.16",
            },
        ],
    }


def test_no_deposits_is_an_empty_object(headers: Headers, deposit_day: None) -> None:
    assert portfolio(headers)["deposits"] == {
        "value": "0.00",
        "interest_estimate": "0.00",
        "accounts": [],
    }


def _archive_directly(db_session: Session, account_id: int) -> None:
    # The API refuses to archive a deposit that still holds money, so set it on the row.
    db_session.get(Account, account_id).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
    db_session.commit()


def test_an_archived_deposit_is_left_out(
    headers: Headers, deposit_day: None, db_session: Session
) -> None:
    ppf_id, rd_id = _both_deposits(headers)
    _archive_directly(db_session, rd_id)
    deposits = portfolio(headers)["deposits"]
    assert [a["account_id"] for a in deposits["accounts"]] == [ppf_id]
    assert deposits["value"] == "100000.00"
    assert deposits["interest_estimate"] == "4142.00"
    assert portfolio(headers)["overall"]["value"] == "100000.00"


def test_overall_and_dashboard_count_deposits_at_their_balance(
    headers: Headers, deposit_day: None
) -> None:
    broker_id, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=broker_id, quantity=10, price="500.00")
    price(headers, infy, "600.00")
    before = portfolio(headers)
    _both_deposits(headers)
    after = portfolio(headers)
    for key in (*STOCK_KEYS, "funds"):
        assert after[key] == before[key]
    assert after["overall"] == {
        "invested": "115000.00",
        "value": "116000.00",
        "unrealised": "1000.00",
        "unrealised_percent": "0.87",
        "realised": "0.00",
    }
    dash = _dashboard(headers)
    assert dash["investments"] == {
        "value": "116000.00",
        "unrealised": "1000.00",
        "unrealised_percent": "0.87",
    }
    # Deposits were already in net worth as accounts, so they are not counted twice.
    assert dash["net_worth"] == dash["total_have"] == "171000.00"


def test_dashboard_with_only_a_ppf(headers: Headers, deposit_day: None) -> None:
    assert _dashboard(headers)["investments"] is None
    ppf(headers, balance="100000.00")
    assert _dashboard(headers)["investments"] == {
        "value": "100000.00",
        "unrealised": "0.00",
        "unrealised_percent": "0.00",
    }


def test_dashboard_without_active_deposits_or_holdings_is_null(
    headers: Headers, deposit_day: None, db_session: Session
) -> None:
    _archive_directly(db_session, ppf(headers).json()["id"])
    assert _dashboard(headers)["investments"] is None


def owner_coins(headers: Headers) -> tuple[int, int, int]:
    account, btc, eth = exchange(headers), coin(headers, "BTC"), coin(headers, "ETH")
    existing_coin(headers, coin_id=btc, account_id=account)
    existing_coin(headers, coin_id=eth, account_id=account, quantity="0.00485")
    add_coin_price(headers, btc, "2026-11-05", "7504827.5")
    add_coin_price(headers, eth, "2026-11-05", "213349.1")
    return account, btc, eth


def test_crypto_figures(headers: Headers) -> None:
    account, btc, eth = owner_coins(headers)
    body = portfolio(headers)["crypto"]
    assert body["by_coin"] == [
        {
            "coin_id": btc,
            "symbol": "BTC",
            "name": "BTC",
            "quantity": "0.00014067",
            "invested": "994.11",
            "average_price": "7066965.2378",
            "price": "7504827.5000",
            "price_date": "2026-11-05",
            "value": "1055.70",
            "at_cost": False,
            "unrealised": "61.59",
            "unrealised_percent": "6.20",
        },
        {
            "coin_id": eth,
            "symbol": "ETH",
            "name": "ETH",
            "quantity": "0.00485000",
            "invested": "994.11",
            "average_price": "204971.1340",
            "price": "213349.1000",
            "price_date": "2026-11-05",
            "value": "1034.74",
            "at_cost": False,
            "unrealised": "40.63",
            "unrealised_percent": "4.09",
        },
    ]
    assert [(h["account_id"], h["account_name"]) for h in body["holdings"]] == [
        (account, "CoinDCX")
    ] * 2
    assert body["closed"] == []
    assert body["totals"] == {
        "invested": "1988.22",
        "value": "2090.44",
        "unrealised": "102.22",
        "unrealised_percent": "5.14",
        "realised": "0.00",
    }


def test_coin_without_price_is_at_cost(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    existing_coin(headers, coin_id=btc, account_id=account)
    row = portfolio(headers)["crypto"]["by_coin"][0]
    assert (row["price"], row["price_date"], row["at_cost"]) == (None, None, True)
    assert (row["value"], row["unrealised"]) == ("994.11", "0.00")


def test_closed_coin_position(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    made_coin(headers, coin_id=btc, account_id=account)
    assert sell_coin(headers, coin_id=btc, account_id=account).status_code == 201
    body = portfolio(headers)["crypto"]
    assert body["holdings"] == [] and body["by_coin"] == []
    assert [(c["symbol"], c["account_id"]) for c in body["closed"]] == [("BTC", account)]


def test_overall_adds_crypto(headers: Headers) -> None:
    broker_id, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=broker_id, quantity=10, price="500.00")
    price(headers, infy, "600.00")
    stock_only = portfolio(headers)
    owner_coins(headers)
    both = portfolio(headers)
    for key in (*STOCK_KEYS, "funds"):
        assert both[key] == stock_only[key]
    assert both["overall"] == {
        "invested": "6988.22",
        "value": "8090.44",
        "unrealised": "1102.22",
        "unrealised_percent": "15.77",
        "realised": "0.00",
    }


def test_buying_crypto_keeps_net_worth(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    made_coin(headers, coin_id=btc, account_id=account)
    dash = _dashboard(headers)
    assert dash["net_worth"] == "5000.00"
    assert dash["investments"]["value"] == "754.43"
    assert dash["investments"]["unrealised"] == "0.00"


def test_archive_broker_with_coins_is_409(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    made_coin(headers, coin_id=btc, account_id=account)
    url = f"/api/accounts/{account}/archive"
    response = client.post(url, headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "Sell the coins held in CoinDCX before archiving it."
    assert sell_coin(headers, coin_id=btc, account_id=account).status_code == 201
    assert client.post(url, headers=headers).status_code == 200


def test_holdings_in_a_goal_are_tagged(headers: Headers) -> None:
    """Stock, fund and coin rows name the active goal an instrument is in, else null."""
    zerodha, infy, tcs = broker(headers), stock(headers), stock(headers, "TCS")
    made(headers, stock_id=infy, account_id=zerodha, quantity=1, price="100.00")
    made(headers, stock_id=tcs, account_id=zerodha, quantity=1, price="100.00")
    sbi, ppfcf = bank(headers), fund(headers)
    opening(headers, ppfcf, sbi, "10.000", "1000.00")
    coindcx, btc = owner_coins(headers)[:2]
    bike = client.post(
        "/api/goals",
        json={"name": "Bike", "kind": "custom", "target_amount": "120000.00"},
        headers=headers,
    ).json()["id"]
    for target in ({"instrument_id": infy}, {"instrument_id": ppfcf}, {"instrument_id": btc}):
        added = client.post(f"/api/goals/{bike}/holdings", json=target, headers=headers)
        assert added.status_code == 201, added.json()

    body = portfolio(headers)
    tag = {"id": bike, "name": "Bike"}
    assert {h["symbol"]: h["in_goal"] for h in body["holdings"]} == {"INFY": tag, "TCS": None}
    assert [h["in_goal"] for h in body["funds"]["holdings"]] == [tag]
    assert {h["symbol"]: h["in_goal"] for h in body["crypto"]["holdings"]} == {
        "BTC": tag,
        "ETH": None,
    }

    # An archived goal frees its holdings, so the tag goes.
    client.post(f"/api/goals/{bike}/archive", headers=headers)
    assert [h["in_goal"] for h in portfolio(headers)["funds"]["holdings"]] == [None]
