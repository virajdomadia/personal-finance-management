"""Net worth snapshots: the nightly write, the dashboard match, and the estimated backfill."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import snapshots
from app.api.routes import dashboard
from app.api.snapshots import (
    backfill,
    month_ends,
    months_back,
    snapshot_all,
    snapshot_date,
    write_snapshot,
)
from app.main import app
from app.models.account import Account
from app.models.investment import Instrument, InvestmentTrade
from app.models.snapshot import NetWorthSnapshot
from app.models.transaction import Transaction
from app.models.user import User
from tests.test_accounts import Headers, auth, make
from tests.test_deposits import ppf
from tests.test_portfolio import price
from tests.test_trades import broker, stock
from tests.test_trades import made as made_trade

client = TestClient(app)
TODAY = date(2026, 11, 13)


def stored(db: Session, user_id: int | None = None) -> list[NetWorthSnapshot]:
    query = select(NetWorthSnapshot).order_by(NetWorthSnapshot.user_id, NetWorthSnapshot.date)
    if user_id is not None:
        query = query.where(NetWorthSnapshot.user_id == user_id)
    db.expire_all()
    return list(db.scalars(query).all())


def user_id(db: Session, email: str = "me@example.com") -> int:
    found = db.scalar(select(User.id).where(User.email == email))
    assert found is not None
    return found


# Dates


@pytest.mark.parametrize(
    ("day", "months", "expected"),
    [
        (date(2026, 11, 13), 1, date(2026, 10, 13)),
        (date(2026, 3, 31), 1, date(2026, 2, 28)),
        (date(2028, 3, 31), 1, date(2028, 2, 29)),
        (date(2026, 1, 15), 1, date(2025, 12, 15)),
        (date(2026, 11, 13), 12, date(2025, 11, 13)),
        (date(2026, 8, 31), 6, date(2026, 2, 28)),
    ],
)
def test_months_back_clamps_to_the_month(day: date, months: int, expected: date) -> None:
    assert months_back(day, months) == expected


def test_month_ends_are_the_twelve_months_before_this_one() -> None:
    ends = month_ends(TODAY, 12)
    assert len(ends) == 12
    assert ends[0] == date(2025, 11, 30)
    assert ends[3] == date(2026, 2, 28)
    assert ends[-1] == date(2026, 10, 31)


# Writing today's snapshot


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    monkeypatch.setattr(dashboard, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def test_snapshot_holds_exactly_the_dashboard_figures(
    headers: Headers, db_session: Session
) -> None:
    make(headers, type="bank", name="SBI", bank_kind="savings", balance="20000.50")
    make(headers, type="credit_card", name="Card", balance="700.25")
    ppf(headers, balance="100000.00")
    broker_id, infy = broker(headers, balance="7000.00"), stock(headers)
    made_trade(headers, stock_id=infy, account_id=broker_id, quantity=10, price="500.00")
    price(headers, infy, "612.35")

    assert write_snapshot(db_session, user_id(db_session), TODAY)
    db_session.commit()
    body = client.get("/api/dashboard", headers=headers).json()
    [row] = stored(db_session)

    assert row.date == TODAY and row.estimated is False
    assert (str(row.net_worth), str(row.total_have), str(row.total_owe)) == (
        body["net_worth"],
        body["total_have"],
        body["total_owe"],
    )
    split = {s["group"]: s["value"] for s in body["asset_split"]}
    assert {
        "bank_cash": str(row.bank_cash),
        "deposits": str(row.deposits),
        "stocks": str(row.stocks),
    } == split
    assert (row.funds, row.crypto) == (Decimal("0.00"), Decimal("0.00"))


def test_writing_the_same_day_twice_replaces_it(headers: Headers, db_session: Session) -> None:
    account = make(headers, type="cash", name="Cash", balance="100.00").json()["id"]
    me = user_id(db_session)
    write_snapshot(db_session, me, TODAY)
    db_session.commit()
    client.patch(f"/api/accounts/{account}", json={"balance": "250.00"}, headers=headers)

    write_snapshot(db_session, me, TODAY)
    db_session.commit()

    [row] = stored(db_session)
    assert row.net_worth == Decimal("250.00")


def test_a_user_with_nothing_gets_no_snapshot(headers: Headers, db_session: Session) -> None:
    assert write_snapshot(db_session, user_id(db_session), TODAY) is False
    assert stored(db_session) == []


def test_negative_bank_cash_is_stored_as_it_is(headers: Headers, db_session: Session) -> None:
    make(headers, type="bank", name="SBI", bank_kind="current", balance="-500.00")
    write_snapshot(db_session, user_id(db_session), TODAY)
    [row] = stored(db_session)
    # The dashboard leaves a negative group out of its bar; the snapshot keeps the figure.
    assert (row.total_have, row.total_owe, row.net_worth, row.bank_cash) == (
        Decimal("-500.00"),
        Decimal("0.00"),
        Decimal("-500.00"),
        Decimal("-500.00"),
    )


def test_snapshot_all_writes_every_user_with_something(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    me = auth(db_session, monkeypatch)
    make(me, type="cash", name="Cash", balance="100.00")
    other = auth(db_session, monkeypatch, "other@example.com")
    make(other, type="cash", name="Cash", balance="5.00")
    auth(db_session, monkeypatch, "empty@example.com")

    assert snapshot_all(db_session, TODAY) == 2
    rows = stored(db_session)
    assert [(r.user_id, r.date, r.net_worth) for r in rows] == [
        (user_id(db_session), TODAY, Decimal("100.00")),
        (user_id(db_session, "other@example.com"), TODAY, Decimal("5.00")),
    ]


def test_a_missed_night_stays_a_gap(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    headers = auth(db_session, monkeypatch)
    make(headers, type="cash", name="Cash", balance="100.00")
    snapshot_all(db_session, date(2026, 11, 10))
    snapshot_all(db_session, date(2026, 11, 13))  # 11 and 12 November were missed
    assert [r.date for r in stored(db_session)] == [date(2026, 11, 10), date(2026, 11, 13)]


def test_one_failing_user_does_not_stop_the_others(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = auth(db_session, monkeypatch)
    make(first, type="cash", name="Cash", balance="100.00")
    second = auth(db_session, monkeypatch, "other@example.com")
    make(second, type="cash", name="Cash", balance="5.00")
    broken = user_id(db_session)
    real = snapshots.write_snapshot

    def flaky(db: Session, uid: int, today: date) -> bool:
        if uid == broken:
            raise RuntimeError("boom")
        return real(db, uid, today)

    monkeypatch.setattr(snapshots, "write_snapshot", flaky)
    assert snapshot_all(db_session, TODAY) == 1
    assert [r.user_id for r in stored(db_session)] == [user_id(db_session, "other@example.com")]


# Backfill: estimated month-ends from transactions


def new_user(db: Session, email: str = "me@example.com") -> int:
    user = User(email=email)
    db.add(user)
    db.commit()
    return user.id


def account(db: Session, uid: int, type_: str, opening: str, added: date, **extra: Any) -> int:
    row = Account(
        user_id=uid,
        type=type_,
        name=type_,
        opening_balance=Decimal(opening),
        created_at=datetime(added.year, added.month, added.day, 6, 0, tzinfo=UTC),
        **extra,
    )
    db.add(row)
    db.commit()
    return row.id


def tx(db: Session, uid: int, type_: str, amount: str, day: date, account_id: int, **extra: Any):
    db.add(
        Transaction(
            user_id=uid,
            type=type_,
            amount=Decimal(amount),
            date=day,
            account_id=account_id,
            **extra,
        )
    )
    db.commit()


def by_date(db: Session, uid: int) -> dict[date, NetWorthSnapshot]:
    return {r.date: r for r in stored(db, uid)}


def test_backfill_replays_balances_to_each_month_end(db_session: Session) -> None:
    uid = new_user(db_session)
    # Added to the app in November with transactions entered back to August.
    bank = account(db_session, uid, "bank", "10000.00", TODAY, bank_kind="savings")
    card = account(db_session, uid, "credit_card", "0.00", TODAY)
    deposit = account(db_session, uid, "ppf", "0.00", TODAY)
    loan = account(db_session, uid, "loan", "50000.00", TODAY)
    tx(db_session, uid, "income", "30000.00", date(2026, 8, 1), bank)
    tx(db_session, uid, "expense", "1200.00", date(2026, 8, 20), card)
    tx(db_session, uid, "transfer", "1200.00", date(2026, 9, 5), bank, to_account_id=card)
    tx(db_session, uid, "transfer", "5000.00", date(2026, 9, 10), bank, to_account_id=deposit)
    tx(
        db_session,
        uid,
        "emi",
        "2000.00",
        date(2026, 10, 5),
        bank,
        to_account_id=loan,
        interest=Decimal("500.00"),
    )

    assert backfill(db_session, uid, TODAY) == 3
    rows = by_date(db_session, uid)
    assert sorted(rows) == [date(2026, 8, 31), date(2026, 9, 30), date(2026, 10, 31)]
    assert all(r.estimated for r in rows.values())

    august = rows[date(2026, 8, 31)]
    # The loan and the PPF have no movement yet in August, so they don't count.
    assert (august.total_have, august.total_owe) == (Decimal("40000.00"), Decimal("1200.00"))
    assert august.net_worth == Decimal("38800.00")

    september = rows[date(2026, 9, 30)]
    assert (september.bank_cash, september.deposits) == (Decimal("33800.00"), Decimal("5000.00"))
    assert (september.total_owe, september.net_worth) == (Decimal("0.00"), Decimal("38800.00"))

    october = rows[date(2026, 10, 31)]
    # The EMI counts the loan from October: 50,000 owed less 1,500 principal.
    assert october.total_have == Decimal("36800.00")
    assert october.total_owe == Decimal("48500.00")
    assert october.net_worth == Decimal("-11700.00")
    assert (october.stocks, october.funds, october.crypto) == (0, 0, 0)


def test_backfill_leaves_investments_out_but_counts_broker_cash(db_session: Session) -> None:
    uid = new_user(db_session)
    broker_id = account(db_session, uid, "broker", "10000.00", date(2026, 9, 1))
    inst = Instrument(user_id=uid, kind="stock", symbol="INFY", name="INFY")
    db_session.add(inst)
    db_session.commit()
    db_session.add(
        InvestmentTrade(
            user_id=uid,
            instrument_id=inst.id,
            account_id=broker_id,
            side="buy",
            date=date(2026, 10, 2),
            quantity=Decimal(4),
            price=Decimal("1000.00"),
            charges=Decimal("0.00"),
            amount=Decimal("4000.00"),
        )
    )
    db_session.commit()

    backfill(db_session, uid, TODAY)
    rows = by_date(db_session, uid)
    assert rows[date(2026, 9, 30)].net_worth == Decimal("10000.00")
    # The shares bought in October aren't counted, so the estimate falls by their cost.
    assert rows[date(2026, 10, 31)].net_worth == Decimal("6000.00")
    assert rows[date(2026, 10, 31)].stocks == Decimal("0.00")


def test_an_account_counts_from_when_it_was_added_without_transactions(
    db_session: Session,
) -> None:
    uid = new_user(db_session)
    account(db_session, uid, "cash", "500.00", date(2026, 6, 15))
    backfill(db_session, uid, TODAY)
    assert sorted(by_date(db_session, uid))[0] == date(2026, 6, 30)


def test_an_archived_account_counts_until_it_was_archived(db_session: Session) -> None:
    uid = new_user(db_session)
    account(db_session, uid, "cash", "500.00", date(2026, 6, 1))
    account(
        db_session,
        uid,
        "wallet",
        "300.00",
        date(2026, 6, 1),
        archived_at=datetime(2026, 9, 2, 10, 0, tzinfo=UTC),
    )
    backfill(db_session, uid, TODAY)
    rows = by_date(db_session, uid)
    assert rows[date(2026, 8, 31)].net_worth == Decimal("800.00")
    assert rows[date(2026, 9, 30)].net_worth == Decimal("500.00")


def test_backfill_stops_at_the_first_real_snapshot_and_never_replaces_one(
    db_session: Session,
) -> None:
    uid = new_user(db_session)
    account(db_session, uid, "cash", "500.00", date(2026, 1, 1))
    db_session.add(
        NetWorthSnapshot(
            user_id=uid,
            date=date(2026, 9, 30),
            net_worth=Decimal("999.00"),
            total_have=Decimal("999.00"),
            total_owe=Decimal("0.00"),
            bank_cash=Decimal("999.00"),
            deposits=Decimal("0.00"),
            stocks=Decimal("0.00"),
            funds=Decimal("0.00"),
            crypto=Decimal("0.00"),
        )
    )
    db_session.commit()

    assert backfill(db_session, uid, TODAY) == 8  # January to August
    rows = by_date(db_session, uid)
    assert max(d for d, r in rows.items() if r.estimated) == date(2026, 8, 31)
    assert rows[date(2026, 9, 30)].net_worth == Decimal("999.00")
    assert rows[date(2026, 9, 30)].estimated is False
    assert date(2026, 10, 31) not in rows


def test_rerunning_the_backfill_replaces_its_own_estimates(db_session: Session) -> None:
    uid = new_user(db_session)
    cash = account(db_session, uid, "cash", "500.00", date(2026, 10, 1))
    backfill(db_session, uid, TODAY)
    tx(db_session, uid, "expense", "100.00", date(2026, 10, 3), cash)

    backfill(db_session, uid, TODAY)
    [row] = stored(db_session, uid)
    assert (row.date, row.net_worth, row.estimated) == (date(2026, 10, 31), Decimal("400.00"), True)


def test_backfill_only_touches_its_own_user(db_session: Session) -> None:
    me, other = new_user(db_session), new_user(db_session, "other@example.com")
    account(db_session, other, "cash", "500.00", date(2026, 10, 1))
    assert backfill(db_session, me, TODAY) == 0
    assert stored(db_session) == []


# The cron's date, and figures that add up


@pytest.mark.parametrize(
    ("moment", "evening"),
    [
        (datetime(2026, 11, 13, 18, 0, tzinfo=UTC), date(2026, 11, 13)),  # 23:30 IST on the 13th
        (datetime(2026, 11, 13, 18, 29, tzinfo=UTC), date(2026, 11, 13)),  # 23:59 IST
        (datetime(2026, 11, 13, 18, 31, tzinfo=UTC), date(2026, 11, 13)),  # 00:01 IST on the 14th
        (datetime(2026, 11, 13, 18, 59, tzinfo=UTC), date(2026, 11, 13)),  # 00:29 IST on the 14th
        (datetime(2026, 12, 31, 18, 45, tzinfo=UTC), date(2026, 12, 31)),  # into the new year
    ],
)
def test_the_nightly_snapshot_is_dated_by_its_evening(moment: datetime, evening: date) -> None:
    assert snapshot_date(moment) == evening


def test_stored_figures_add_up_after_rounding(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.api.worth import Worth

    headers = auth(db_session, monkeypatch)
    make(headers, type="cash", name="Cash", balance="1.00")
    split = {
        "bank_cash": Decimal("0"),
        "deposits": Decimal("0.004"),
        "stocks": Decimal("100.006"),
        "funds": Decimal("0.005"),
        "crypto": Decimal("0"),
    }
    split["bank_cash"] = Decimal("200.0149") - sum(split.values(), Decimal(0))
    worth = Worth(Decimal("200.0149"), Decimal("50.0051"), split, None, None, None, [])  # type: ignore[arg-type]
    monkeypatch.setattr(snapshots, "worth_of", lambda *args: worth)

    write_snapshot(db_session, user_id(db_session), TODAY)
    [row] = stored(db_session)
    assert (row.total_have, row.total_owe, row.net_worth) == (
        Decimal("200.01"),
        Decimal("50.01"),
        Decimal("150.00"),
    )
    parts = row.bank_cash + row.deposits + row.stocks + row.funds + row.crypto
    assert parts == row.total_have
