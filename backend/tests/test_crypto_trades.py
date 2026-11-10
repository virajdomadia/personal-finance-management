from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.api.routes import coins, crypto_trades
from app.main import app
from app.models.account import Account
from tests.test_accounts import Headers, auth, locs, make
from tests.test_coins import add_coin
from tests.test_fund_trades import fund
from tests.test_stocks import add_stock
from tests.test_trades import trade as stock_trade

client = TestClient(app)

URL = "/api/investments/crypto-trades"
TODAY = date(2026, 11, 9)
DAY = "2026-11-05"
MISMATCH = "Quantity × price doesn't match the amount. Check the quantity and price."
QTY = "Enter a quantity above 0, with up to 8 decimals, like 0.00014067."
PRICE = "Enter a price above 0, with up to 4 decimals, like 7504827.5."


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (coins, crypto_trades):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def exchange(headers: Headers, name: str = "CoinDCX", balance: str = "5000.00") -> int:
    response = make(headers, type="broker", name=name, balance=balance)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def coin(headers: Headers, symbol: str = "BTC") -> int:
    response = add_coin(headers, symbol, symbol)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def balance(headers: Headers, account_id: int) -> str:
    rows = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a["balance"] for a in rows if a["id"] == account_id)


def buy(headers: Headers, **fields: Any) -> Response:
    body = {
        "side": "buy",
        "date": DAY,
        "quantity": "0.0001",
        "price": "7500000",
        "charges": "4.43",
        "amount": "754.43",
        **fields,
    }
    return client.post(URL, json=body, headers=headers)


def made(headers: Headers, **fields: Any) -> dict[str, Any]:
    response = buy(headers, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def existing(headers: Headers, **fields: Any) -> dict[str, Any]:
    body = {
        "opening": True,
        "quantity": "0.00014067",
        "price": None,
        "charges": None,
        "amount": "994.11",
        **fields,
    }
    return made(headers, **body)


def sell(headers: Headers, **fields: Any) -> Response:
    body = {"side": "sell", "quantity": "0.0001", "charges": "15.00", "amount": "735.00"}
    return buy(headers, **{**body, **fields})


def patch(headers: Headers, id_: int, **fields: Any) -> Response:
    return client.patch(f"{URL}/{id_}", json=fields, headers=headers)


def delete(headers: Headers, id_: int) -> Response:
    return client.delete(f"{URL}/{id_}", headers=headers)


def trades(headers: Headers, **params: Any) -> list[dict[str, Any]]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()["trades"]


def error(response: Response) -> tuple[list[list[str]], str]:
    return locs(response), response.json()["detail"][0]["msg"]


def test_existing_coins_leave_the_balance_alone(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    body = existing(headers, coin_id=btc, account_id=account)
    assert balance(headers, account) == "5000.00"
    assert body["price"] == "7066965.2378"
    assert body["quantity"] == "0.00014067"
    assert body["opening"] is True
    assert body["symbol"] == "BTC"
    assert body["account_name"] == "CoinDCX"
    assert body["realised"] is None
    assert trades(headers) == [body]


def test_buy_debits_the_exchange(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    body = made(headers, coin_id=btc, account_id=account)
    assert balance(headers, account) == "4245.57"
    assert body["amount"] == "754.43"
    assert body["charges"] == "4.43"
    assert body["price"] == "7500000.0000"
    assert body["quantity"] == "0.00010000"


def test_quantity_price_check(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    response = buy(headers, coin_id=btc, account_id=account, quantity="0.001")
    assert response.status_code == 422
    assert error(response) == ([["body", "quantity"]], MISMATCH)
    made(headers, coin_id=btc, account_id=account)
    # 750.00 = 735.00 amount + 7.50 charges + 7.50 TDS
    response = sell(headers, coin_id=btc, account_id=account)
    assert response.status_code == 201, response.json()
    assert balance(headers, account) == "4980.57"
    response = sell(headers, coin_id=btc, account_id=account, quantity="0.00001")
    assert error(response) == ([["body", "quantity"]], MISMATCH)


def test_quantity_price_tolerance(headers: Headers) -> None:
    account, btc = exchange(headers, balance="50000.00"), coin(headers)
    # Within ₹1.00 passes; just over fails.
    assert buy(headers, coin_id=btc, account_id=account, amount="755.43").status_code == 201
    response = buy(headers, coin_id=btc, account_id=account, amount="755.44")
    assert error(response) == ([["body", "quantity"]], MISMATCH)
    # 1 crore coins allow quantity × ₹0.00005 = ₹500.00: 12000.00 vs 12345.60 is 345.60 off.
    low = {"coin_id": btc, "account_id": account, "quantity": "10000000", "charges": "0"}
    response = buy(headers, **low, price="0.0012", amount="12345.60")
    assert response.status_code == 201, response.json()
    # 10000.00 vs 12345.60 is 2345.60 off.
    response = buy(headers, **low, price="0.0010", amount="12345.60")
    assert response.status_code == 422
    assert error(response) == ([["body", "quantity"]], MISMATCH)
    # Exactly ₹500.00 off passes; a paisa more fails.
    assert buy(headers, **low, price="0.0012", amount="12500.00").status_code == 201
    response = buy(headers, **low, price="0.0012", amount="12500.01")
    assert error(response) == ([["body", "quantity"]], MISMATCH)


def test_partial_sell_realises(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    existing(headers, coin_id=btc, account_id=account)
    response = sell(
        headers,
        coin_id=btc,
        account_id=account,
        quantity="0.00005",
        charges="0.00",
        amount="375.00",
    )
    assert response.status_code == 201, response.json()
    assert response.json()["realised"] == "21.65"  # 375.00 - 353.35
    assert trades(headers)[0]["realised"] == "21.65"


@pytest.mark.parametrize(
    ("fields", "loc", "message"),
    [
        ({"coin_id": None}, "coin_id", "Choose a coin."),
        ({"coin_id": "7"}, "coin_id", "Choose a coin."),
        ({"coin_id": "fund"}, "coin_id", "Choose a coin."),
        ({"coin_id": 99999}, "coin_id", "Choose a coin."),
        ({"account_id": None}, "account_id", "Choose a broker or exchange account."),
        ({"account_id": "bank"}, "account_id", "Choose a broker or exchange account."),
        ({"account_id": "archived"}, "account_id", "Old DCX is archived. Restore it to use it."),
        ({"side": None}, "side", "Choose buy or sell."),
        ({"side": "hold"}, "side", "Choose buy or sell."),
        ({"quantity": None}, "quantity", QTY),
        ({"quantity": "0"}, "quantity", QTY),
        ({"quantity": "0.000000001"}, "quantity", QTY),
        ({"price": None}, "price", PRICE),
        ({"price": "0"}, "price", PRICE),
        ({"amount": None}, "amount", "Enter the amount."),
        ({"amount": "0"}, "amount", "Amount must be greater than 0."),
        ({"charges": "-1"}, "charges", "Charges can't be negative."),
        ({"charges": "754.43"}, "charges", "Charges can't be more than the amount."),
        ({"date": None}, "date", "Choose a date."),
        ({"date": "2026-11-10"}, "date", "The date can't be in the future."),
        ({"opening": True, "side": "sell"}, "opening", "Only a buy can be existing coins."),
        (
            {
                "opening": True,
                "price": None,
                "charges": None,
                "quantity": "100000000",
                "amount": "0.01",
            },
            "amount",
            "That's too little for that many coins.",
        ),
        (
            {
                "opening": True,
                "price": None,
                "charges": None,
                "quantity": "0.00000001",
                "amount": "1000000",
            },
            "quantity",
            "That's too few coins for that amount.",
        ),
        (
            {"quantity": "1000000", "price": "9999999999", "amount": "1000000"},
            "price",
            "This trade is too large.",
        ),
    ],
)
def test_field_rules(
    headers: Headers, db_session: Session, fields: dict[str, Any], loc: str, message: str
) -> None:
    account, btc = exchange(headers), coin(headers)
    made(headers, coin_id=btc, account_id=account)
    resolved = {"coin_id": btc, "account_id": account, **fields}
    if resolved["coin_id"] == "fund":
        resolved["coin_id"] = fund(headers)
    if resolved["account_id"] == "bank":
        bank = make(headers, type="bank", name="SBI", bank_kind="savings", balance="1000.00")
        resolved["account_id"] = bank.json()["id"]
    if resolved["account_id"] == "archived":
        old = exchange(headers, name="Old DCX")
        db_session.get(Account, old).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
        db_session.commit()
        resolved["account_id"] = old
    if resolved.get("side") == "sell" and not resolved.get("opening"):
        resolved.update(quantity="0.0001", amount="735.00", charges="15.00")
    response = buy(headers, **resolved)
    assert response.status_code == 422, response.json()
    assert error(response) == ([["body", loc]], message)
    assert len(trades(headers)) == 1


def test_kinds_stay_apart(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    crypto = made(headers, coin_id=btc, account_id=account)
    infy = add_stock(headers, "INFY", "Infosys").json()["id"]
    stock = stock_trade(headers, stock_id=infy, account_id=account, date=DAY)
    assert stock.status_code == 201, stock.json()
    stock_id = stock.json()["id"]
    assert [t["id"] for t in trades(headers)] == [crypto["id"]]
    assert patch(headers, stock_id, note="x").status_code == 404
    assert delete(headers, stock_id).status_code == 404
    # A crypto trade id is not found on the stock trade route.
    path = f"/api/investments/trades/{crypto['id']}"
    assert client.patch(path, json={"note": "x"}, headers=headers).status_code == 404
    assert client.delete(path, headers=headers).status_code == 404


def test_sell_more_than_held_is_422(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    made(headers, coin_id=btc, account_id=account)
    response = sell(headers, coin_id=btc, account_id=account, quantity="0.00011", amount="810.00")
    assert response.status_code == 422, response.json()
    assert error(response) == (
        [["body", "quantity"]],
        "You'd be selling more BTC than you held on 5 Nov 2026.",
    )
    response = sell(headers, coin_id=btc, account_id=account, date="2026-11-04")
    assert error(response)[1] == "You'd be selling more BTC than you held on 4 Nov 2026."
    assert sell(headers, coin_id=btc, account_id=account).status_code == 201


def test_edit_leaving_a_later_sale_short_is_409(headers: Headers) -> None:
    account, other_account, btc = exchange(headers), exchange(headers, "WazirX"), coin(headers)
    purchase = made(headers, coin_id=btc, account_id=account)
    response = sell(headers, coin_id=btc, account_id=account, date="2026-11-07")
    assert response.status_code == 201, response.json()
    short = "This would leave the sale of BTC on 7 Nov 2026 selling more than was held."
    for change in [
        {"date": "2026-11-08"},
        {"account_id": other_account},
        {"quantity": "0.00005", "amount": "379.43"},
        {"coin_id": coin(headers, "ETH")},
    ]:
        response = patch(headers, purchase["id"], **change)
        assert response.status_code == 409, (change, response.json())
        assert response.json()["detail"] == short
    response = delete(headers, purchase["id"])
    assert response.status_code == 409
    assert response.json()["detail"] == short
    assert next(t for t in trades(headers) if t["id"] == purchase["id"]) == purchase


def test_no_price_is_recorded(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    first = made(headers, coin_id=btc, account_id=account)
    existing(headers, coin_id=btc, account_id=account)
    assert patch(headers, first["id"], note="hello").status_code == 200
    prices = client.get(f"/api/investments/coins/{btc}/prices", headers=headers)
    assert prices.json() == {"prices": []}


def test_patch_and_delete(headers: Headers) -> None:
    account, btc = exchange(headers), coin(headers)
    body = made(headers, coin_id=btc, account_id=account)
    for field, value in [("side", "sell"), ("opening", True)]:
        assert patch(headers, body["id"], **{field: value}).status_code == 422
    response = patch(headers, body["id"], note="n", charges="5.43", amount="755.43")
    assert response.status_code == 200, response.json()
    assert response.json()["note"] == "n"
    assert balance(headers, account) == "4244.57"
    assert trades(headers, coin_id=btc) == [response.json()]
    assert trades(headers, account_id=account + 1000) == []
    assert delete(headers, body["id"]).json() == {"id": body["id"]}
    assert balance(headers, account) == "5000.00"
    assert delete(headers, body["id"]).status_code == 404
    assert patch(headers, body["id"], note="x").status_code == 404
