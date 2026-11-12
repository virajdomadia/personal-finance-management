from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.portfolio import latest_prices
from app.main import app
from app.models.investment import Instrument, InstrumentPrice
from app.models.market import MarketCode
from app.models.user import User
from app.prices.refresh import RefreshReport, apply_to_users, refresh_market, run_nightly
from tests.price_fakes import (
    COIN_ID,
    COIN_PRICE,
    FUND_CODE,
    FUND_DATE,
    FUND_NAV,
    STOCK_CLOSE,
    STOCK_CODE,
    STOCK_DATE,
    FakeFetcher,
)
from tests.test_accounts import Headers, auth
from tests.test_fund_trades import bank, buy, fund
from tests.test_stocks import add_price, add_stock

client = TestClient(app)
TODAY = date(2026, 11, 12)


def user(db: Session, email: str) -> int:
    row = User(email=email)
    db.add(row)
    db.commit()
    return row.id


def link(db: Session, user_id: int, kind: str, code: str | None, symbol: str = "X") -> Instrument:
    inst = Instrument(user_id=user_id, kind=kind, symbol=symbol, name=symbol, source_code=code)
    db.add(inst)
    db.commit()
    return inst


def rows(db: Session, inst: Instrument) -> list[InstrumentPrice]:
    return list(
        db.scalars(
            select(InstrumentPrice)
            .where(InstrumentPrice.instrument_id == inst.id)
            .order_by(InstrumentPrice.id)
        )
    )


def market(db: Session, kind: str, code: str) -> MarketCode:
    row = db.scalar(select(MarketCode).where(MarketCode.kind == kind, MarketCode.code == code))
    assert row is not None
    return row


def test_funds_and_stocks_and_crypto_update_linked_instruments(db_session: Session) -> None:
    a, b = user(db_session, "a@example.com"), user(db_session, "b@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE, "FUND")
    s = link(db_session, a, "stock", STOCK_CODE, "RELIANCE")
    c = link(db_session, b, "crypto", COIN_ID, "BTC")

    report = run_nightly(db_session, FakeFetcher(), TODAY)

    assert report.failed == {}
    assert report.updated["mutual_fund"] >= 1
    for inst, price, day in [
        (f, FUND_NAV, FUND_DATE),
        (s, STOCK_CLOSE, STOCK_DATE),
        (c, COIN_PRICE, TODAY),
    ]:
        [row] = rows(db_session, inst)
        assert (row.source, row.price, row.date) == ("auto", price, day)


def test_unlinked_instruments_untouched(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    unlinked = link(db_session, a, "mutual_fund", None, "FUND")
    run_nightly(db_session, FakeFetcher(), TODAY)
    assert rows(db_session, unlinked) == []


def test_refresh_does_not_fetch_prices_for_unlinked_holdings(db_session: Session) -> None:
    fetcher = FakeFetcher(holiday=True)
    refresh_market(db_session, fetcher, TODAY)
    assert fetcher.calls["simple_price"] == 0
    assert fetcher.calls["yahoo_chart"] == 0


def test_kinds_limits_what_is_refreshed(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    link(db_session, a, "crypto", COIN_ID)
    fetcher = FakeFetcher()
    report = refresh_market(db_session, fetcher, TODAY, {"crypto"})
    assert set(report.updated) == {"crypto"}
    assert fetcher.calls["navall"] == 0 and fetcher.calls["equity_list"] == 0


def test_manual_price_same_day_is_kept(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    db_session.add(
        InstrumentPrice(
            user_id=a, instrument_id=f.id, date=FUND_DATE, price=Decimal("99"), source="manual"
        )
    )
    db_session.commit()

    run_nightly(db_session, FakeFetcher(), TODAY)
    run_nightly(db_session, FakeFetcher(), TODAY)

    [row] = rows(db_session, f)
    assert (row.source, row.price) == ("manual", Decimal("99.0000"))


def test_manual_typed_after_auto_wins(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    headers = auth(db_session, monkeypatch)
    stock_id = add_stock(headers, STOCK_CODE).json()["id"]
    inst = db_session.get(Instrument, stock_id)
    assert inst is not None
    inst.source_code = STOCK_CODE
    db_session.commit()
    user_id = inst.user_id

    run_nightly(db_session, FakeFetcher(), TODAY)
    assert add_price(headers, stock_id, STOCK_DATE.isoformat(), "1500").status_code == 201
    assert latest_prices(db_session, user_id)[stock_id] == (STOCK_DATE, Decimal("1500"))

    run_nightly(db_session, FakeFetcher(), TODAY)

    assert latest_prices(db_session, user_id)[stock_id] == (STOCK_DATE, Decimal("1500"))
    assert [(r.source, r.price) for r in rows(db_session, inst)] == [
        ("auto", STOCK_CLOSE),
        ("manual", Decimal("1500.0000")),
    ]


def test_fund_trade_nav_counts_as_existing(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers: Headers = auth(db_session, monkeypatch)
    fund_id = fund(headers)
    account_id = bank(headers)
    response = buy(
        headers, fund_id=fund_id, account_id=account_id, date="2026-11-11", nav="84.3793"
    )
    assert response.status_code == 201, response.json()
    inst = db_session.get(Instrument, fund_id)
    assert inst is not None
    inst.source_code = FUND_CODE
    db_session.commit()
    before = [(r.id, r.price, r.trade_id) for r in rows(db_session, inst)]
    assert len(before) == 1 and before[0][2] is not None

    run_nightly(db_session, FakeFetcher(), TODAY)

    assert [(r.id, r.price, r.trade_id) for r in rows(db_session, inst)] == before


def test_holiday_bhavcopy_none_falls_back_to_yahoo(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    s = link(db_session, a, "stock", STOCK_CODE)
    fetcher = FakeFetcher(holiday=True)

    report = run_nightly(db_session, fetcher, TODAY)

    assert report.failed == {}
    assert fetcher.calls["yahoo_chart"] == 1  # only the linked stock
    [row] = rows(db_session, s)
    assert row.source == "auto" and row.price == Decimal("1312.45")


def test_bhavcopy_error_falls_back_to_yahoo(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    s = link(db_session, a, "stock", STOCK_CODE)
    report = run_nightly(db_session, FakeFetcher(fail={"bhavcopy"}), TODAY)
    assert report.failed == {}
    assert len(rows(db_session, s)) == 1


def test_one_source_failing_does_not_block_others(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    s = link(db_session, a, "stock", STOCK_CODE)
    c = link(db_session, a, "crypto", COIN_ID)
    run_nightly(db_session, FakeFetcher(), date(2026, 11, 11))
    fund_before = [(r.id, r.price) for r in rows(db_session, f)]
    stale = market(db_session, "mutual_fund", FUND_CODE).price
    market(db_session, "crypto", COIN_ID).price = Decimal("1")
    db_session.commit()

    report = run_nightly(db_session, FakeFetcher(fail={"navall"}), TODAY)

    assert report.failed == {"mutual_fund": "navall is down"}
    assert [(r.id, r.price) for r in rows(db_session, f)] == fund_before
    assert market(db_session, "mutual_fund", FUND_CODE).price == stale
    assert report.updated["stock"] >= 1 and report.updated["crypto"] == 1
    assert len(rows(db_session, s)) == 1
    assert market(db_session, "crypto", COIN_ID).price == COIN_PRICE
    assert len(rows(db_session, c)) == 2  # yesterday's and today's


def test_na_nav_does_not_clear_previous_market_price(db_session: Session) -> None:
    db_session.add(
        MarketCode(
            kind="mutual_fund",
            code="120503",
            name="Axis Bluechip Fund - Direct Plan - IDCW",
            price=Decimal("55.5000"),
            price_date=date(2026, 11, 10),
        )
    )
    db_session.commit()

    refresh_market(db_session, FakeFetcher(), TODAY)

    row = market(db_session, "mutual_fund", "120503")
    assert (row.price, row.price_date) == (Decimal("55.5000"), date(2026, 11, 10))


def test_market_codes_are_upserted_without_duplicates(db_session: Session) -> None:
    refresh_market(db_session, FakeFetcher(), TODAY)
    first = market(db_session, "mutual_fund", FUND_CODE).id
    refresh_market(db_session, FakeFetcher(), TODAY)
    codes = list(
        db_session.scalars(select(MarketCode.code).where(MarketCode.kind == "mutual_fund"))
    )
    assert len(codes) == len(set(codes)) == 4
    assert market(db_session, "mutual_fund", FUND_CODE).id == first


def test_crypto_auto_row_updated_in_place_same_day(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    c = link(db_session, a, "crypto", COIN_ID)
    run_nightly(db_session, FakeFetcher(), TODAY)
    [first] = rows(db_session, c)

    market(db_session, "crypto", COIN_ID).price = Decimal("9200000")
    db_session.commit()
    assert apply_to_users(db_session) == 1
    db_session.commit()

    [row] = rows(db_session, c)
    assert row.id == first.id and row.price == Decimal("9200000.0000")
    assert apply_to_users(db_session) == 0


def test_apply_to_users_only_kind(db_session: Session) -> None:
    a = user(db_session, "a@example.com")
    f = link(db_session, a, "mutual_fund", FUND_CODE)
    c = link(db_session, a, "crypto", COIN_ID)
    refresh_market(db_session, FakeFetcher(), TODAY)
    assert apply_to_users(db_session, only_kind="crypto") == 1
    assert rows(db_session, f) == [] and len(rows(db_session, c)) == 1


def test_report_shape() -> None:
    assert RefreshReport(updated={}, failed={}).failed == {}
