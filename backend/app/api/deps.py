from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import bearer_token, parse_token
from app.db.session import DbSession
from app.models.user import User

_UNAUTHENTICATED = HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")


def get_current_user(request: Request, db: DbSession) -> User:
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
    if user is None:
        raise _UNAUTHENTICATED
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
