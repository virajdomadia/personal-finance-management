import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes import cron
from app.core.config import get_settings
from app.main import app
from tests.price_fakes import FakeFetcher
from tests.test_accounts import auth

client = TestClient(app)

URL = "/api/cron/prices"
CRON_SECRET = "cron-secret"


@pytest.fixture
def secret(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr(get_settings(), "token_secret", "test-secret")
    monkeypatch.setattr(get_settings(), "environment", "production")
    monkeypatch.setattr(get_settings(), "cron_secret", CRON_SECRET)
    return CRON_SECRET


def test_cron_no_header_401(secret: str) -> None:
    response = client.get(URL)
    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


def test_cron_wrong_secret_401(secret: str) -> None:
    response = client.get(URL, headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


@pytest.mark.parametrize("header", ["Bearer ", "Bearer", "", "Bearer  "])
def test_cron_secret_unset_always_401(monkeypatch: pytest.MonkeyPatch, header: str) -> None:
    monkeypatch.setattr(get_settings(), "token_secret", "test-secret")
    monkeypatch.setattr(get_settings(), "environment", "production")
    monkeypatch.setattr(get_settings(), "cron_secret", "")
    response = client.get(URL, headers={"Authorization": header})
    assert response.status_code == 401
    assert response.json() == {"detail": "Not authenticated"}


def test_cron_runs_job(secret: str, db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    fetcher = FakeFetcher()
    monkeypatch.setattr(cron, "default_fetcher", lambda: fetcher)
    response = client.get(URL, headers={"Authorization": f"Bearer {secret}"})
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"updated", "failed", "snapshots"}
    assert body["failed"] == {}
    assert body["updated"]["mutual_fund"] > 0
    assert fetcher.calls["navall"] == 1
    assert fetcher.client.is_closed


def test_user_token_is_not_a_cron_secret(
    secret: str, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    headers = auth(db_session, monkeypatch)
    monkeypatch.setattr(get_settings(), "cron_secret", CRON_SECRET)
    response = client.get(URL, headers=headers)
    assert response.status_code == 401


def test_cron_writes_snapshots_after_prices(
    secret: str, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import date
    from decimal import Decimal

    from sqlalchemy import select

    from app.models.account import Account
    from app.models.investment import Instrument, InvestmentTrade
    from app.models.snapshot import NetWorthSnapshot
    from app.models.user import User
    from tests.price_fakes import STOCK_CLOSE, STOCK_CODE

    today = date(2026, 11, 13)
    monkeypatch.setattr(cron, "today_india", lambda: today)
    monkeypatch.setattr(cron, "default_fetcher", lambda: FakeFetcher())
    user = User(email="me@example.com")
    db_session.add(user)
    db_session.commit()
    broker = Account(user_id=user.id, type="broker", name="Zerodha", opening_balance=Decimal(0))
    stock = Instrument(
        user_id=user.id, kind="stock", symbol=STOCK_CODE, name=STOCK_CODE, source_code=STOCK_CODE
    )
    db_session.add_all([broker, stock])
    db_session.commit()
    db_session.add(
        InvestmentTrade(
            user_id=user.id,
            instrument_id=stock.id,
            account_id=broker.id,
            side="buy",
            date=date(2026, 1, 15),
            quantity=Decimal(2),
            price=Decimal("1000.00"),
            charges=Decimal("0.00"),
            amount=Decimal("2000.00"),
            opening=True,
        )
    )
    db_session.commit()

    response = client.get(URL, headers={"Authorization": f"Bearer {secret}"})
    assert response.status_code == 200
    assert response.json()["snapshots"] == 1
    [row] = db_session.scalars(select(NetWorthSnapshot)).all()
    # Valued at tonight's close, which the job applied first, not at cost.
    assert (row.date, row.stocks) == (today, 2 * STOCK_CLOSE)
    assert row.net_worth == 2 * STOCK_CLOSE
