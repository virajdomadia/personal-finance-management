import json
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.routes import market
from app.main import app
from app.models.investment import InstrumentPrice
from app.models.market import MarketCode
from app.models.user import User
from app.prices.refresh import apply_to_users, refresh_market, run_nightly, sync_user_prices
from tests.price_fakes import (
    COIN_ID,
    COIN_PRICE,
    FUND_CODE,
    STOCK_CLOSE,
    STOCK_CODE,
    STOCK_DATE,
    FakeFetcher,
)
from tests.test_accounts import Headers, auth
from tests.test_price_refresh import link, rows, user

client = TestClient(app)
URL = "/api/investments/prices/sync"
TODAY = date(2026, 11, 12)
INTRADAY = Decimal("1320.5")


class IntradayFetcher(FakeFetcher):
    """Yahoo's latest quote, as during market hours: a different price on the latest date."""

    def yahoo_chart(self, symbol: str) -> dict:
        data = super().yahoo_chart(symbol)
        data["chart"]["result"][0]["indicators"]["quote"][0]["close"][2] = INTRADAY
        return data


def now() -> datetime:
    return datetime.now(UTC)


@pytest.fixture
def seeded(db_session: Session) -> None:
    refresh_market(db_session, FakeFetcher(), TODAY, kinds={"mutual_fund", "stock"})
    db_session.commit()


def age(db: Session, kind: str, seconds: int, base: datetime | None = None) -> None:
    old = (base or datetime.now(UTC)).astimezone(UTC) - timedelta(seconds=seconds)
    db.execute(update(MarketCode).where(MarketCode.kind == kind).values(updated_at=old))
    db.commit()


def test_sync_updates_only_this_users_holdings(db_session: Session, seeded: None) -> None:
    me, other = user(db_session, "me@x.com"), user(db_session, "other@x.com")
    mine = link(db_session, me, "crypto", COIN_ID, "BTC")
    theirs = link(db_session, other, "crypto", COIN_ID, "BTC")
    his_stock = link(db_session, other, "stock", STOCK_CODE, "REL")
    fake = FakeFetcher()
    report = sync_user_prices(db_session, fake, me, TODAY, now())
    assert report.updated == {"crypto": 1} and report.failed == {}
    assert [p.price for p in rows(db_session, mine)] == [COIN_PRICE]
    assert rows(db_session, theirs) == [] and rows(db_session, his_stock) == []
    assert fake.calls["yahoo_chart"] == 0 and fake.calls["navall"] == 0


def test_sync_skips_kind_refreshed_under_a_minute_ago(db_session: Session, seeded: None) -> None:
    me = user(db_session, "me@x.com")
    link(db_session, me, "crypto", COIN_ID, "BTC")
    sync_user_prices(db_session, FakeFetcher(), me, TODAY, now())
    fake = FakeFetcher()
    report = sync_user_prices(db_session, fake, me, TODAY, now())
    assert sum(fake.calls.values()) == 0 and report.failed == {}
    age(db_session, "crypto", 61)
    sync_user_prices(db_session, fake, me, TODAY, now())
    assert fake.calls["simple_price"] == 1


def test_sync_stock_intraday_then_nightly_close_replaces_it(
    db_session: Session, seeded: None
) -> None:
    me = user(db_session, "me@x.com")
    inst = link(db_session, me, "stock", STOCK_CODE, "REL")
    age(db_session, "stock", 120, ist(11))
    report = sync_user_prices(db_session, IntradayFetcher(), me, TODAY, ist(11))
    assert report.updated == {"stock": 1}
    assert [(p.date, p.price, p.source) for p in rows(db_session, inst)] == [
        (STOCK_DATE, INTRADAY, "auto")
    ]
    run_nightly(db_session, FakeFetcher(), TODAY)
    assert [(p.date, p.price, p.source) for p in rows(db_session, inst)] == [
        (STOCK_DATE, STOCK_CLOSE, "auto")
    ]


def test_sync_manual_price_today_still_wins(db_session: Session, seeded: None) -> None:
    me = user(db_session, "me@x.com")
    inst = link(db_session, me, "stock", STOCK_CODE, "REL")
    age(db_session, "stock", 120, ist(11))
    db_session.add(
        InstrumentPrice(
            user_id=me, instrument_id=inst.id, date=STOCK_DATE, price=Decimal("1"), source="manual"
        )
    )
    db_session.commit()
    sync_user_prices(db_session, IntradayFetcher(), me, TODAY, ist(11))
    assert [(p.price, p.source) for p in rows(db_session, inst)] == [(Decimal("1"), "manual")]


def test_sync_funds_not_refetched_within_6h(db_session: Session, seeded: None) -> None:
    me = user(db_session, "me@x.com")
    link(db_session, me, "mutual_fund", FUND_CODE, "F")
    age(db_session, "mutual_fund", 3 * 3600)
    fake = FakeFetcher()
    sync_user_prices(db_session, fake, me, TODAY, now())
    assert fake.calls["navall"] == 0
    age(db_session, "mutual_fund", 7 * 3600)
    sync_user_prices(db_session, fake, me, TODAY, now())
    assert fake.calls["navall"] == 1
    sync_user_prices(db_session, fake, me, TODAY, now())
    assert fake.calls["navall"] == 1


def test_sync_a_failed_kind_clears_nothing_and_others_go_on(
    db_session: Session, seeded: None
) -> None:
    me = user(db_session, "me@x.com")
    coin = link(db_session, me, "crypto", COIN_ID, "BTC")
    stock = link(db_session, me, "stock", STOCK_CODE, "REL")
    age(db_session, "stock", 120, ist(11))
    report = sync_user_prices(
        db_session, IntradayFetcher(fail={"simple_price"}), me, TODAY, ist(11)
    )
    assert "crypto" in report.failed and report.updated == {"stock": 1}
    assert rows(db_session, coin) == [] and len(rows(db_session, stock)) == 1


def test_sync_stops_when_the_budget_is_spent(db_session: Session, seeded: None) -> None:
    me = user(db_session, "me@x.com")
    link(db_session, me, "crypto", COIN_ID, "BTC")
    ticks = iter([0, 100, 100, 100])
    report = sync_user_prices(
        db_session, FakeFetcher(), me, TODAY, now(), clock=lambda: next(ticks)
    )
    assert report.updated == {} and "crypto" in report.failed


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(market, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def test_sync_source_failure_is_200_with_failed(
    headers: Headers, db_session: Session, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    uid = db_session.scalar(select(User.id))
    link(db_session, uid, "crypto", COIN_ID, "BTC")
    monkeypatch.setattr(market, "default_fetcher", lambda: FakeFetcher(fail={"simple_price"}))
    response = client.post(URL, headers=headers)
    assert response.status_code == 200
    body = json.loads(response.text)
    assert body["updated"] == {} and "crypto" in body["failed"]
    assert body["synced_at"].endswith("Z")


def test_sync_endpoint_prices_the_callers_coin(
    headers: Headers, db_session: Session, seeded: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    uid = db_session.scalar(select(User.id))
    inst = link(db_session, uid, "crypto", COIN_ID, "BTC")
    monkeypatch.setattr(market, "default_fetcher", lambda: FakeFetcher())
    body = client.post(URL, headers=headers).json()
    assert body["updated"] == {"crypto": 1} and body["failed"] == {}
    assert [p.price for p in rows(db_session, inst)] == [COIN_PRICE]


def test_sync_requires_auth() -> None:
    assert client.post(URL).status_code in (401, 403)


def test_sync_by_a_second_user_gets_the_price_the_first_fetched(
    db_session: Session, seeded: None
) -> None:
    a, b = user(db_session, "a@x.com"), user(db_session, "b@x.com")
    link(db_session, a, "crypto", COIN_ID, "BTC")
    theirs = link(db_session, b, "crypto", COIN_ID, "BTC")
    sync_user_prices(db_session, FakeFetcher(), a, TODAY, now())
    fake = FakeFetcher()
    sync_user_prices(db_session, fake, b, TODAY, now())
    assert sum(fake.calls.values()) == 0
    assert [p.price for p in rows(db_session, theirs)] == [COIN_PRICE]


def test_apply_collapses_duplicate_auto_rows_but_never_manual(db_session: Session) -> None:
    me = user(db_session, "me@x.com")
    inst = link(db_session, me, "crypto", COIN_ID, "BTC")
    db_session.add(
        MarketCode(kind="crypto", code=COIN_ID, name="b", price=COIN_PRICE, price_date=TODAY)
    )
    for price in ("1", "2"):
        db_session.add(
            InstrumentPrice(
                user_id=me, instrument_id=inst.id, date=TODAY, price=Decimal(price), source="auto"
            )
        )
    db_session.commit()
    apply_to_users(db_session, user_id=me)
    db_session.commit()
    assert [(p.price, p.source) for p in rows(db_session, inst)] == [(COIN_PRICE, "auto")]
    inst2 = link(db_session, me, "crypto", COIN_ID, "BTC2")
    for source in ("auto", "manual"):
        db_session.add(
            InstrumentPrice(
                user_id=me, instrument_id=inst2.id, date=TODAY, price=Decimal("5"), source=source
            )
        )
    db_session.commit()
    apply_to_users(db_session, user_id=me)
    db_session.commit()
    assert sorted((p.price, p.source) for p in rows(db_session, inst2)) == [
        (Decimal("5"), "auto"),
        (Decimal("5"), "manual"),
    ]


def ist(h: int, m: int = 0) -> datetime:
    return datetime(2026, 11, 11, h, m, tzinfo=timezone(timedelta(hours=5, minutes=30)))


def test_sync_same_date_quote_only_before_the_close(db_session: Session, seeded: None) -> None:
    me = user(db_session, "me@x.com")
    inst = link(db_session, me, "stock", STOCK_CODE, "REL")
    age(db_session, "stock", 120, ist(11))
    sync_user_prices(db_session, IntradayFetcher(), me, TODAY, ist(11))
    assert [p.price for p in rows(db_session, inst)] == [INTRADAY]
    run_nightly(db_session, FakeFetcher(), TODAY)
    age(db_session, "stock", 120, ist(17))
    sync_user_prices(db_session, IntradayFetcher(), me, TODAY, ist(17))
    assert [p.price for p in rows(db_session, inst)] == [STOCK_CLOSE]


def test_sync_a_dropped_stock_quote_still_counts_as_fetched(
    db_session: Session, seeded: None
) -> None:
    me = user(db_session, "me@x.com")
    link(db_session, me, "stock", STOCK_CODE, "REL")
    age(db_session, "stock", 120, ist(17))
    sync_user_prices(db_session, IntradayFetcher(), me, TODAY, ist(17))  # dropped: same date, late
    fake = IntradayFetcher()
    sync_user_prices(db_session, fake, me, TODAY, ist(17))
    assert fake.calls["yahoo_chart"] == 0
