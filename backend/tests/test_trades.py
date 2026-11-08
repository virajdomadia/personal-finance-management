from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy.orm import Session

from app.api.routes.dashboard import today_india
from app.main import app
from app.models.account import Account
from tests.test_accounts import Headers, auth, locs, make

client = TestClient(app)

URL = "/api/investments/trades"
DAY = "2026-01-15"
QUANTITY_RULE = "Enter a whole number of shares, from 1 to 10,00,00,000."


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def broker(headers: Headers, balance: str = "10000.00", name: str = "Zerodha") -> int:
    response = make(headers, type="broker", name=name, balance=balance)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def bank(headers: Headers, balance: str = "50000.00") -> int:
    response = make(headers, type="bank", name="SBI", bank_kind="savings", balance=balance)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def stock(headers: Headers, symbol: str = "INFY") -> int:
    response = client.post(
        "/api/investments/stocks", json={"symbol": symbol, "name": symbol}, headers=headers
    )
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def trade(headers: Headers, **fields: Any) -> Response:
    body = {"side": "buy", "date": DAY, "quantity": 10, "price": "500.00", **fields}
    return client.post(URL, json=body, headers=headers)


def made(headers: Headers, **fields: Any) -> dict[str, Any]:
    response = trade(headers, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def patch(headers: Headers, id_: int, **fields: Any) -> Response:
    return client.patch(f"{URL}/{id_}", json=fields, headers=headers)


def delete(headers: Headers, id_: int) -> Response:
    return client.delete(f"{URL}/{id_}", headers=headers)


def trades(headers: Headers, **params: Any) -> list[dict[str, Any]]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()["trades"]


def accounts(headers: Headers) -> dict[str, Any]:
    return client.get("/api/accounts", headers=headers).json()


def balance(headers: Headers, account_id: int) -> str:
    return next(a["balance"] for a in accounts(headers)["accounts"] if a["id"] == account_id)


def error(response: Response) -> tuple[list[list[str]], str]:
    detail = response.json()["detail"]
    return locs(response), detail[0]["msg"]


def test_buy_lowers_broker_cash(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    have = accounts(headers)["total_have"]
    assert have == "10000.00"
    body = made(headers, stock_id=infy, account_id=account, charges="20.00", note=" first ")
    assert body == {
        "id": body["id"],
        "stock_id": infy,
        "symbol": "INFY",
        "account_id": account,
        "account_name": "Zerodha",
        "side": "buy",
        "date": DAY,
        "quantity": 10,
        "price": "500.00",
        "charges": "20.00",
        "opening": False,
        "note": "first",
        "amount": "5020.00",
        "realised": None,
    }
    assert balance(headers, account) == "4980.00"
    assert accounts(headers)["total_have"] == "4980.00"


def test_sell_raises_broker_cash(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, charges="20.00")
    sell = made(
        headers,
        stock_id=infy,
        account_id=account,
        side="sell",
        quantity=4,
        price="600.00",
        charges="10.00",
        date="2026-01-20",
    )
    assert balance(headers, account) == "7370.00"
    assert sell["amount"] == "2390.00"
    assert sell["realised"] == "382.00"
    assert trades(headers)[0]["realised"] == "382.00"


def test_opening_buy_leaves_cash_alone(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    body = made(headers, stock_id=infy, account_id=account, opening=True)
    assert body["opening"] is True
    assert balance(headers, account) == "10000.00"
    assert trades(headers)[0]["opening"] is True


def test_opening_sell_is_422(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account)
    response = trade(headers, stock_id=infy, account_id=account, side="sell", opening=True)
    assert response.status_code == 422
    assert error(response) == ([["body", "opening"]], "Only a buy can be existing shares.")


def test_broker_can_go_negative(headers: Headers) -> None:
    account, infy = broker(headers, "100.00"), stock(headers)
    made(headers, stock_id=infy, account_id=account)
    assert balance(headers, account) == "-4900.00"


def test_account_must_be_active_broker(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    infy = stock(headers)
    response = trade(headers, stock_id=infy, account_id=bank(headers))
    assert response.status_code == 422
    assert error(response) == ([["body", "account_id"]], "Choose a broker account.")

    old = broker(headers, name="Upstox")
    db_session.get(Account, old).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
    db_session.commit()
    response = trade(headers, stock_id=infy, account_id=old)
    assert response.status_code == 422
    assert error(response) == (
        [["body", "account_id"]],
        "Upstox is archived. Restore it to use it.",
    )

    theirs = broker(auth(db_session, monkeypatch, "them@example.com"))
    response = trade(headers, stock_id=infy, account_id=theirs)
    assert response.status_code == 422
    assert error(response) == ([["body", "account_id"]], "Choose a broker account.")


def test_unknown_stock_is_422(headers: Headers) -> None:
    response = trade(headers, stock_id=999, account_id=broker(headers))
    assert response.status_code == 422
    assert error(response) == ([["body", "stock_id"]], "Choose a stock.")


def _future() -> str:
    return (today_india() + timedelta(days=1)).isoformat()


@pytest.mark.parametrize(
    ("fields", "loc", "message"),
    [
        ({"quantity": 0}, "quantity", QUANTITY_RULE),
        ({"quantity": 100000001}, "quantity", QUANTITY_RULE),
        ({"quantity": 1.5}, "quantity", QUANTITY_RULE),
        ({"quantity": "3"}, "quantity", QUANTITY_RULE),
        ({"quantity": True}, "quantity", QUANTITY_RULE),
        ({"price": "0"}, "price", "Price must be greater than 0."),
        ({"charges": "-1"}, "charges", "Charges can't be negative."),
        ({"date": "future"}, "date", "The date can't be in the future."),
        ({"side": "hold"}, "side", "Choose buy or sell."),
    ],
)
def test_field_rules(headers: Headers, fields: dict[str, Any], loc: str, message: str) -> None:
    if fields.get("date") == "future":
        fields = {"date": _future()}
    response = trade(headers, stock_id=stock(headers), account_id=broker(headers), **fields)
    assert response.status_code == 422
    assert error(response) == ([["body", loc]], message)


def test_sell_more_than_held_is_422(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=5, date="2026-01-10")
    response = trade(
        headers, stock_id=infy, account_id=account, side="sell", quantity=6, date="2026-01-12"
    )
    assert response.status_code == 422
    assert error(response) == (
        [["body", "quantity"]],
        "You'd be selling more INFY than you held on 12 Jan 2026.",
    )
    response = trade(
        headers, stock_id=infy, account_id=account, side="sell", quantity=1, date="2026-01-09"
    )
    assert response.status_code == 422
    assert error(response) == (
        [["body", "quantity"]],
        "You'd be selling more INFY than you held on 9 Jan 2026.",
    )
    assert len(trades(headers)) == 1


def test_sell_charges_over_value_is_422(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account)
    response = trade(
        headers,
        stock_id=infy,
        account_id=account,
        side="sell",
        quantity=1,
        price="10.00",
        charges="10.01",
    )
    assert response.status_code == 422
    assert error(response) == ([["body", "charges"]], "Charges can't be more than the sale value.")
    # Charges equal to the value are allowed: the sale brings in nothing.
    sell = made(
        headers,
        stock_id=infy,
        account_id=account,
        side="sell",
        quantity=1,
        price="10.00",
        charges="10.00",
    )
    assert sell["amount"] == "0.00"


def test_too_large_trade_is_422(headers: Headers) -> None:
    response = trade(
        headers,
        stock_id=stock(headers),
        account_id=broker(headers),
        quantity=100000000,
        price="99999999.99",
    )
    assert response.status_code == 422
    assert error(response) == ([["body", "price"]], "This trade is too large.")


def test_edit_buy_leaving_later_sell_short_is_409(headers: Headers) -> None:
    account, other, infy = broker(headers), broker(headers, name="Upstox"), stock(headers)
    buy = made(headers, stock_id=infy, account_id=account, date="2026-01-10")
    made(headers, stock_id=infy, account_id=account, side="sell", quantity=8, date="2026-01-12")
    short = "This would leave the sale of INFY on 12 Jan 2026 selling more than was held."
    for change in [
        {"quantity": 5},
        {"date": "2026-01-13"},
        {"account_id": other},
        {"stock_id": stock(headers, "TCS")},
    ]:
        response = patch(headers, buy["id"], **change)
        assert response.status_code == 409, change
        assert response.json()["detail"] == short
    assert next(t for t in trades(headers) if t["id"] == buy["id"]) == buy
    # Edits that keep the sell covered go through.
    response = patch(headers, buy["id"], quantity=8, price="400.00", note="topped up")
    assert response.status_code == 200, response.json()
    assert response.json()["amount"] == "3200.00"
    assert response.json()["note"] == "topped up"


def test_edit_sell_beyond_held_is_422(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, date="2026-01-10")
    sell = made(headers, stock_id=infy, account_id=account, side="sell", quantity=8)
    response = patch(headers, sell["id"], quantity=11)
    assert response.status_code == 422
    assert error(response) == (
        [["body", "quantity"]],
        "You'd be selling more INFY than you held on 15 Jan 2026.",
    )


@pytest.mark.parametrize("field", ["side", "opening"])
def test_patch_cannot_change_side_or_opening(headers: Headers, field: str) -> None:
    buy = made(headers, stock_id=stock(headers), account_id=broker(headers))
    response = patch(headers, buy["id"], **{field: "sell" if field == "side" else True})
    assert response.status_code == 422
    assert locs(response) == [["body", field]]


def test_delete_buy_leaving_sell_short_is_409(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    buy = made(headers, stock_id=infy, account_id=account, date="2026-01-10")
    made(headers, stock_id=infy, account_id=account, side="sell", quantity=8, date="2026-01-12")
    response = delete(headers, buy["id"])
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "This would leave the sale of INFY on 12 Jan 2026 selling more than was held."
    )
    assert len(trades(headers)) == 2


def test_delete_sell_restores_cash(headers: Headers) -> None:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account)
    sell = made(headers, stock_id=infy, account_id=account, side="sell", quantity=4, price="600")
    assert balance(headers, account) == "7400.00"
    response = delete(headers, sell["id"])
    assert response.status_code == 200
    assert response.json() == {"id": sell["id"]}
    assert balance(headers, account) == "5000.00"
    assert len(trades(headers)) == 1


def test_archived_broker_trades_are_locked(headers: Headers, db_session: Session) -> None:
    account, other, infy = broker(headers), broker(headers, name="Upstox"), stock(headers)
    buy = made(headers, stock_id=infy, account_id=account)
    moved = made(headers, stock_id=infy, account_id=other)
    db_session.get(Account, account).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
    db_session.commit()
    message = "Restore Zerodha before changing this trade."
    for response in [patch(headers, buy["id"], quantity=5), delete(headers, buy["id"])]:
        assert response.status_code == 409
        assert response.json()["detail"] == message
    # Nor can a trade be moved into the archived account.
    response = patch(headers, moved["id"], account_id=account)
    assert response.status_code == 409
    assert response.json()["detail"] == message


def test_list_filters(headers: Headers) -> None:
    account, other = broker(headers), broker(headers, name="Upstox")
    infy, tcs = stock(headers), stock(headers, "TCS")
    a = made(headers, stock_id=infy, account_id=account, date="2026-01-10")
    b = made(headers, stock_id=tcs, account_id=account, date="2026-01-12")
    c = made(headers, stock_id=infy, account_id=other, date="2026-01-12")
    d = made(headers, stock_id=infy, account_id=account, date="2026-01-11")
    assert [t["id"] for t in trades(headers)] == [c["id"], b["id"], d["id"], a["id"]]
    assert [t["id"] for t in trades(headers, stock_id=infy)] == [c["id"], d["id"], a["id"]]
    assert [t["id"] for t in trades(headers, account_id=account)] == [b["id"], d["id"], a["id"]]
    assert [t["id"] for t in trades(headers, stock_id=tcs, account_id=other)] == []


def test_trades_are_per_user(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    buy = made(headers, stock_id=stock(headers), account_id=broker(headers))
    them = auth(db_session, monkeypatch, "them@example.com")
    assert trades(them) == []
    assert patch(them, buy["id"], quantity=5).status_code == 404
    assert patch(them, buy["id"], quantity=5).json()["detail"] == "Trade not found."
    assert delete(them, buy["id"]).status_code == 404
    assert delete(them, 2**40).status_code == 404
    # Their own stock can't be traded with someone else's stock id.
    response = trade(them, stock_id=buy["stock_id"], account_id=broker(them))
    assert error(response) == ([["body", "stock_id"]], "Choose a stock.")


def test_transactions_list_unaffected(headers: Headers) -> None:
    account, infy, sbi = broker(headers), stock(headers), bank(headers)
    made(headers, stock_id=infy, account_id=account)
    body = client.get("/api/transactions", headers=headers).json()
    assert body["transactions"] == []
    response = client.post(
        "/api/transactions",
        json={
            "type": "transfer",
            "account_id": sbi,
            "to_account_id": account,
            "amount": "1000.00",
            "date": DAY,
        },
        headers=headers,
    )
    assert response.status_code == 201, response.json()
    assert balance(headers, account) == "6000.00"
    assert len(client.get("/api/transactions", headers=headers).json()["transactions"]) == 1
