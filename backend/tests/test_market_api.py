from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.routes import market
from app.main import app
from app.models.investment import Instrument, InstrumentPrice
from app.models.market import MarketCode
from app.models.user import User
from app.prices import refresh
from app.prices.refresh import refresh_market
from tests.price_fakes import (
    COIN_ID,
    COIN_PRICE,
    FUND_CODE,
    FUND_DATE,
    FUND_NAV,
    STOCK_CLOSE,
    STOCK_CODE,
    FakeFetcher,
)
from tests.test_accounts import Headers, auth, locs
from tests.test_coins import add_coin, add_coin_price, coin_list
from tests.test_funds import add_fund, add_nav
from tests.test_stocks import add_price, add_stock, stocks

client = TestClient(app)

URL = "/api/investments"
TODAY = date(2026, 11, 12)
PICK = "Pick a match from the search."


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(market, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


@pytest.fixture
def seeded(db_session: Session) -> None:
    """The fund and stock listings, as the nightly job leaves them."""
    refresh_market(db_session, FakeFetcher(), TODAY, kinds={"mutual_fund", "stock"})
    db_session.commit()


@pytest.fixture
def fetcher(monkeypatch: pytest.MonkeyPatch) -> FakeFetcher:
    fake = FakeFetcher()
    monkeypatch.setattr(market, "default_fetcher", lambda: fake)
    return fake


def search(headers: Headers, kind: str, q: str) -> Any:
    return client.get(f"{URL}/market-codes", params={"kind": kind, "q": q}, headers=headers)


def link(headers: Headers, route: str, id: int, code: Any) -> Any:
    return client.patch(f"{URL}/{route}/{id}", json={"source_code": code}, headers=headers)


def fund_navs(headers: Headers, fund_id: int) -> list[dict[str, Any]]:
    return client.get(f"{URL}/funds/{fund_id}/navs", headers=headers).json()["navs"]


def test_search_funds_by_name(headers: Headers, seeded: None) -> None:
    response = search(headers, "mutual_fund", "psu debt fund  - direct")
    assert response.status_code == 200
    results = response.json()["results"]
    assert [r["code"] for r in results] == [FUND_CODE]
    assert results[0] == {
        "code": FUND_CODE,
        "name": "Aditya Birla Sun Life Banking & PSU Debt Fund  - DIRECT - IDCW",
        "isin": "INF209KA12Z1",
        "price": "101.2345",
        "price_date": FUND_DATE.isoformat(),
    }


def test_search_ranks_exact_code_then_prefix_then_contains(
    headers: Headers, db_session: Session
) -> None:
    rows = [("AAA", "Zeta Alpha"), ("ALP", "Beta"), ("ZZZ", "Alpha Two"), ("YYY", "Alpha")]
    db_session.add_all(MarketCode(kind="stock", code=c, name=n) for c, n in rows)
    db_session.commit()
    results = search(headers, "stock", "alp").json()["results"]
    assert [r["code"] for r in results] == ["ALP", "YYY", "ZZZ", "AAA"]


def test_search_is_limited_to_twenty(headers: Headers, db_session: Session) -> None:
    db_session.add_all(
        MarketCode(kind="stock", code=f"S{n:02}", name=f"Stock {n}") for n in range(30)
    )
    db_session.commit()
    assert len(search(headers, "stock", "stock").json()["results"]) == 20


def test_search_treats_wildcards_literally(headers: Headers, seeded: None) -> None:
    assert search(headers, "stock", "%%").json() == {"results": []}


@pytest.mark.parametrize("q", ["", "a", " b "])
def test_search_needs_two_chars(
    headers: Headers, seeded: None, fetcher: FakeFetcher, q: str
) -> None:
    for kind in ("mutual_fund", "stock", "crypto"):
        assert search(headers, kind, q).json() == {"results": []}
    assert fetcher.calls["coin_search"] == 0


def test_search_bad_kind_422(headers: Headers) -> None:
    assert search(headers, "gold", "ab").status_code == 422


def test_search_needs_login(db_session: Session) -> None:
    assert client.get(f"{URL}/market-codes?kind=stock&q=ab").status_code == 401


def test_search_coins_is_live_and_remembered(
    headers: Headers, db_session: Session, fetcher: FakeFetcher
) -> None:
    results = search(headers, "crypto", "bitcoin").json()["results"]
    assert [r["code"] for r in results] == ["bitcoin", "bitcoin-cash"]
    assert results[0] == {
        "code": "bitcoin",
        "name": "Bitcoin (BTC)",
        "isin": None,
        "price": None,
        "price_date": None,
    }
    codes = db_session.scalars(select(MarketCode.code).where(MarketCode.kind == "crypto")).all()
    assert sorted(codes) == ["bitcoin", "bitcoin-cash"]
    # Searching again keeps what is stored, including a price.
    db_session.execute(update(MarketCode).where(MarketCode.code == "bitcoin").values(price=5))
    db_session.commit()
    assert search(headers, "crypto", "bitcoin").json()["results"][0]["price"] == "5.0000"


def test_search_coins_source_down_503(headers: Headers, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(market, "default_fetcher", lambda: FakeFetcher(fail={"coin_search"}))
    response = search(headers, "crypto", "bitcoin")
    assert response.status_code == 503
    assert response.json() == {"detail": "Couldn't search coins right now."}


def test_link_unknown_code_422(headers: Headers, seeded: None) -> None:
    stock = add_stock(headers).json()["id"]
    response = link(headers, "stocks", stock, "NOPE")
    assert response.status_code == 422
    assert locs(response) == [["body", "source_code"]]
    assert response.json()["detail"][0]["msg"] == PICK
    assert stocks(headers)[0]["source_code"] is None


def test_link_code_of_another_kind_422(headers: Headers, seeded: None) -> None:
    stock = add_stock(headers).json()["id"]
    assert link(headers, "stocks", stock, FUND_CODE).status_code == 422
    fund = add_fund(headers).json()["id"]
    assert link(headers, "funds", fund, STOCK_CODE).status_code == 422
    coin = add_coin(headers).json()["id"]
    assert link(headers, "coins", coin, STOCK_CODE).status_code == 422


def test_link_non_text_or_long_code_422(headers: Headers, seeded: None) -> None:
    stock = add_stock(headers).json()["id"]
    assert link(headers, "stocks", stock, 12).status_code == 422
    assert link(headers, "stocks", stock, "X" * 41).status_code == 422


def test_link_writes_price_immediately(headers: Headers, seeded: None) -> None:
    fund = add_fund(headers).json()["id"]
    response = link(headers, "funds", fund, FUND_CODE)
    assert response.status_code == 200
    body = response.json()
    assert body["source_code"] == FUND_CODE
    assert (body["nav"], body["nav_date"]) == (f"{FUND_NAV}", FUND_DATE.isoformat())
    assert [n["source"] for n in fund_navs(headers, fund)] == ["auto"]

    stock = add_stock(headers).json()["id"]
    body = link(headers, "stocks", stock, STOCK_CODE).json()
    assert body["price"] == f"{STOCK_CLOSE}" and body["source_code"] == STOCK_CODE


def test_create_can_link_at_once(headers: Headers, seeded: None) -> None:
    response = client.post(
        f"{URL}/stocks",
        json={"symbol": "RELI", "name": "Reliance", "source_code": STOCK_CODE},
        headers=headers,
    )
    assert response.status_code == 201
    assert response.json()["source_code"] == STOCK_CODE
    assert response.json()["price"] == f"{STOCK_CLOSE}"
    fund = client.post(
        f"{URL}/funds", json={"name": "Banking", "source_code": FUND_CODE}, headers=headers
    )
    assert fund.status_code == 201 and fund.json()["nav"] == f"{FUND_NAV}"
    bad = client.post(
        f"{URL}/funds", json={"name": "Banking", "source_code": "NOPE"}, headers=headers
    )
    assert bad.status_code == 422 and locs(bad) == [["body", "source_code"]]


def test_blank_source_code_means_none(headers: Headers, seeded: None) -> None:
    response = client.post(
        f"{URL}/stocks",
        json={"symbol": "RELI", "name": "Reliance", "source_code": "  "},
        headers=headers,
    )
    assert response.status_code == 201 and response.json()["source_code"] is None


def test_other_edits_leave_the_link_alone(headers: Headers, seeded: None) -> None:
    stock = add_stock(headers).json()["id"]
    link(headers, "stocks", stock, STOCK_CODE)
    renamed = client.patch(f"{URL}/stocks/{stock}", json={"name": "New"}, headers=headers)
    assert renamed.json()["source_code"] == STOCK_CODE


def test_unlink_keeps_existing_prices(headers: Headers, seeded: None) -> None:
    fund = add_fund(headers).json()["id"]
    link(headers, "funds", fund, FUND_CODE)
    response = link(headers, "funds", fund, None)
    assert response.status_code == 200
    assert response.json()["source_code"] is None
    assert response.json()["nav"] == f"{FUND_NAV}"
    assert [n["source"] for n in fund_navs(headers, fund)] == ["auto"]


def test_price_list_shows_source(headers: Headers, seeded: None) -> None:
    stock = add_stock(headers).json()["id"]
    manual = add_price(headers, stock, "2026-11-01", "100")
    assert manual.json()["source"] == "manual"
    link(headers, "stocks", stock, STOCK_CODE)
    rows = client.get(f"{URL}/stocks/{stock}/prices", headers=headers).json()["prices"]
    assert [(p["date"], p["source"]) for p in rows] == [
        ("2026-11-11", "auto"),
        ("2026-11-01", "manual"),
    ]

    fund = add_fund(headers).json()["id"]
    assert add_nav(headers, fund, "2026-11-01", "80").json()["source"] == "manual"
    coin = add_coin(headers).json()["id"]
    assert add_coin_price(headers, coin, "2026-11-01", "5").json()["source"] == "manual"
    coin_rows = client.get(f"{URL}/coins/{coin}/prices", headers=headers).json()["prices"]
    assert [p["source"] for p in coin_rows] == ["manual"]


def test_manual_price_on_the_same_day_wins(headers: Headers, seeded: None) -> None:
    fund = add_fund(headers).json()["id"]
    add_nav(headers, fund, FUND_DATE.isoformat(), "50")
    link(headers, "funds", fund, FUND_CODE)
    assert [(n["nav"], n["source"]) for n in fund_navs(headers, fund)] == [("50.0000", "manual")]


def link_bitcoin(headers: Headers) -> int:
    assert search(headers, "crypto", "bitcoin").status_code == 200
    coin = add_coin(headers).json()["id"]
    assert link(headers, "coins", coin, COIN_ID).status_code == 200
    return coin


def test_coins_refresh_prices_unpriced_coin_then_skips_when_fresh(
    headers: Headers, fetcher: FakeFetcher
) -> None:
    coin = link_bitcoin(headers)
    assert coin_list(headers)[0]["price"] is None
    assert client.post(f"{URL}/coins/refresh", headers=headers).json() == {"refreshed": True}
    assert fetcher.calls["simple_price"] == 1
    row = coin_list(headers)[0]
    assert (row["price"], row["price_date"]) == (f"{COIN_PRICE:.4f}", TODAY.isoformat())
    prices = client.get(f"{URL}/coins/{coin}/prices", headers=headers).json()["prices"]
    assert [p["source"] for p in prices] == ["auto"]

    assert client.post(f"{URL}/coins/refresh", headers=headers).json() == {"refreshed": False}
    assert fetcher.calls["simple_price"] == 1


def test_coins_refresh_when_stale(
    headers: Headers, db_session: Session, fetcher: FakeFetcher
) -> None:
    link_bitcoin(headers)
    client.post(f"{URL}/coins/refresh", headers=headers)
    old = datetime.now(UTC) - timedelta(hours=7)
    db_session.execute(update(MarketCode).where(MarketCode.code == COIN_ID).values(updated_at=old))
    db_session.commit()
    assert client.post(f"{URL}/coins/refresh", headers=headers).json() == {"refreshed": True}
    assert fetcher.calls["simple_price"] == 2


def test_coins_refresh_without_linked_coins_does_nothing(
    headers: Headers, fetcher: FakeFetcher
) -> None:
    add_coin(headers)
    assert client.post(f"{URL}/coins/refresh", headers=headers).json() == {"refreshed": False}
    assert sum(fetcher.calls.values()) == 0


def test_coins_refresh_source_down_is_200_false(
    headers: Headers, fetcher: FakeFetcher, monkeypatch: pytest.MonkeyPatch
) -> None:
    link_bitcoin(headers)
    monkeypatch.setattr(market, "default_fetcher", lambda: FakeFetcher(fail={"simple_price"}))
    response = client.post(f"{URL}/coins/refresh", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"refreshed": False}
    assert coin_list(headers)[0]["price"] is None


def test_coins_refresh_crash_is_200_false(
    headers: Headers, fetcher: FakeFetcher, monkeypatch: pytest.MonkeyPatch
) -> None:
    link_bitcoin(headers)
    monkeypatch.setattr(market, "default_fetcher", lambda: FakeFetcher(crash={"simple_price"}))
    response = client.post(f"{URL}/coins/refresh", headers=headers)
    assert response.status_code == 200 and response.json() == {"refreshed": False}


def test_unlinked_lists_only_unlinked(headers: Headers, seeded: None) -> None:
    linked = add_stock(headers, "RELIANCE", "Reliance").json()["id"]
    link(headers, "stocks", linked, STOCK_CODE)
    open_stock = add_stock(headers, "INFY", "Infosys").json()
    open_fund = add_fund(headers, "Some fund").json()
    open_coin = add_coin(headers).json()
    body = client.get(f"{URL}/unlinked", headers=headers).json()
    assert body == {
        "stocks": [{"id": open_stock["id"], "symbol": "INFY", "name": "Infosys"}],
        "funds": [{"id": open_fund["id"], "symbol": open_fund["symbol"], "name": "Some fund"}],
        "coins": [{"id": open_coin["id"], "symbol": "BTC", "name": "Bitcoin"}],
    }


def test_unlinked_is_per_user(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_stock(headers, "INFY", "Infosys")
    other = auth(db_session, monkeypatch, "other@example.com")
    assert client.get(f"{URL}/unlinked", headers=other).json() == {
        "stocks": [],
        "funds": [],
        "coins": [],
    }


def test_cannot_link_other_users_instrument(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch, seeded: None
) -> None:
    stock = add_stock(headers).json()["id"]
    fund = add_fund(headers).json()["id"]
    coin = add_coin(headers).json()["id"]
    other = auth(db_session, monkeypatch, "other@example.com")
    assert link(other, "stocks", stock, STOCK_CODE).status_code == 404
    assert link(other, "funds", fund, FUND_CODE).status_code == 404
    assert link(other, "coins", coin, None).status_code == 404
    assert stocks(headers)[0]["source_code"] is None


def test_search_coins_crash_is_503(headers: Headers, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(market, "default_fetcher", lambda: FakeFetcher(crash={"coin_search"}))
    response = search(headers, "crypto", "bitcoin")
    assert response.status_code == 503
    assert response.json() == {"detail": "Couldn't search coins right now."}


def test_search_query_over_60_chars_422(headers: Headers, fetcher: FakeFetcher) -> None:
    assert search(headers, "stock", "a" * 60).status_code == 200
    response = search(headers, "crypto", "a" * 61)
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["query", "q"]
    assert fetcher.calls["coin_search"] == 0


def test_linked_stock_and_fund_can_be_deleted(headers: Headers, seeded: None) -> None:
    stock = add_stock(headers).json()["id"]
    link(headers, "stocks", stock, STOCK_CODE)
    assert client.get(f"{URL}/stocks/{stock}/prices", headers=headers).json()["prices"]
    assert client.delete(f"{URL}/stocks/{stock}", headers=headers).status_code == 200
    assert stocks(headers) == []
    fund = add_fund(headers).json()["id"]
    link(headers, "funds", fund, FUND_CODE)
    assert client.delete(f"{URL}/funds/{fund}", headers=headers).status_code == 200


def test_delete_still_refuses_manual_prices_on_linked_holdings(
    headers: Headers, seeded: None
) -> None:
    stock = add_stock(headers).json()["id"]
    add_price(headers, stock, "2026-11-01", "100")
    link(headers, "stocks", stock, STOCK_CODE)
    assert client.delete(f"{URL}/stocks/{stock}", headers=headers).status_code == 409
    fund = add_fund(headers).json()["id"]
    add_nav(headers, fund, "2026-11-01", "80")
    link(headers, "funds", fund, FUND_CODE)
    assert client.delete(f"{URL}/funds/{fund}", headers=headers).status_code == 409
    assert len(fund_navs(headers, fund)) == 2  # the refusal leaves the auto NAV alone


def test_linking_writes_prices_only_for_the_current_user(
    headers: Headers, db_session: Session, seeded: None
) -> None:
    owner = db_session.scalar(select(User).where(User.email == "other@example.com"))
    if owner is None:
        owner = User(email="other@example.com")
        db_session.add(owner)
        db_session.commit()
    theirs = Instrument(
        user_id=owner.id, kind="mutual_fund", symbol="F", name="F", source_code=FUND_CODE
    )
    db_session.add(theirs)
    db_session.commit()

    fund = add_fund(headers).json()["id"]
    assert link(headers, "funds", fund, FUND_CODE).status_code == 200

    assert len(fund_navs(headers, fund)) == 1
    their_rows = db_session.scalars(
        select(InstrumentPrice).where(InstrumentPrice.instrument_id == theirs.id)
    ).all()
    assert their_rows == []


def test_relinking_to_another_code_drops_the_old_auto_prices(
    headers: Headers, db_session: Session, seeded: None
) -> None:
    db_session.add(
        MarketCode(kind="stock", code="TCS2", name="TCS two", price=Decimal("50"), price_date=TODAY)
    )
    db_session.commit()
    stock = add_stock(headers).json()["id"]
    manual = add_price(headers, stock, "2026-11-01", "100").json()
    link(headers, "stocks", stock, STOCK_CODE)

    assert link(headers, "stocks", stock, "TCS2").status_code == 200

    rows = client.get(f"{URL}/stocks/{stock}/prices", headers=headers).json()["prices"]
    assert [(p["date"], p["price"], p["source"]) for p in rows] == [
        (TODAY.isoformat(), "50.00", "auto"),
        (manual["date"], manual["price"], "manual"),
    ]
    # Linking to the same code again, or unlinking, keeps what is there.
    link(headers, "stocks", stock, "TCS2")
    link(headers, "stocks", stock, None)
    after = client.get(f"{URL}/stocks/{stock}/prices", headers=headers).json()["prices"]
    assert after == rows


def test_relinking_a_fund_or_coin_drops_the_old_auto_prices(
    headers: Headers, db_session: Session, seeded: None, fetcher: FakeFetcher
) -> None:
    db_session.add(
        MarketCode(
            kind="mutual_fund", code="999999", name="Other", price=Decimal("10"), price_date=TODAY
        )
    )
    db_session.commit()
    fund = add_fund(headers).json()["id"]
    link(headers, "funds", fund, FUND_CODE)
    assert link(headers, "funds", fund, "999999").status_code == 200
    assert [(n["date"], n["nav"], n["source"]) for n in fund_navs(headers, fund)] == [
        (TODAY.isoformat(), "10.0000", "auto")
    ]

    coin = link_bitcoin(headers)
    client.post(f"{URL}/coins/refresh", headers=headers)
    assert link(headers, "coins", coin, "bitcoin-cash").status_code == 200
    assert client.get(f"{URL}/coins/{coin}/prices", headers=headers).json()["prices"] == []


def test_concurrent_coin_search_conflict_is_retried(
    headers: Headers, db_session: Session, fetcher: FakeFetcher, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Another search saved bitcoin a moment ago, after this one looked at what was stored.
    db_session.add(MarketCode(kind="crypto", code="bitcoin", name="Bitcoin (BTC)"))
    db_session.commit()
    real = refresh._existing
    stale = iter([True])

    def existing(db: Session, kind: str) -> dict[str, MarketCode]:
        return {} if next(stale, False) else real(db, kind)

    monkeypatch.setattr(refresh, "_existing", existing)

    response = search(headers, "crypto", "bitcoin")

    assert response.status_code == 200
    assert [r["code"] for r in response.json()["results"]] == ["bitcoin", "bitcoin-cash"]
    codes = db_session.scalars(select(MarketCode.code).where(MarketCode.kind == "crypto")).all()
    assert sorted(codes) == ["bitcoin", "bitcoin-cash"]


def test_routes_close_the_fetcher(
    headers: Headers, fetcher: FakeFetcher, monkeypatch: pytest.MonkeyPatch
) -> None:
    link_bitcoin(headers)
    assert fetcher.client.is_closed
    fresh = FakeFetcher()
    monkeypatch.setattr(market, "default_fetcher", lambda: fresh)
    client.post(f"{URL}/coins/refresh", headers=headers)
    assert fresh.calls["simple_price"] == 1 and fresh.client.is_closed
