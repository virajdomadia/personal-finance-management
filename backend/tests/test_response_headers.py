import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def secured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "token_secret", "test-secret")
    monkeypatch.setattr(get_settings(), "google_client_id", "web-client")


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/health"),  # public
        ("get", "/api/transactions"),  # 401 from require_token
        ("post", "/api/auth/google"),  # 422, no body
    ],
)
def test_every_response_is_private_and_hardened(method: str, path: str) -> None:
    response = getattr(client, method)(path)
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_oversized_google_token_is_rejected_before_google() -> None:
    response = client.post("/api/auth/google", json={"id_token": "x" * 200_000})
    assert response.status_code == 422


def test_empty_google_token_is_rejected() -> None:
    assert client.post("/api/auth/google", json={"id_token": ""}).status_code == 422
