import hashlib

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.security import create_token, is_valid_token, verify_password
from app.main import app

client = TestClient(app)

PASSWORD = "correct horse"
TOKEN_SECRET = "token-secret"
LOGIN_PATH = "/api/auth/login"
SESSION_PATH = "/api/auth/session"
# A hash of "correct horse" from frontend/scripts/hash-password.mjs: the same stored value
# has to work for both the website and the API.
NODE_HASH = (
    "63e858426f2375273980a24587cd98c0:"
    "f5040219c38780a4e854af873530b8e1fa9b3c16d8bbe1ef472d1af26bebbdf8"
    "664e6b986b5eeb2443b3e4cc6e8711d179d756fe9e3446395f8b7db56cb7e275"
)


def make_hash(password: str, salt: bytes = bytes(range(16))) -> str:
    key = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=64)
    return f"{salt.hex()}:{key.hex()}"


@pytest.fixture(autouse=True)
def production(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "api_secret", "s3cret")
    monkeypatch.setattr(settings, "app_password_hash", make_hash(PASSWORD))
    monkeypatch.setattr(settings, "token_secret", TOKEN_SECRET)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_login_returns_a_token_that_opens_the_api() -> None:
    response = client.post(LOGIN_PATH, json={"password": PASSWORD})

    assert response.status_code == 200
    token = response.json()["token"]
    assert client.get(SESSION_PATH, headers=bearer(token)).status_code == 200


def test_login_rejects_wrong_password() -> None:
    response = client.post(LOGIN_PATH, json={"password": "wrong"})

    assert response.status_code == 401
    assert "token" not in response.json()


@pytest.mark.parametrize("setting", ["app_password_hash", "token_secret"])
def test_login_stays_closed_when_not_configured(
    monkeypatch: pytest.MonkeyPatch, setting: str
) -> None:
    monkeypatch.setattr(get_settings(), setting, "")

    assert client.post(LOGIN_PATH, json={"password": PASSWORD}).status_code == 401


def test_session_requires_credentials() -> None:
    assert client.get(SESSION_PATH).status_code == 401


def test_website_secret_still_works_without_a_token() -> None:
    assert client.get(SESSION_PATH, headers={"X-API-Secret": "s3cret"}).status_code == 200


def test_rejects_token_signed_with_another_secret() -> None:
    token = create_token("other-secret")

    assert client.get(SESSION_PATH, headers=bearer(token)).status_code == 401


def test_token_is_not_accepted_when_secret_is_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    token = create_token("")
    monkeypatch.setattr(get_settings(), "token_secret", "")

    assert client.get(SESSION_PATH, headers=bearer(token)).status_code == 401


@pytest.mark.parametrize(
    "token", ["", "garbage", "1.2.3", "99999999999.AAAA", "é.é", "9" * 5000 + ".AAAA"]
)
def test_malformed_tokens_are_rejected_without_crashing(token: str) -> None:
    assert is_valid_token(token, TOKEN_SECRET) is False


def test_tampered_expiry_is_rejected() -> None:
    expiry, signature = create_token(TOKEN_SECRET, now=1000).split(".")

    assert is_valid_token(f"{int(expiry) + 1}.{signature}", TOKEN_SECRET, now=1000) is False


def test_token_expires_after_thirty_days() -> None:
    thirty_days = 30 * 24 * 60 * 60
    token = create_token(TOKEN_SECRET, now=1000)

    assert is_valid_token(token, TOKEN_SECRET, now=1000 + thirty_days - 1) is True
    assert is_valid_token(token, TOKEN_SECRET, now=1000 + thirty_days) is False


def test_verifies_hash_generated_by_the_website_script() -> None:
    assert verify_password(PASSWORD, NODE_HASH) is True
    assert verify_password("wrong", NODE_HASH) is False


@pytest.mark.parametrize("stored", ["", "nocolon", "a:b:c", "zz:zz", "00:00"])
def test_malformed_password_hash_never_matches(stored: str) -> None:
    assert verify_password(PASSWORD, stored) is False
