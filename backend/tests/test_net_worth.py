"""GET /api/net-worth: the history, today's live point, the change figures and the first write."""

from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routes import net_worth
from app.main import app
from app.models.snapshot import NetWorthSnapshot
from app.models.user import User
from tests.test_accounts import Headers, auth, make
from tests.test_trades import broker, stock
from tests.test_trades import made as made_trade

client = TestClient(app)
URL = "/api/net-worth"
TODAY = date(2026, 11, 13)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(net_worth, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def me(db: Session, email: str = "me@example.com") -> int:
    found = db.scalar(select(User.id).where(User.email == email))
    assert found is not None
    return found


def get(headers: Headers, **params: str) -> dict[str, Any]:
    response = client.get(URL, headers=headers, params=params)
    assert response.status_code == 200, response.json()
    return response.json()


def change(amount: str, day: str, estimated: bool = False, on_target: bool = True) -> dict:
    return {"amount": amount, "from_date": day, "estimated": estimated, "on_target": on_target}


def snap(db: Session, uid: int, day: date, worth: str, estimated: bool = False) -> None:
    value = Decimal(worth)
    db.add(
        NetWorthSnapshot(
            user_id=uid,
            date=day,
            net_worth=value,
            total_have=value,
            total_owe=Decimal(0),
            bank_cash=value,
            deposits=Decimal(0),
            stocks=Decimal(0),
            funds=Decimal(0),
            crypto=Decimal(0),
            estimated=estimated,
        )
    )
    db.commit()


def rows(db: Session) -> list[tuple[date, Decimal, bool]]:
    db.expire_all()
    return [
        (r.date, r.net_worth, r.estimated)
        for r in db.scalars(select(NetWorthSnapshot).order_by(NetWorthSnapshot.date))
    ]


def test_requires_a_session() -> None:
    assert client.get(URL).status_code == 401


def test_a_user_with_nothing_has_no_history_and_nothing_is_written(
    headers: Headers, db_session: Session
) -> None:
    assert get(headers) == {
        "range": "1y",
        "today": "2026-11-13",
        "points": [],
        "since_last_month": None,
        "since_start": None,
        "tracked_since": None,
    }
    assert rows(db_session) == []


def test_the_first_load_writes_today_once_and_shows_it(
    headers: Headers, db_session: Session
) -> None:
    make(headers, type="bank", name="SBI", bank_kind="savings", balance="1000.00")
    make(headers, type="credit_card", name="Card", balance="250.50")

    body = get(headers)
    assert body["points"] == [
        {
            "date": "2026-11-13",
            "net_worth": "749.50",
            "total_have": "1000.00",
            "total_owe": "250.50",
            "allocation": {
                "bank_cash": "1000.00",
                "deposits": "0.00",
                "stocks": "0.00",
                "funds": "0.00",
                "crypto": "0.00",
            },
            "estimated": False,
        }
    ]
    assert body["since_last_month"] is None and body["since_start"] is None
    assert body["tracked_since"] == "2026-11-13"
    get(headers)
    assert rows(db_session) == [(TODAY, Decimal("749.50"), False)]


def test_today_is_live_even_when_a_snapshot_exists(headers: Headers, db_session: Session) -> None:
    account = make(headers, type="cash", name="Cash", balance="100.00").json()["id"]
    get(headers)  # writes today's snapshot at 100
    client.patch(f"/api/accounts/{account}", json={"balance": "300.00"}, headers=headers)

    body = get(headers)
    assert [p["net_worth"] for p in body["points"]] == ["300.00"]
    # The stored row stays until the nightly job replaces it.
    assert rows(db_session) == [(TODAY, Decimal("100.00"), False)]


def test_an_estimated_row_for_today_is_replaced_by_a_real_one(
    headers: Headers, db_session: Session
) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    snap(db_session, me(db_session), TODAY, "5.00", estimated=True)
    get(headers)
    assert rows(db_session) == [(TODAY, Decimal("100.00"), False)]


@pytest.mark.parametrize(
    ("range_", "first", "on_target"),
    [
        ("3m", "2026-08-13", True),
        ("6m", "2026-05-31", False),
        ("1y", "2025-11-30", False),
        ("all", "2025-06-30", True),
    ],
)
def test_points_follow_the_range(
    headers: Headers, db_session: Session, range_: str, first: str, on_target: bool
) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    uid = me(db_session)
    for day in (
        date(2025, 6, 30),
        date(2025, 11, 12),
        date(2025, 11, 30),
        date(2026, 5, 31),
        date(2026, 8, 12),
        date(2026, 8, 13),
        date(2026, 11, 12),
    ):
        snap(db_session, uid, day, "50.00", estimated=day < date(2026, 8, 1))

    body = get(headers, range=range_)
    assert body["range"] == range_
    assert body["points"][0]["date"] == first
    assert body["points"][-1]["date"] == "2026-11-13"
    dates = [p["date"] for p in body["points"]]
    assert dates == sorted(dates)
    assert body["since_start"] == {
        "amount": "50.00",
        "from_date": first,
        "estimated": first < "2026-08-01",
        "on_target": on_target,
    }
    assert body["tracked_since"] == "2026-08-12"


def test_estimated_points_are_marked(headers: Headers, db_session: Session) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    snap(db_session, me(db_session), date(2026, 10, 31), "40.00", estimated=True)
    points = get(headers)["points"]
    assert [(p["date"], p["estimated"]) for p in points] == [
        ("2026-10-31", True),
        ("2026-11-13", False),
    ]


def test_since_last_month_uses_the_nearest_snapshot(headers: Headers, db_session: Session) -> None:
    make(headers, type="cash", name="Cash", balance="512000.00")
    uid = me(db_session)
    snap(db_session, uid, date(2026, 10, 12), "490000.00")
    snap(db_session, uid, date(2026, 10, 15), "495000.00")
    assert get(headers)["since_last_month"] == change("22000.00", "2026-10-12")


def test_since_last_month_tie_goes_to_the_earlier(headers: Headers, db_session: Session) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    uid = me(db_session)
    snap(db_session, uid, date(2026, 10, 11), "150.00")
    snap(db_session, uid, date(2026, 10, 15), "90.00")
    assert get(headers)["since_last_month"] == change("-50.00", "2026-10-11")


def test_since_last_month_is_null_without_a_snapshot_near_it(
    headers: Headers, db_session: Session
) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    uid = me(db_session)
    snap(db_session, uid, date(2026, 9, 26), "10.00")  # 17 days before 13 October
    snap(db_session, uid, date(2026, 10, 30), "20.00")  # 17 days after
    body = get(headers)
    assert body["since_last_month"] is None
    assert body["since_start"] == change("90.00", "2026-09-26", on_target=False)


def test_since_last_month_falls_back_to_an_estimate(headers: Headers, db_session: Session) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    snap(db_session, me(db_session), date(2026, 9, 30), "60.00", estimated=True)
    assert get(headers)["since_last_month"] == change(
        "40.00", "2026-09-30", estimated=True, on_target=False
    )


def test_a_real_snapshot_wins_over_a_closer_estimate(headers: Headers, db_session: Session) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    uid = me(db_session)
    snap(db_session, uid, date(2026, 10, 13), "10.00", estimated=True)
    snap(db_session, uid, date(2026, 10, 1), "70.00")
    assert get(headers)["since_last_month"] == change("30.00", "2026-10-01", on_target=False)


def holding_stocks(headers: Headers) -> None:
    """Broker cash 5,000 and shares that cost 5,000 (no price, so held at cost)."""
    broker_id, infy = broker(headers, balance="10000.00"), stock(headers)
    made_trade(headers, stock_id=infy, account_id=broker_id, quantity=10, price="500.00")


def test_an_estimate_is_compared_without_investments(headers: Headers, db_session: Session) -> None:
    holding_stocks(headers)  # net worth 10,000, of which 5,000 is shares
    snap(db_session, me(db_session), date(2026, 10, 13), "4000.00", estimated=True)
    body = get(headers)
    # Like with like: 5,000 without the shares against the 4,000 estimate, not 10,000 against it.
    assert body["since_last_month"] == change("1000.00", "2026-10-13", estimated=True)
    assert body["since_start"] == change("1000.00", "2026-10-13", estimated=True, on_target=False)


def test_a_real_snapshot_is_compared_with_investments(
    headers: Headers, db_session: Session
) -> None:
    holding_stocks(headers)
    snap(db_session, me(db_session), date(2026, 10, 13), "4000.00")
    assert get(headers)["since_last_month"] == change("6000.00", "2026-10-13")


@pytest.mark.parametrize(("day", "used"), [(date(2026, 10, 16), True), (date(2026, 10, 17), False)])
def test_last_month_takes_at_most_three_days_after_the_target(
    headers: Headers, db_session: Session, day: date, used: bool
) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    snap(db_session, me(db_session), day, "40.00")
    expected = change("60.00", day.isoformat()) if used else None
    assert get(headers)["since_last_month"] == expected


def test_bad_range_is_422(headers: Headers) -> None:
    assert client.get(URL, headers=headers, params={"range": "2y"}).status_code == 422


def test_other_users_snapshots_never_show(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    make(headers, type="cash", name="Cash", balance="100.00")
    auth(db_session, monkeypatch, "other@example.com")
    snap(db_session, me(db_session, "other@example.com"), date(2026, 10, 13), "1.00")
    body = get(headers)
    assert [p["date"] for p in body["points"]] == ["2026-11-13"]
    assert body["since_last_month"] is None
