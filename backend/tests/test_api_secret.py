from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.main import app

client = TestClient(app)

# Any route other than health must be guarded; openapi.json exists regardless of features.
GUARDED_PATH = "/api/openapi.json"


def configure(monkeypatch: pytest.MonkeyPatch, *, secret: str, environment: str) -> None:
    monkeypatch.setattr(get_settings(), "api_secret", secret)
    monkeypatch.setattr(get_settings(), "environment", environment)


def test_rejects_request_without_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret="s3cret", environment="production")

    assert client.get(GUARDED_PATH).status_code == 401


def test_rejects_wrong_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret="s3cret", environment="production")

    response = client.get(GUARDED_PATH, headers={"X-API-Secret": "wrong"})

    assert response.status_code == 401


def test_rejects_non_ascii_secret_without_crashing(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret="s3cret", environment="production")

    response = client.get(GUARDED_PATH, headers={b"X-API-Secret": "é".encode("latin-1")})

    assert response.status_code == 401


def test_allows_correct_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret="s3cret", environment="production")

    response = client.get(GUARDED_PATH, headers={"X-API-Secret": "s3cret"})

    assert response.status_code == 200


def test_unknown_paths_are_guarded_too(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret="s3cret", environment="production")

    assert client.get("/api/not-a-route").status_code == 401


def test_production_without_configured_secret_stays_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure(monkeypatch, secret="", environment="production")

    assert client.get(GUARDED_PATH).status_code == 401
    assert client.get(GUARDED_PATH, headers={"X-API-Secret": ""}).status_code == 401


def test_development_without_secret_is_open(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret="", environment="development")

    assert client.get(GUARDED_PATH).status_code == 200


def test_health_stays_public_paths_near_it_do_not(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret="s3cret", environment="production")

    def sqlite_session() -> Iterator[Session]:
        with Session(create_engine("sqlite://")) as session:
            yield session

    monkeypatch.setitem(app.dependency_overrides, get_db, sqlite_session)

    assert client.get("/api/health").status_code == 200
    assert client.get("/api/healthz").status_code == 401
