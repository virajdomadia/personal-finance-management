from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import bearer_token, parse_token
from app.db.session import DbSession
from app.models.user import LoginSession, User

_UNAUTHENTICATED = HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")


PROFILE_HEADER = "x-profile"
_NO_SUCH_PROFILE = HTTPException(status.HTTP_404_NOT_FOUND, "That family member wasn't found.")


def get_signed_in_user(request: Request, db: DbSession) -> User:
    """The signed-in user, re-checked against the database so removals and revocations bite."""
    settings = get_settings()
    if not settings.token_secret:
        # Local dev without a secret acts as the first user; production never gets here open.
        if settings.environment != "development":
            raise _UNAUTHENTICATED
        user = db.scalars(select(User).order_by(User.id).limit(1)).first()
    else:
        claims = parse_token(bearer_token(request), settings.token_secret)
        if claims is None:
            raise _UNAUTHENTICATED
        user = db.get(User, claims.user_id)
        if user is not None and user.session_version != claims.session_version:
            user = None
        if user is not None and claims.session_id is not None:
            # A session token lasts only as long as its sign-in: logout deletes the row.
            session = db.get(LoginSession, claims.session_id)
            if session is None or session.user_id != user.id:
                user = None
    if user is None or user.owner_id is not None:  # a family member never signs in
        raise _UNAUTHENTICATED
    return user


def get_current_user(request: Request, db: DbSession) -> User:
    """Whose data this request is for: the signed-in user, or one of their family members when
    the `X-Profile` header names one. Anyone else's id is refused like a missing one."""
    user = get_signed_in_user(request, db)
    wanted = request.headers.get(PROFILE_HEADER, "").strip()
    if not wanted:
        return user
    if not wanted.isascii() or not wanted.isdecimal() or len(wanted) > 10:
        raise _NO_SUCH_PROFILE
    if int(wanted) == user.id:
        return user
    member = db.get(User, int(wanted))
    if member is None or member.owner_id != user.id:
        raise _NO_SUCH_PROFILE
    return member


CurrentUser = Annotated[User, Depends(get_current_user)]
# For what is always the signed-in person's, whichever profile is chosen: sign-in, SMS, family.
SignedInUser = Annotated[User, Depends(get_signed_in_user)]
