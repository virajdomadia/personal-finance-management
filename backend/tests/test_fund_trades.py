from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import delete as sql_delete
from sqlalchemy.orm import Session

from app.api.routes import fund_trades, funds
from app.main import app
from app.models.account import Account
from app.models.investment import Instrument, InvestmentTrade, Sip
from tests.test_accounts import Headers, auth, locs, make

client = TestClient(app)

URL = "/api/investments/fund-trades"
TODAY = date(2026, 11, 9)
DAY = "2026-11-05"
UNITS = "Enter units above 0, with up to 3 decimals, like 35.552."
NAV = "Enter a NAV above 0, with up to 4 decimals, like 84.3793."
MISMATCH = "Units × NAV doesn't match the amount. Check the units and NAV."


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(funds, "today_india", lambda: TODAY)
    monkeypatch.setattr(fund_trades, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def bank(headers: Headers, balance: str = "50000.00", name: str = "SBI") -> int:
    response = make(headers, type="bank", name=name, bank_kind="savings", balance=balance)
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def broker(headers: Headers) -> int:
    response = make(headers, type="broker", name="Zerodha", balance="10000.00")
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def fund(headers: Headers, symbol: str = "PPFCF") -> int:
    response = client.post(
        "/api/investments/funds",
        json={"name": "Parag Parikh Flexi Cap", "symbol": symbol},
        headers=headers,
    )
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def stock(headers: Headers, symbol: str = "INFY") -> int:
    response = client.post(
        "/api/investments/stocks", json={"symbol": symbol, "name": symbol}, headers=headers
    )
    assert response.status_code == 201, response.json()
    return response.json()["id"]


def buy(headers: Headers, **fields: Any) -> Response:
    body = {
        "side": "buy",
        "date": DAY,
        "units": "35.552",
        "nav": "84.3793",
        "charges": "0.15",
        "amount": "3000.00",
        **fields,
    }
    return client.post(URL, json=body, headers=headers)


def made(headers: Headers, **fields: Any) -> dict[str, Any]:
    response = buy(headers, **fields)
    assert response.status_code == 201, response.json()
    return response.json()


def redeem(headers: Headers, **fields: Any) -> Response:
    body = {"side": "sell", "units": "10.000", "nav": "86.0000", "charges": "0.00"}
    return buy(headers, **{**body, "amount": "860.00", **fields})


def patch(headers: Headers, id_: int, **fields: Any) -> Response:
    return client.patch(f"{URL}/{id_}", json=fields, headers=headers)


def delete(headers: Headers, id_: int) -> Response:
    return client.delete(f"{URL}/{id_}", headers=headers)


def trades(headers: Headers, **params: Any) -> list[dict[str, Any]]:
    response = client.get(URL, params=params, headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()["trades"]


def navs(headers: Headers, fund_id: int) -> list[dict[str, Any]]:
    response = client.get(f"/api/investments/funds/{fund_id}/navs", headers=headers)
    assert response.status_code == 200, response.json()
    return response.json()["navs"]


def add_nav(headers: Headers, fund_id: int, day: str, nav: str) -> dict[str, Any]:
    response = client.post(
        f"/api/investments/funds/{fund_id}/navs", json={"date": day, "nav": nav}, headers=headers
    )
    assert response.status_code == 201, response.json()
    return response.json()


def balance(headers: Headers, account_id: int) -> str:
    body = client.get("/api/accounts", headers=headers).json()
    return next(a["balance"] for a in body["accounts"] if a["id"] == account_id)


def error(response: Response) -> tuple[list[list[str]], str]:
    return locs(response), response.json()["detail"][0]["msg"]


def sip(db: Session, headers: Headers, fund_id: int, account_id: int) -> int:
    instrument = db.get(Instrument, fund_id)
    assert instrument is not None
    row = Sip(
        user_id=instrument.user_id,
        instrument_id=fund_id,
        account_id=account_id,
        amount=Decimal("3000.00"),
        day=5,
        start_date=date(2026, 1, 5),
    )
    db.add(row)
    db.commit()
    return row.id


def test_purchase_debits_the_bank_and_records_its_nav(
    headers: Headers, db_session: Session
) -> None:
    account, ppfcf = bank(headers), fund(headers)
    plan = sip(db_session, headers, ppfcf, account)
    body = made(headers, fund_id=ppfcf, account_id=account, sip_id=plan, note=" first ")
    assert body == {
        "id": body["id"],
        "fund_id": ppfcf,
        "symbol": "PPFCF",
        "account_id": account,
        "account_name": "SBI",
        "side": "buy",
        "date": DAY,
        "units": "35.552",
        "nav": "84.3793",
        "charges": "0.15",
        "amount": "3000.00",
        "opening": False,
        "sip_id": plan,
        "note": "first",
        "realised": None,
    }
    assert balance(headers, account) == "47000.00"
    assert navs(headers, ppfcf) == [
        {"id": navs(headers, ppfcf)[0]["id"], "date": DAY, "nav": "84.3793", "trade_id": body["id"]}
    ]
    assert trades(headers) == [body]


def test_existing_units_leave_the_bank_alone(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    body = made(
        headers,
        fund_id=ppfcf,
        account_id=account,
        opening=True,
        units="253.462",
        amount="21000.00",
        nav=None,
        charges=None,
    )
    assert body["opening"] is True
    assert body["nav"] == "82.8527"
    assert body["charges"] == "0.00"
    assert balance(headers, account) == "50000.00"
    assert navs(headers, ppfcf) == []
    # A NAV sent with existing units is ignored.
    other = made(
        headers, fund_id=ppfcf, account_id=account, opening=True, units="1", amount="10.00"
    )
    assert other["nav"] == "10.0000"
    assert navs(headers, ppfcf) == []


def test_units_times_nav_check(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    response = buy(headers, fund_id=ppfcf, account_id=account, units="355.52")
    assert response.status_code == 422
    assert error(response) == ([["body", "units"]], MISMATCH)
    assert made(headers, fund_id=ppfcf, account_id=account, units="35.560")["units"] == "35.560"


def test_redemption_credits_the_bank_and_realises(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    made(headers, fund_id=ppfcf, account_id=account)
    response = redeem(headers, fund_id=ppfcf, account_id=account, date="2026-11-07")
    assert response.status_code == 201, response.json()
    body = response.json()
    assert body["side"] == "sell"
    assert body["realised"] == "16.17"
    assert balance(headers, account) == "47860.00"
    assert trades(headers)[0]["realised"] == "16.17"
    # A redemption's NAV is recorded too.
    assert [n["date"] for n in navs(headers, ppfcf)] == ["2026-11-07", DAY]


@pytest.mark.parametrize(
    ("amount", "units", "loc", "message"),
    [
        ("0.01", "1000", "amount", "That's too little for that many units."),
        ("999999999.00", "0.001", "units", "That's too few units for that amount."),
    ],
)
def test_existing_units_out_of_range(
    headers: Headers, amount: str, units: str, loc: str, message: str
) -> None:
    account, ppfcf = bank(headers), fund(headers)
    response = buy(
        headers,
        fund_id=ppfcf,
        account_id=account,
        opening=True,
        units=units,
        amount=amount,
        charges=None,
    )
    assert response.status_code == 422
    assert error(response) == ([["body", loc]], message)
    assert trades(headers) == []


def test_editing_the_date_moves_the_auto_nav(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    body = made(headers, fund_id=ppfcf, account_id=account)
    response = patch(headers, body["id"], date="2026-10-06")
    assert response.status_code == 200, response.json()
    [row] = navs(headers, ppfcf)
    assert (row["date"], row["nav"], row["trade_id"]) == ("2026-10-06", "84.3793", body["id"])
    # Editing the NAV updates the same row.
    response = patch(headers, body["id"], nav="84.3800")
    assert response.status_code == 200, response.json()
    assert navs(headers, ppfcf) == [{**row, "nav": "84.3800"}]
    # Onto a date with a NAV entered by hand: the linked row goes, the manual one stays.
    manual = add_nav(headers, ppfcf, "2026-10-20", "80.0000")
    response = patch(headers, body["id"], date="2026-10-20")
    assert response.status_code == 200, response.json()
    assert navs(headers, ppfcf) == [manual]


def test_deleting_a_trade_deletes_its_nav(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    body = made(headers, fund_id=ppfcf, account_id=account)
    response = delete(headers, body["id"])
    assert response.status_code == 200
    assert response.json() == {"id": body["id"]}
    assert navs(headers, ppfcf) == []
    listed = client.get("/api/investments/funds", headers=headers).json()["funds"]
    assert listed[0]["nav"] is None
    assert balance(headers, account) == "50000.00"

    body = made(headers, fund_id=ppfcf, account_id=account)
    manual = add_nav(headers, ppfcf, DAY, "84.0000")
    assert len(navs(headers, ppfcf)) == 2
    assert delete(headers, body["id"]).status_code == 200
    assert navs(headers, ppfcf) == [manual]


def test_existing_nav_on_the_date_is_kept(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    manual = add_nav(headers, ppfcf, DAY, "84.0000")
    made(headers, fund_id=ppfcf, account_id=account)
    assert navs(headers, ppfcf) == [manual]


@pytest.mark.parametrize(
    ("fields", "loc", "message"),
    [
        ({"fund_id": None}, "fund_id", "Choose a fund."),
        ({"fund_id": "stock"}, "fund_id", "Choose a fund."),
        ({"fund_id": 999}, "fund_id", "Choose a fund."),
        ({"account_id": None}, "account_id", "Choose a bank account."),
        ({"account_id": "broker"}, "account_id", "Choose a bank account."),
        ({"account_id": "archived"}, "account_id", "Old SBI is archived. Restore it to use it."),
        ({"side": "hold"}, "side", "Choose purchase or redemption."),
        ({"side": None}, "side", "Choose purchase or redemption."),
        ({"date": "2026-11-10"}, "date", "The date can't be in the future."),
        ({"units": None}, "units", UNITS),
        ({"units": "1.2345"}, "units", UNITS),
        ({"nav": None}, "nav", NAV),
        ({"amount": None}, "amount", "Enter the amount."),
        ({"amount": "0"}, "amount", "Amount must be greater than 0."),
        ({"charges": "-1"}, "charges", "Charges can't be negative."),
        ({"charges": "3000.00"}, "charges", "Charges can't be more than the amount."),
        ({"opening": True, "side": "sell"}, "opening", "Only a purchase can be existing units."),
        ({"sip_id": "other"}, "sip_id", "Choose a SIP for this fund."),
        ({"sip_id": 999}, "sip_id", "Choose a SIP for this fund."),
        ({"sip_id": "own", "side": "sell"}, "sip_id", "Choose a SIP for this fund."),
        (
            {"units": "1000000000", "nav": "1000", "amount": "999999999999.99"},
            "nav",
            "This transaction is too large.",
        ),
    ],
)
def test_field_rules(
    headers: Headers, db_session: Session, fields: dict[str, Any], loc: str, message: str
) -> None:
    account, ppfcf = bank(headers), fund(headers)
    made(headers, fund_id=ppfcf, account_id=account)  # units to redeem
    other = fund(headers, "OTHER")
    resolved = {"fund_id": ppfcf, "account_id": account, **fields}
    if resolved["fund_id"] == "stock":
        resolved["fund_id"] = stock(headers)
    if resolved["account_id"] == "broker":
        resolved["account_id"] = broker(headers)
    if resolved["account_id"] == "archived":
        old = bank(headers, name="Old SBI")
        db_session.get(Account, old).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
        db_session.commit()
        resolved["account_id"] = old
    if resolved.get("sip_id") == "other":
        resolved["sip_id"] = sip(db_session, headers, other, account)
    if resolved.get("sip_id") == "own":
        resolved["sip_id"] = sip(db_session, headers, ppfcf, account)
    if resolved.get("side") == "sell":
        resolved.update(units="1.000", amount="86.00", charges="0.00")
    response = buy(headers, **resolved)
    assert response.status_code == 422, response.json()
    assert error(response) == ([["body", loc]], message)
    assert len(trades(headers)) == 1


def test_sip_of_another_user_is_422(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    them = auth(db_session, monkeypatch, "them@example.com")
    theirs = sip(db_session, them, fund(them), bank(them))
    response = buy(headers, fund_id=fund(headers), account_id=bank(headers), sip_id=theirs)
    assert error(response) == ([["body", "sip_id"]], "Choose a SIP for this fund.")


def test_bank_balance_check_is_on_amount(headers: Headers) -> None:
    account, ppfcf = bank(headers, "999999999999.00"), fund(headers)
    made(headers, fund_id=ppfcf, account_id=account, opening=True, units="10", amount="100.00")
    response = redeem(headers, fund_id=ppfcf, account_id=account)
    assert response.status_code == 422
    assert error(response) == (
        [["body", "amount"]],
        "This would take SBI past the largest balance allowed.",
    )


def test_fund_and_stock_trades_stay_apart(headers: Headers) -> None:
    ppfcf, sbi = fund(headers), bank(headers)
    infy, zerodha = stock(headers), broker(headers)
    fund_trade = made(headers, fund_id=ppfcf, account_id=sbi)
    response = client.post(
        "/api/investments/trades",
        json={
            "stock_id": infy,
            "account_id": zerodha,
            "side": "buy",
            "date": DAY,
            "quantity": 1,
            "price": "100.00",
        },
        headers=headers,
    )
    assert response.status_code == 201, response.json()
    stock_trade = response.json()
    assert [t["id"] for t in trades(headers)] == [fund_trade["id"]]
    stock_list = client.get("/api/investments/trades", headers=headers).json()["trades"]
    assert [t["id"] for t in stock_list] == [stock_trade["id"]]
    for response in [
        patch(headers, stock_trade["id"], note="x"),
        delete(headers, stock_trade["id"]),
        client.patch(
            f"/api/investments/trades/{fund_trade['id']}", json={"note": "x"}, headers=headers
        ),
        client.delete(f"/api/investments/trades/{fund_trade['id']}", headers=headers),
        patch(headers, 2**40, note="x"),
    ]:
        assert response.status_code == 404
    # A stock can't be moved into a fund trade either.
    response = patch(headers, fund_trade["id"], fund_id=infy)
    assert error(response) == ([["body", "fund_id"]], "Choose a fund.")


def test_list_filters(headers: Headers, db_session: Session) -> None:
    sbi, hdfc = bank(headers), bank(headers, name="HDFC")
    ppfcf, other = fund(headers), fund(headers, "OTHER")
    plan = sip(db_session, headers, ppfcf, sbi)
    a = made(headers, fund_id=ppfcf, account_id=sbi, date="2026-11-01", sip_id=plan)
    b = made(headers, fund_id=other, account_id=sbi, date="2026-11-03")
    c = made(headers, fund_id=ppfcf, account_id=hdfc, date="2026-11-03")
    assert [t["id"] for t in trades(headers)] == [c["id"], b["id"], a["id"]]
    assert [t["id"] for t in trades(headers, fund_id=ppfcf)] == [c["id"], a["id"]]
    assert [t["id"] for t in trades(headers, account_id=sbi)] == [b["id"], a["id"]]
    assert [t["id"] for t in trades(headers, sip_id=plan)] == [a["id"]]


def test_trades_are_per_user(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = made(headers, fund_id=fund(headers), account_id=bank(headers))
    them = auth(db_session, monkeypatch, "them@example.com")
    assert trades(them) == []
    assert patch(them, body["id"], note="x").status_code == 404
    assert delete(them, body["id"]).status_code == 404
    response = buy(them, fund_id=body["fund_id"], account_id=bank(them))
    assert error(response) == ([["body", "fund_id"]], "Choose a fund.")


def test_redeem_more_than_held_is_422(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    made(headers, fund_id=ppfcf, account_id=account)
    response = redeem(headers, fund_id=ppfcf, account_id=account, units="35.553")
    assert response.status_code == 422
    assert error(response) == (
        [["body", "units"]],
        "You'd be redeeming more PPFCF units than you held on 5 Nov 2026.",
    )
    response = redeem(headers, fund_id=ppfcf, account_id=account, date="2026-11-04")
    assert error(response) == (
        [["body", "units"]],
        "You'd be redeeming more PPFCF units than you held on 4 Nov 2026.",
    )
    # Every unit can be redeemed.
    response = redeem(headers, fund_id=ppfcf, account_id=account, units="35.552")
    assert response.status_code == 201, response.json()


def test_edit_leaving_a_later_redemption_short_is_409(headers: Headers) -> None:
    account, other_bank, ppfcf = bank(headers), bank(headers, name="HDFC"), fund(headers)
    purchase = made(headers, fund_id=ppfcf, account_id=account)
    response = redeem(headers, fund_id=ppfcf, account_id=account, units="30", date="2026-11-07")
    assert response.status_code == 201, response.json()
    short = "This would leave the redemption of PPFCF on 7 Nov 2026 redeeming more than was held."
    for change in [
        {"date": "2026-11-08"},
        {"account_id": other_bank},
        {"units": "20.000", "amount": "1687.74"},
        {"fund_id": fund(headers, "NEW")},
    ]:
        response = patch(headers, purchase["id"], **change)
        assert response.status_code == 409, (change, response.json())
        assert response.json()["detail"] == short
    response = delete(headers, purchase["id"])
    assert response.status_code == 409
    assert response.json()["detail"] == short
    assert next(t for t in trades(headers) if t["id"] == purchase["id"]) == purchase


def test_patch_rules(headers: Headers, db_session: Session) -> None:
    account, ppfcf = bank(headers), fund(headers)
    body = made(headers, fund_id=ppfcf, account_id=account)
    for field, value in [("side", "sell"), ("opening", True)]:
        response = patch(headers, body["id"], **{field: value})
        assert response.status_code == 422
        assert locs(response) == [["body", field]]
    response = patch(headers, body["id"], nav=None)
    assert error(response) == ([["body", "nav"]], NAV)
    plan = sip(db_session, headers, ppfcf, account)
    response = patch(headers, body["id"], sip_id=plan, charges=None, amount="2999.85")
    assert response.status_code == 200, response.json()
    assert (response.json()["sip_id"], response.json()["charges"]) == (plan, "0.00")
    assert balance(headers, account) == "47000.15"
    response = patch(headers, body["id"], sip_id=None)
    assert response.json()["sip_id"] is None


def test_editing_existing_units_reworks_the_average(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    body = made(
        headers, fund_id=ppfcf, account_id=account, opening=True, units="253.462", amount="21000"
    )
    response = patch(headers, body["id"], amount="22000.00", nav="1.0000")
    assert response.status_code == 200, response.json()
    assert response.json()["nav"] == "86.7980"
    assert navs(headers, ppfcf) == []
    response = patch(headers, body["id"], amount="0.01", units="1000", charges=None)
    assert error(response) == ([["body", "amount"]], "That's too little for that many units.")


def test_archived_bank_trades_are_locked(headers: Headers, db_session: Session) -> None:
    account, ppfcf = bank(headers), fund(headers)
    body = made(headers, fund_id=ppfcf, account_id=account)
    db_session.get(Account, account).archived_at = datetime.now(UTC)  # type: ignore[union-attr]
    db_session.commit()
    for response in [patch(headers, body["id"], note="x"), delete(headers, body["id"])]:
        assert response.status_code == 409
        assert response.json()["detail"] == "Restore SBI before changing this trade."


def test_another_kinds_shortfall_never_blocks_a_save(
    headers: Headers, db_session: Session
) -> None:
    """A stock save only checks stock holdings, and a fund save only fund holdings.

    Saves can't leave a shortfall behind, but if one were there (here written straight to the
    database), a save of the other kind didn't cause it and isn't refused in the wrong words.
    """
    sbi, ppfcf = bank(headers), fund(headers)
    zerodha, infy = broker(headers), stock(headers)
    user_id = db_session.get(Instrument, ppfcf).user_id  # type: ignore[union-attr]

    def short_sell(instrument: int, account: int) -> InvestmentTrade:
        row = InvestmentTrade(
            user_id=user_id,
            instrument_id=instrument,
            account_id=account,
            side="sell",
            date=date(2026, 11, 1),
            quantity=Decimal(5),
            price=Decimal(10),
            charges=Decimal(0),
            amount=Decimal("50.00"),
            opening=False,
        )
        db_session.add(row)
        db_session.commit()
        return row

    def stock_buy(stock_id: int) -> Response:
        body = {
            "stock_id": stock_id,
            "account_id": zerodha,
            "side": "buy",
            "date": DAY,
            "quantity": 1,
            "price": "100.00",
        }
        return client.post("/api/investments/trades", json=body, headers=headers)

    # A fund that is short: a stock save goes through.
    fund_short = short_sell(ppfcf, sbi)
    response = stock_buy(stock(headers, "TCS"))
    assert response.status_code == 201, response.json()
    # A fund save is refused, in fund words.
    response = buy(headers, fund_id=fund(headers, "OTHER"), account_id=sbi)
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "This would leave the redemption of PPFCF on 1 Nov 2026 redeeming more than was held."
    )
    db_session.delete(fund_short)
    db_session.commit()

    # A stock that is short: a fund save goes through, and a stock save is refused in stock words.
    short_sell(infy, zerodha)
    made(headers, fund_id=ppfcf, account_id=sbi)
    response = stock_buy(stock(headers, "WIPRO"))
    assert response.status_code == 409
    assert response.json()["detail"] == (
        "This would leave the sale of INFY on 1 Nov 2026 selling more than was held."
    )


@pytest.mark.postgres
def test_purchase_for_a_sip_deleted_meanwhile_is_422(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    fund_id, account_id = fund(headers), bank(headers)
    sip_id = sip(db_session, headers, fund_id, account_id)
    real = fund_trades._check_sip

    def check_then_delete(db: Session, user_id: int, values: dict[str, Any]) -> None:
        real(db, user_id, values)
        db.execute(sql_delete(Sip).where(Sip.id == sip_id))  # gone before the purchase is saved

    monkeypatch.setattr(fund_trades, "_check_sip", check_then_delete)
    response = buy(headers, fund_id=fund_id, account_id=account_id, sip_id=sip_id)
    assert error(response) == ([["body", "sip_id"]], "Choose a SIP for this fund.")
    assert trades(headers) == []


def test_deleting_the_nav_owner_hands_the_date_to_another_trade(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    first = made(headers, fund_id=ppfcf, account_id=account)
    second = made(headers, fund_id=ppfcf, account_id=account, nav="84.0000", units="35.714")
    [row] = navs(headers, ppfcf)
    assert row["trade_id"] == first["id"]
    assert delete(headers, first["id"]).status_code == 200
    [row] = navs(headers, ppfcf)
    assert (row["date"], row["nav"], row["trade_id"]) == (DAY, "84.0000", second["id"])


def test_moving_the_nav_owner_hands_the_old_date_to_another_trade(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    first = made(headers, fund_id=ppfcf, account_id=account)
    second = made(headers, fund_id=ppfcf, account_id=account, nav="84.0000", units="35.714")
    assert patch(headers, first["id"], date="2026-10-06").status_code == 200
    rows = {r["date"]: r for r in navs(headers, ppfcf)}
    assert rows[DAY]["trade_id"] == second["id"]
    assert rows[DAY]["nav"] == "84.0000"
    assert rows["2026-10-06"]["trade_id"] == first["id"]
    assert len(rows) == 2


def test_integrity_error_without_a_sip_is_not_a_sip_error(
    headers: Headers, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqlalchemy.exc import IntegrityError

    account, ppfcf = bank(headers), fund(headers)
    existing = made(headers, fund_id=ppfcf, account_id=account)

    def boom(db: Session, trade: Any) -> None:
        raise IntegrityError("stmt", {}, Exception("other"))

    monkeypatch.setattr(fund_trades, "sync_trade_nav", boom)
    with pytest.raises(IntegrityError):
        buy(headers, fund_id=ppfcf, account_id=account)
    with pytest.raises(IntegrityError):
        patch(headers, existing["id"], note="x")


def test_hand_entered_nav_blocks_handover(headers: Headers) -> None:
    account, ppfcf = bank(headers), fund(headers)
    manual = add_nav(headers, ppfcf, DAY, "84.0000")
    body = made(headers, fund_id=ppfcf, account_id=account)
    response = patch(headers, body["id"], nav="84.3800")
    assert response.status_code == 200, response.json()
    [row] = [r for r in navs(headers, ppfcf) if r["date"] == DAY]
    assert row == manual
    assert row["trade_id"] is None
    assert row["nav"] == "84.0000"
