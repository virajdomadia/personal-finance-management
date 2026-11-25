from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import SignedInUser as CurrentUser
from app.api.deps import get_signed_in_user
from app.core.config import get_settings
from app.core.google import GoogleUnavailable, InvalidGoogleToken, verify_google_id_token
from app.core.security import TOKEN_MAX_AGE_SECONDS, bearer_token, create_token, parse_token
from app.db.session import DbSession
from app.models.user import LoginSession, User

# Login is public; the session check below is the protected part of this router.
public_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(get_signed_in_user)])


class GoogleLoginRequest(BaseModel):
    # A Google ID token is ~1-2 KB; anything far bigger is rejected (422) before it reaches Google.
    id_token: str = Field(min_length=1, max_length=8192)


class LoginResponse(BaseModel):
    token: str


class SessionResponse(BaseModel):
    email: str


def _unavailable(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail)


@public_router.post("/google")
def google_login(body: GoogleLoginRequest, db: DbSession) -> LoginResponse:
    settings = get_settings()
    if not settings.google_client_id or not settings.token_secret:
        raise _unavailable("Sign-in is not configured.")

    try:
        identity = verify_google_id_token(body.id_token, settings.google_client_id)
    except InvalidGoogleToken:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid Google sign-in.") from None
    except GoogleUnavailable:
        raise _unavailable("Could not reach Google. Try again.") from None

    # There is no sign-up: a Google account only ever signs in to an existing user row.
    try:
        user = db.scalars(select(User).where(User.google_sub == identity.sub)).first()
        if user is None:
            user = db.scalars(select(User).where(User.email == identity.email.lower())).first()
            if user is not None and user.google_sub is None:
                user.google_sub = identity.sub
                db.commit()
            else:
                user = None
    except SQLAlchemyError:
        db.rollback()
        raise _unavailable("Database unavailable. Try again.") from None

    if user is None or user.owner_id is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This Google account is not allowed.")

    # Each sign-in is its own session, so logging out of one leaves the others signed in.
    now = datetime.now(UTC)
    try:
        db.execute(
            delete(LoginSession).where(
                LoginSession.user_id == user.id, LoginSession.expires_at <= now
            )
        )
        session = LoginSession(
            user_id=user.id, expires_at=now + timedelta(seconds=TOKEN_MAX_AGE_SECONDS)
        )
        db.add(session)
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise _unavailable("Database unavailable. Try again.") from None
    token = create_token(
        user.id, user.session_version, settings.token_secret, session_id=session.id
    )
    return LoginResponse(token=token)


@router.get("/session")
def session(user: CurrentUser) -> SessionResponse:
    """Lets a client check its credentials and see who it is signed in as."""
    return SessionResponse(email=user.email)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, user: CurrentUser, db: DbSession) -> Response:
    """Revokes the session this request's token belongs to. A token from before sessions names
    none, so it lasts until it expires or the owner signs out everywhere."""
    claims = parse_token(bearer_token(request), get_settings().token_secret)
    if claims is not None and claims.session_id is not None:
        db.execute(
            delete(LoginSession).where(
                LoginSession.id == claims.session_id, LoginSession.user_id == user.id
            )
        )
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/logout-everywhere", status_code=status.HTTP_204_NO_CONTENT)
def logout_everywhere(user: CurrentUser, db: DbSession) -> Response:
    """Signs every browser and phone out, this one included, along with any older token."""
    user.session_version += 1
    db.execute(delete(LoginSession).where(LoginSession.user_id == user.id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
