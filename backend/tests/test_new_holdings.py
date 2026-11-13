"""A new instrument and its first purchase, created together or not at all."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.routes import market
from app.main import app
from app.models.account import Account
from app.models.investment import Instrument, InstrumentPrice, InvestmentTrade
from app.models.market import MarketCode
from app.prices.refresh import refresh_market
from tests.price_fakes import FUND_CODE, FUND_DATE, FUND_NAV, STOCK_CLOSE, STOCK_CODE, FakeFetcher
from tests.test_accounts import Headers, auth, locs, make

client = TestClient(app)

URL = "/api/investments"
DAY = "2026-01-15"


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def account(headers: Headers, type_: str, balance: str = "10000.00", name: str = "Zerodha") -> int:
    extra = {"bank_kind": "savings"} if type_ == "bank" else {}
    response = make(headers, type=type_, name=name, balance=balance, **extra)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def balance(headers: Headers, account_id: int) -> str:
    rows = client.get("/api/accounts", headers=headers).json()["accounts"]
    return next(a["balance"] for a in rows if a["id"] == account_id)


def instruments(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(Instrument)) or 0


def trades(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(InvestmentTrade)) or 0


def new_stock(headers: Headers, stock: dict[str, Any] | None = None, **trade: Any) -> Response:
    body = {
        "stock": stock if stock is not None else {"symbol": "infy", "name": "Infosys"},
        "trade": {"date": DAY, "quantity": 10, "price": "500.00", **trade},
    }
    return client.post(f"{URL}/stocks/with-trade", json=body, headers=headers)


def new_fund(headers: Headers, fund: dict[str, Any] | None = None, **trade: Any) -> Response:
    body = {
        "fund": fund if fund is not None else {"name": "Parag Parikh Flexi Cap"},
        "trade": {"date": DAY, "units": "10.000", "nav": "84.5000", "amount": "845.00", **trade},
    }
    return client.post(f"{URL}/funds/with-trade", json=body, headers=headers)


def new_coin(headers: Headers, coin: dict[str, Any] | None = None, **trade: Any) -> Response:
    body = {
        "coin": coin if coin is not None else {"symbol": "btc", "name": "Bitcoin"},
        "trade": {
            "date": DAY,
            "quantity": "0.01",
            "price": "5000000",
            "amount": "50000.00",
            **trade,
        },
    }
    return client.post(f"{URL}/coins/with-trade", json=body, headers=headers)


def test_stock_and_first_buy_together(headers: Headers) -> None:
    broker = account(headers, "broker")
    response = new_stock(headers, account_id=broker, charges="20.00", note=" first ")
    assert response.status_code == 201, response.json()
    body = response.json()
    stock = body["stock"]
    assert stock == {
        "id": stock["id"],
        "symbol": "INFY",
        "name": "Infosys",
        "price": None,
        "price_date": None,
        "source_code": None,
    }
    assert body["trade"] == {
        "id": body["trade"]["id"],
        "stock_id": stock["id"],
        "symbol": "INFY",
        "account_id": broker,
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
    assert balance(headers, broker) == "4980.00"
    listed = client.get(f"{URL}/trades", params={"stock_id": stock["id"]}, headers=headers)
    assert [t["id"] for t in listed.json()["trades"]] == [body["trade"]["id"]]


def test_existing_shares_leave_cash_alone(headers: Headers) -> None:
    broker = account(headers, "broker")
    response = new_stock(headers, account_id=broker, opening=True)
    assert response.status_code == 201, response.json()
    assert response.json()["trade"]["opening"] is True
    assert balance(headers, broker) == "10000.00"


def test_refused_trade_leaves_no_stock(headers: Headers, db_session: Session) -> None:
    broker = account(headers, "broker")
    response = new_stock(headers, account_id=broker, price=None)
    assert response.status_code == 422
    assert locs(response) == [["body", "price"]]
    assert instruments(db_session) == 0 and trades(db_session) == 0

    future = date(2099, 1, 1).isoformat()
    response = new_stock(headers, account_id=broker, date=future)
    assert response.status_code == 422 and locs(response) == [["body", "date"]]
    assert instruments(db_session) == 0


def test_archived_broker_leaves_no_stock(headers: Headers, db_session: Session) -> None:
    broker = account(headers, "broker", name="Upstox")
    db_session.get(Account, broker).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
    db_session.commit()
    response = new_stock(headers, account_id=broker)
    assert response.status_code == 422
    assert response.json()["detail"][0]["msg"] == "Upstox is archived. Restore it to use it."
    assert instruments(db_session) == 0


def test_another_users_broker_is_refused(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    theirs = account(auth(db_session, monkeypatch, "them@example.com"), "broker")
    response = new_stock(headers, account_id=theirs)
    assert response.status_code == 422 and locs(response) == [["body", "account_id"]]
    assert instruments(db_session) == 0


def test_instrument_and_trade_errors_come_together(headers: Headers, db_session: Session) -> None:
    response = new_stock(headers, stock={"symbol": "INFY"}, quantity=None)
    assert response.status_code == 422
    assert {loc[-1] for loc in locs(response)} == {"name", "quantity", "account_id"}
    assert instruments(db_session) == 0


def test_duplicate_symbol_saves_nothing(headers: Headers, db_session: Session) -> None:
    broker = account(headers, "broker")
    assert new_stock(headers, account_id=broker).status_code == 201
    response = new_stock(headers, account_id=broker)
    assert response.status_code == 422
    assert locs(response) == [["body", "symbol"]]
    assert response.json()["detail"][0]["msg"] == "You already have INFY."
    assert instruments(db_session) == 1 and trades(db_session) == 1


@pytest.mark.parametrize("extra", [{"side": "sell"}, {"stock_id": 1}])
def test_side_and_instrument_id_are_not_accepted(headers: Headers, extra: dict[str, Any]) -> None:
    response = new_stock(headers, account_id=account(headers, "broker"), **extra)
    assert response.status_code == 422


def test_body_parts_are_required(headers: Headers) -> None:
    response = client.post(f"{URL}/stocks/with-trade", json={}, headers=headers)
    assert response.status_code == 422


def test_needs_login(db_session: Session) -> None:
    response = client.post(f"{URL}/stocks/with-trade", json={})
    assert response.status_code == 401


def test_fund_and_first_purchase_together(headers: Headers, db_session: Session) -> None:
    bank = account(headers, "bank", balance="50000.00", name="SBI")
    response = new_fund(headers, account_id=bank)
    assert response.status_code == 201, response.json()
    body = response.json()
    assert body["fund"]["symbol"] == "PPFC"
    assert body["fund"]["nav"] == "84.5000" and body["fund"]["nav_date"] == DAY
    trade = body["trade"]
    assert trade["fund_id"] == body["fund"]["id"]
    assert (trade["side"], trade["units"], trade["nav"], trade["amount"]) == (
        "buy",
        "10.000",
        "84.5000",
        "845.00",
    )
    assert balance(headers, bank) == "49155.00"
    # The purchase recorded its NAV, as a purchase made on its own does.
    navs = db_session.scalars(select(InstrumentPrice)).all()
    assert [(n.trade_id, str(n.price)) for n in navs] == [(trade["id"], "84.5000")]


def test_fund_existing_units(headers: Headers) -> None:
    bank = account(headers, "bank", balance="50000.00", name="SBI")
    response = new_fund(headers, account_id=bank, opening=True, nav=None, amount="1000.00")
    assert response.status_code == 201, response.json()
    assert response.json()["trade"]["nav"] == "100.0000"
    assert balance(headers, bank) == "50000.00"


def test_fund_mismatch_leaves_no_fund(headers: Headers, db_session: Session) -> None:
    bank = account(headers, "bank", balance="50000.00", name="SBI")
    response = new_fund(headers, account_id=bank, amount="900.00")
    assert response.status_code == 422 and locs(response) == [["body", "units"]]
    assert instruments(db_session) == 0


def test_fund_needs_a_bank(headers: Headers, db_session: Session) -> None:
    response = new_fund(headers, account_id=account(headers, "broker"))
    assert response.status_code == 422 and locs(response) == [["body", "account_id"]]
    assert instruments(db_session) == 0


def test_fund_sip_is_not_accepted(headers: Headers) -> None:
    bank = account(headers, "bank", balance="50000.00", name="SBI")
    assert new_fund(headers, account_id=bank, sip_id=1).status_code == 422


def test_coin_and_first_buy_together(headers: Headers) -> None:
    exchange = account(headers, "broker", balance="100000.00", name="WazirX")
    response = new_coin(headers, account_id=exchange)
    assert response.status_code == 201, response.json()
    body = response.json()
    assert body["coin"]["symbol"] == "BTC" and body["coin"]["name"] == "Bitcoin"
    assert body["trade"]["coin_id"] == body["coin"]["id"]
    assert body["trade"]["quantity"] == "0.01000000"
    assert balance(headers, exchange) == "50000.00"


def test_coin_mismatch_leaves_no_coin(headers: Headers, db_session: Session) -> None:
    exchange = account(headers, "broker", balance="100000.00", name="WazirX")
    response = new_coin(headers, account_id=exchange, amount="10.00")
    assert response.status_code == 422 and locs(response) == [["body", "quantity"]]
    assert instruments(db_session) == 0


def test_coin_duplicate_ticker(headers: Headers, db_session: Session) -> None:
    exchange = account(headers, "broker", balance="100000.00", name="WazirX")
    assert new_coin(headers, account_id=exchange).status_code == 201
    response = new_coin(headers, account_id=exchange)
    assert response.status_code == 422 and locs(response) == [["body", "symbol"]]
    assert trades(db_session) == 1


@pytest.fixture
def seeded(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    today = date(2026, 11, 12)
    monkeypatch.setattr(market, "today_india", lambda: today)
    refresh_market(db_session, FakeFetcher(), today, kinds={"mutual_fund", "stock"})
    db_session.commit()


def test_linked_stock_gets_its_price(headers: Headers, seeded: None) -> None:
    broker = account(headers, "broker")
    response = new_stock(
        headers,
        stock={"symbol": "RELI", "name": "Reliance", "source_code": STOCK_CODE},
        account_id=broker,
    )
    assert response.status_code == 201, response.json()
    assert response.json()["stock"]["source_code"] == STOCK_CODE
    assert response.json()["stock"]["price"] == f"{STOCK_CLOSE}"


def test_unknown_code_saves_nothing(headers: Headers, seeded: None, db_session: Session) -> None:
    response = new_stock(
        headers,
        stock={"symbol": "RELI", "name": "Reliance", "source_code": "NOPE"},
        account_id=account(headers, "broker"),
    )
    assert response.status_code == 422 and locs(response) == [["body", "source_code"]]
    assert instruments(db_session) == 0


def test_linked_fund_keeps_market_nav_and_purchase_nav(
    headers: Headers, seeded: None, db_session: Session
) -> None:
    bank = account(headers, "bank", balance="50000.00", name="SBI")
    response = new_fund(
        headers, fund={"name": "Banking", "source_code": FUND_CODE}, account_id=bank
    )
    assert response.status_code == 201, response.json()
    fund = response.json()["fund"]
    # The market NAV is newer than the purchase, so it is the current one.
    assert fund["nav"] == f"{FUND_NAV}" and fund["nav_date"] == FUND_DATE.isoformat()
    navs = client.get(f"{URL}/funds/{fund['id']}/navs", headers=headers).json()["navs"]
    assert {(n["date"], n["source"]) for n in navs} == {
        (FUND_DATE.isoformat(), "auto"),
        (DAY, "manual"),
    }


def prices(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(InstrumentPrice)) or 0


def archived(headers: Headers, db: Session, type_: str, name: str) -> int:
    account_id = account(headers, type_, name=name)
    db.get(Account, account_id).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
    db.commit()
    return account_id


@pytest.mark.parametrize(
    ("make_new", "type_"), [(new_fund, "bank"), (new_coin, "broker")], ids=["fund", "coin"]
)
def test_another_users_account_leaves_nothing(
    headers: Headers,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    make_new: Any,
    type_: str,
) -> None:
    theirs = account(auth(db_session, monkeypatch, "them@example.com"), type_, name="Theirs")
    response = make_new(headers, account_id=theirs)
    assert response.status_code == 422 and locs(response) == [["body", "account_id"]]
    assert instruments(db_session) == 0 and trades(db_session) == 0


@pytest.mark.parametrize(
    ("make_new", "type_"), [(new_fund, "bank"), (new_coin, "broker")], ids=["fund", "coin"]
)
def test_archived_account_leaves_nothing(
    headers: Headers, db_session: Session, make_new: Any, type_: str
) -> None:
    old = archived(headers, db_session, type_, "Old")
    response = make_new(headers, account_id=old)
    assert response.status_code == 422 and locs(response) == [["body", "account_id"]]
    assert response.json()["detail"][0]["msg"] == "Old is archived. Restore it to use it."
    assert instruments(db_session) == 0 and trades(db_session) == 0


@pytest.mark.parametrize(
    ("make_new", "type_", "spent"),
    [(new_fund, "bank", "845.00"), (new_coin, "broker", "50000.00")],
    ids=["fund", "coin"],
)
def test_more_than_the_cash_is_allowed_as_on_its_own(
    headers: Headers, make_new: Any, type_: str, spent: str
) -> None:
    # Banks and brokers can go below zero (`CAN_BE_NEGATIVE`), so a first purchase bigger than the
    # cash is saved, exactly as the same purchase made on its own would be.
    poor = account(headers, type_, balance="100.00", name="Poor")
    response = make_new(headers, account_id=poor)
    assert response.status_code == 201, response.json()
    expected = (Decimal("100.00") - Decimal(spent)).quantize(Decimal("0.01"))
    assert balance(headers, poor) == f"{expected}"


def test_refused_linked_stock_leaves_no_price(
    headers: Headers, seeded: None, db_session: Session
) -> None:
    before = prices(db_session)
    response = new_stock(
        headers,
        stock={"symbol": "RELI", "name": "Reliance", "source_code": STOCK_CODE},
        account_id=archived(headers, db_session, "broker", "Old"),
    )
    assert response.status_code == 422
    assert instruments(db_session) == 0 and prices(db_session) == before == 0


def test_refused_linked_fund_leaves_no_nav(
    headers: Headers, seeded: None, db_session: Session
) -> None:
    bank = account(headers, "bank", balance="50000.00", name="SBI")
    response = new_fund(
        headers, fund={"name": "Banking", "source_code": FUND_CODE}, account_id=bank, amount="1.00"
    )
    assert response.status_code == 422 and locs(response) == [["body", "units"]]
    assert instruments(db_session) == 0 and prices(db_session) == 0


def test_refused_linked_coin_leaves_no_price(headers: Headers, db_session: Session) -> None:
    db_session.add(
        MarketCode(
            kind="crypto",
            code="bitcoin",
            name="Bitcoin (BTC)",
            price=Decimal("9000000"),
            price_date=date(2026, 11, 12),
        )
    )
    db_session.commit()
    exchange = account(headers, "broker", balance="100000.00", name="WazirX")
    response = new_coin(
        headers,
        coin={"symbol": "BTC", "name": "Bitcoin", "source_code": "bitcoin"},
        account_id=exchange,
        amount="1.00",
    )
    assert response.status_code == 422 and locs(response) == [["body", "quantity"]]
    assert instruments(db_session) == 0 and prices(db_session) == 0
    # The same coin, linked, with a purchase that adds up, gets the market price.
    response = new_coin(
        headers,
        coin={"symbol": "BTC", "name": "Bitcoin", "source_code": "bitcoin"},
        account_id=exchange,
    )
    assert response.status_code == 201, response.json()
    assert response.json()["coin"]["price"] is not None and prices(db_session) == 1
