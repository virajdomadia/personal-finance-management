import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import TOKEN_MAX_AGE_SECONDS, create_token, parse_token
from app.main import app
from app.models.user import User

client = TestClient(app)

SESSION = "/api/auth/session"
SECRET = "test-secret"


def configure(monkeypatch: pytest.MonkeyPatch, *, secret: str, environment: str) -> None:
    monkeypatch.setattr(get_settings(), "token_secret", secret)
    monkeypatch.setattr(get_settings(), "environment", environment)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def add_user(db: Session, email: str = "me@example.com") -> User:
    user = User(email=email)
    db.add(user)
    db.commit()
    return user


def test_health_and_google_login_are_the_only_public_routes(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, secret=SECRET, environment="production")

    assert client.get("/api/health").status_code == 200
    # Reaches the route (422 for the missing body) instead of being stopped by the middleware.
    assert client.post("/api/auth/google").status_code == 422
    for path in (SESSION, "/api/openapi.json", "/api/docs"):
        assert client.get(path).status_code == 401


def test_unknown_paths_are_guarded(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret=SECRET, environment="production")

    assert client.get("/api/not-a-route").status_code == 401


def test_valid_token_reaches_session(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, secret=SECRET, environment="production")
    user = add_user(db_session)

    response = client.get(SESSION, headers=bearer(create_token(user.id, 1, SECRET)))

    assert response.status_code == 200
    assert response.json() == {"email": "me@example.com"}


def test_old_api_secret_header_is_no_longer_accepted(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, secret=SECRET, environment="production")
    monkeypatch.setenv("API_SECRET", "old")

    assert client.get(SESSION, headers={"X-API-Secret": "old"}).status_code == 401


def test_production_without_token_secret_stays_closed(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, secret="", environment="production")
    add_user(db_session)

    assert client.get(SESSION).status_code == 401
    assert client.get(SESSION, headers=bearer(create_token(1, 1, ""))).status_code == 401
    assert client.get("/api/health").status_code == 200


def test_development_without_token_secret_uses_first_user(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, secret="", environment="development")

    assert client.get(SESSION).status_code == 401  # no users yet
    add_user(db_session, "first@example.com")
    add_user(db_session, "second@example.com")

    response = client.get(SESSION, headers=bearer("ignored"))

    assert response.status_code == 200
    assert response.json() == {"email": "first@example.com"}


def test_development_with_token_secret_requires_a_token(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, secret=SECRET, environment="development")
    add_user(db_session)

    assert client.get(SESSION).status_code == 401


def test_token_for_a_deleted_user_is_rejected(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, secret=SECRET, environment="production")

    assert client.get(SESSION, headers=bearer(create_token(99, 1, SECRET))).status_code == 401


def test_token_with_old_session_version_is_rejected(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure(monkeypatch, secret=SECRET, environment="production")
    user = add_user(db_session)
    token = create_token(user.id, 1, SECRET)
    user.session_version = 2
    db_session.commit()

    assert client.get(SESSION, headers=bearer(token)).status_code == 401


@pytest.mark.parametrize("token", ["", "garbage", "a.b.c.d", "é.é.é.é", "9" * 5000])
def test_malformed_tokens_do_not_crash(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, token: str
) -> None:
    configure(monkeypatch, secret=SECRET, environment="production")
    huge = "9" * 5000

    assert parse_token(token, SECRET) is None
    assert parse_token(f"1.1.{huge}.x", SECRET) is None
    assert parse_token(f"{huge}.1.1.x", SECRET) is None
    header = b"Bearer " + token.encode("latin-1", errors="replace")
    assert client.get(SESSION, headers={b"Authorization": header}).status_code == 401


def test_tampered_token_is_rejected() -> None:
    token = create_token(1, 1, SECRET, now=1000)
    user_id, version, expiry, signature = token.split(".")

    assert parse_token(token, SECRET, now=1000) is not None
    assert parse_token(f"2.{version}.{expiry}.{signature}", SECRET, now=1000) is None
    assert (
        parse_token(f"{user_id}.{version}.{int(expiry) + 1}.{signature}", SECRET, now=1000) is None
    )
    assert parse_token(token, "other-secret", now=1000) is None
    assert parse_token(token, "", now=1000) is None


def test_token_expires_after_thirty_days() -> None:
    token = create_token(1, 1, SECRET, now=1000)

    claims = parse_token(token, SECRET, now=1000 + TOKEN_MAX_AGE_SECONDS - 1)
    assert claims is not None
    assert (claims.user_id, claims.session_version) == (1, 1)
    assert claims.expires_at == 1000 + TOKEN_MAX_AGE_SECONDS
    assert parse_token(token, SECRET, now=1000 + TOKEN_MAX_AGE_SECONDS) is None


def test_token_vector() -> None:
    assert (
        create_token(7, 2, "vector-secret", now=1000)
        == "7.2.2593000.h4iwZlqGe1wYGglpni-75ZF6nkgb-yIC90TlA69JV7k"
    )
