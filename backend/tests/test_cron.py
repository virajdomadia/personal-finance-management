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
    assert set(body) == {"updated", "failed"}
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
