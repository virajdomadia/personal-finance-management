from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.api.deps import CurrentUser, get_current_user
from app.core.config import get_settings
from app.core.google import GoogleUnavailable, InvalidGoogleToken, verify_google_id_token
from app.core.security import create_token
from app.db.session import DbSession
from app.models.user import User

# Login is public; the session check below is the protected part of this router.
public_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(get_current_user)])


class GoogleLoginRequest(BaseModel):
    id_token: str


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

    if user is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This Google account is not allowed.")
    return LoginResponse(token=create_token(user.id, user.session_version, settings.token_secret))


@router.get("/session")
def session(user: CurrentUser) -> SessionResponse:
    """Lets a client check its credentials and see who it is signed in as."""
    return SessionResponse(email=user.email)
