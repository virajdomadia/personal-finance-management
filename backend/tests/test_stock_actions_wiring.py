"""Applied corporate actions reach holdings, trade checks, net worth and goals."""

from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.portfolio import load_action_rows
from app.api.routes import accounts, dashboard, goals, net_worth, transactions
from app.main import app
from app.models.corporate_action import StockAction
from app.models.goal import GoalHolding
from app.models.investment import Instrument, InvestmentTrade
from app.models.user import User
from tests.test_accounts import Headers, auth
from tests.test_portfolio import portfolio, price
from tests.test_trades import URL, broker, made, stock, trade

client = TestClient(app)
TODAY = date(2026, 11, 13)
EX = date(2026, 3, 1)


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    for module in (accounts, dashboard, goals, net_worth, transactions):
        monkeypatch.setattr(module, "today_india", lambda: TODAY)
    return auth(db_session, monkeypatch)


def me(db: Session) -> int:
    return db.scalars(select(User).where(User.email == "me@example.com")).one().id


def split(db: Session, stock_id: int, status: str = "applied", **fields) -> StockAction:
    action = StockAction(
        user_id=me(db),
        instrument_id=stock_id,
        kind="split",
        ex_date=EX,
        ratio_new=Decimal(5),
        ratio_old=Decimal(1),
        status=status,
        **fields,
    )
    db.add(action)
    db.commit()
    return action


def setup(headers: Headers, db: Session, qty: int = 40) -> tuple[int, int]:
    account, infy = broker(headers), stock(headers)
    made(headers, stock_id=infy, account_id=account, quantity=qty, price="100.00")
    return account, infy


def test_load_action_rows_returns_applied_only(headers: Headers, db_session: Session) -> None:
    _, infy = setup(headers, db_session)
    applied = split(db_session, infy)
    split(db_session, infy, status="pending")
    split(db_session, infy, status="dismissed")
    rows = load_action_rows(db_session, me(db_session))
    assert [r.id for r in rows] == [applied.id]
    assert rows[0].ratio_new == Decimal(5)


def test_applied_split_shows_in_holdings(headers: Headers, db_session: Session) -> None:
    _, infy = setup(headers, db_session)
    split(db_session, infy)
    holding = portfolio(headers)["holdings"][0]
    assert holding["shares"] == 200
    assert holding["invested"] == "4000.00"


def test_pending_split_changes_nothing(headers: Headers, db_session: Session) -> None:
    _, infy = setup(headers, db_session)
    split(db_session, infy, status="pending")
    assert portfolio(headers)["holdings"][0]["shares"] == 40


def test_sell_beyond_pre_split_quantity_allowed_after_split(
    headers: Headers, db_session: Session
) -> None:
    account, infy = setup(headers, db_session)
    split(db_session, infy)
    sold = trade(
        headers, stock_id=infy, account_id=account, side="sell", date="2026-04-01", quantity=150
    )
    assert sold.status_code == 201, sold.json()
    assert portfolio(headers)["holdings"][0]["shares"] == 50


def test_sell_beyond_quantity_refused_without_split(headers: Headers, db_session: Session) -> None:
    account, infy = setup(headers, db_session)
    sold = trade(
        headers, stock_id=infy, account_id=account, side="sell", date="2026-04-01", quantity=150
    )
    assert sold.status_code == 422


def test_deleting_buy_that_leaves_post_split_sell_short_is_refused(
    headers: Headers, db_session: Session
) -> None:
    account, infy = setup(headers, db_session)
    split(db_session, infy)
    # A second buy before the ex-date: 40 more shares, 200 more after the split.
    extra = made(headers, stock_id=infy, account_id=account, quantity=40, price="100.00")
    made(headers, stock_id=infy, account_id=account, side="sell", date="2026-04-01", quantity=300)
    response = client.delete(f"{URL}/{extra['id']}", headers=headers)
    assert response.status_code == 409, response.json()
    assert "INFY" in response.json()["detail"]
    assert "1 Apr 2026" in response.json()["detail"]


def test_net_worth_and_goals_use_applied_actions(headers: Headers, db_session: Session) -> None:
    _, infy = setup(headers, db_session)
    price(headers, infy, "10.00", day="2026-11-01")
    goal_id = client.post(
        "/api/goals",
        json={"name": "Bike", "kind": "custom", "target_amount": "120000.00"},
        headers=headers,
    ).json()["id"]
    db_session.add(GoalHolding(user_id=me(db_session), goal_id=goal_id, instrument_id=infy))
    db_session.commit()

    def worth_stocks() -> str:
        body = client.get("/api/net-worth", headers=headers).json()
        return body["points"][-1]["allocation"]["stocks"]

    assert worth_stocks() == "400.00"
    before = client.get(f"/api/goals/{goal_id}", headers=headers).json()
    assert before["holdings_value"] == "400.00"

    split(db_session, infy)
    assert worth_stocks() == "2000.00"
    after = client.get(f"/api/goals/{goal_id}", headers=headers).json()
    assert after["holdings_value"] == "2000.00"


def test_merger_target_without_trades_is_listed(headers: Headers, db_session: Session) -> None:
    account, infy = setup(headers, db_session)
    target = Instrument(user_id=me(db_session), kind="stock", symbol="NEWCO", name="NewCo")
    db_session.add(target)
    db_session.commit()
    db_session.add(
        StockAction(
            user_id=me(db_session),
            instrument_id=infy,
            kind="merger",
            ex_date=EX,
            ratio_new=Decimal(1),
            ratio_old=Decimal(2),
            status="applied",
            target_instrument_id=target.id,
        )
    )
    db_session.commit()
    body = portfolio(headers)
    assert [(h["symbol"], h["shares"], h["account_id"]) for h in body["holdings"]] == [
        ("NEWCO", 20, account)
    ]
    assert client.get("/api/net-worth", headers=headers).status_code == 200


def test_normal_buy_entered_late_is_adjusted_but_opening_is_not(
    headers: Headers, db_session: Session
) -> None:
    account, infy = broker(headers), stock(headers)
    # Both are entered today (after the ex-date) but dated before it.
    made(headers, stock_id=infy, account_id=account, quantity=40, price="100.00")
    split(db_session, infy)
    assert portfolio(headers)["holdings"][0]["shares"] == 200
    other = stock(headers, "TCS")
    made(headers, stock_id=other, account_id=account, quantity=40, price="100.00", opening=True)
    split(db_session, other)
    shares = {h["symbol"]: h["shares"] for h in portfolio(headers)["holdings"]}
    assert shares == {"INFY": 200, "TCS": 40}


def test_editing_opening_trade_checks_with_its_new_basis_date(
    headers: Headers, db_session: Session
) -> None:
    account, infy = broker(headers), stock(headers)
    opening = made(
        headers, stock_id=infy, account_id=account, quantity=40, price="100.00", opening=True
    )
    split(db_session, infy)  # the opening shares were entered today, so the split skips them
    sell = dict(stock_id=infy, account_id=account, side="sell", date="2026-04-01")
    assert trade(headers, **sell, quantity=150).status_code == 422
    # Charges don't change quantity or price, so the basis date stays and nothing is adjusted.
    edit = client.patch(f"{URL}/{opening['id']}", json={"charges": "5.00"}, headers=headers)
    assert edit.status_code == 200, edit.json()
    assert trade(headers, **sell, quantity=150).status_code == 422
    # Changing the quantity re-stamps the basis date to today; still after the ex-date.
    edit = client.patch(f"{URL}/{opening['id']}", json={"quantity": 41}, headers=headers)
    assert edit.status_code == 200, edit.json()
    assert portfolio(headers)["holdings"][0]["shares"] == 41
    assert trade(headers, **sell, quantity=41).status_code == 201


def test_normal_trade_toggled_to_opening_is_checked_and_replayed_alike(
    headers: Headers, db_session: Session
) -> None:
    account, infy = broker(headers), stock(headers)
    normal = made(headers, stock_id=infy, account_id=account, quantity=40, price="100.00")
    row = db_session.get(InvestmentTrade, normal["id"])
    row.basis_date = date(2026, 1, 1)  # created before the ex-date
    db_session.commit()
    split(db_session, infy)
    assert portfolio(headers)["holdings"][0]["shares"] == 200
    sell = dict(stock_id=infy, account_id=account, side="sell", date="2026-04-01")
    # Marking it opening counts the shares as entered today: the split no longer touches them.
    # (The API can't change `opening`, so toggle it on the row, as a future edit path would.)
    row.opening = True
    db_session.commit()
    assert row.basis_date > EX
    assert portfolio(headers)["holdings"][0]["shares"] == 40
    assert trade(headers, **sell, quantity=41).status_code == 422
    assert trade(headers, **sell, quantity=40).status_code == 201
