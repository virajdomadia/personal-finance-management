import pytest
from fastapi.testclient import TestClient
from google.auth.exceptions import TransportError
from httpx import Response
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.routes import auth as auth_route
from app.core import google
from app.core.config import get_settings
from app.core.google import GoogleIdentity, GoogleUnavailable, InvalidGoogleToken
from app.main import app
from app.models.user import User

client = TestClient(app)


@pytest.fixture(autouse=True)
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "google_client_id", "web-client")
    monkeypatch.setattr(get_settings(), "token_secret", "test-secret")


def identity_is(monkeypatch: pytest.MonkeyPatch, sub: str, email: str) -> None:
    monkeypatch.setattr(
        auth_route, "verify_google_id_token", lambda token, client_id: GoogleIdentity(sub, email)
    )


def login() -> Response:
    return client.post("/api/auth/google", json={"id_token": "x"})


def user_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(User)) or 0


def test_first_login_links_the_verified_email(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_session.add(User(email="me@example.com"))
    db_session.commit()
    identity_is(monkeypatch, "sub-1", "Me@Example.com")

    response = login()

    assert response.status_code == 200
    assert response.json()["token"]
    assert db_session.scalars(select(User.google_sub)).one() == "sub-1"


def test_later_login_matches_by_sub_after_email_change(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_session.add(User(email="old@example.com", google_sub="sub-1"))
    db_session.commit()
    identity_is(monkeypatch, "sub-1", "new@example.com")

    assert login().status_code == 200


def test_unknown_account_is_rejected_and_creates_no_row(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_session.add(User(email="me@example.com"))
    db_session.commit()
    identity_is(monkeypatch, "sub-2", "stranger@example.com")

    assert login().status_code == 403
    assert user_count(db_session) == 1


def test_same_email_with_different_sub_is_rejected(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_session.add(User(email="me@example.com", google_sub="sub-1"))
    db_session.commit()
    identity_is(monkeypatch, "sub-other", "me@example.com")

    assert login().status_code == 403
    assert db_session.scalars(select(User.google_sub)).one() == "sub-1"


def test_invalid_google_token_returns_401(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(token: str, client_id: str) -> GoogleIdentity:
        raise InvalidGoogleToken

    monkeypatch.setattr(auth_route, "verify_google_id_token", fail)

    assert login().status_code == 401


def test_google_unavailable_returns_503(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fail(token: str, client_id: str) -> GoogleIdentity:
        raise GoogleUnavailable

    monkeypatch.setattr(auth_route, "verify_google_id_token", fail)

    assert login().status_code == 503


def test_database_failure_returns_503(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    identity_is(monkeypatch, "sub-1", "me@example.com")

    def boom(*args: object, **kwargs: object) -> None:
        raise SQLAlchemyError

    monkeypatch.setattr(db_session, "scalar", boom)
    monkeypatch.setattr(db_session, "scalars", boom)
    monkeypatch.setattr(db_session, "execute", boom)

    assert login().status_code == 503


@pytest.mark.parametrize("setting", ["google_client_id", "token_secret"])
def test_login_closed_when_not_configured(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, setting: str
) -> None:
    identity_is(monkeypatch, "sub-1", "me@example.com")
    monkeypatch.setattr(get_settings(), setting, "")

    assert login().status_code == 503


def claims(**overrides: object) -> dict[str, object]:
    return {
        "iss": "https://accounts.google.com",
        "sub": "sub-1",
        "email": "Me@Example.com",
        "email_verified": True,
    } | overrides


def patch_verify(monkeypatch: pytest.MonkeyPatch, result: dict[str, object] | Exception) -> None:
    def fake(token: str, request: object, audience: str) -> dict[str, object]:
        assert audience == "web-client"
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(google.id_token, "verify_oauth2_token", fake)


def test_verify_returns_lowercase_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_verify(monkeypatch, claims())

    assert google.verify_google_id_token("t", "web-client") == GoogleIdentity(
        "sub-1", "me@example.com"
    )


def test_verify_accepts_bare_issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_verify(monkeypatch, claims(iss="accounts.google.com"))

    assert google.verify_google_id_token("t", "web-client").sub == "sub-1"


@pytest.mark.parametrize(
    "bad",
    [
        claims(iss="https://evil.example.com"),
        claims(email_verified=False),
        claims(email_verified="true"),
        claims(email=None),
        claims(sub=None),
    ],
)
def test_verify_rejects_bad_claims(monkeypatch: pytest.MonkeyPatch, bad: dict[str, object]) -> None:
    patch_verify(monkeypatch, bad)

    with pytest.raises(InvalidGoogleToken):
        google.verify_google_id_token("t", "web-client")


def test_verify_maps_value_error_to_invalid(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_verify(monkeypatch, ValueError("bad"))

    with pytest.raises(InvalidGoogleToken):
        google.verify_google_id_token("t", "web-client")


def test_verify_maps_transport_error_to_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    patch_verify(monkeypatch, TransportError("down"))

    with pytest.raises(GoogleUnavailable):
        google.verify_google_id_token("t", "web-client")
