from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    google_sub: Mapped[str | None] = mapped_column(String(255), unique=True)
    session_version: Mapped[int] = mapped_column(default=1, server_default="1")
    # A family member: a profile with no login, managed by the user `owner_id`. Its email is a
    # placeholder no Google account can have (see app/api/routes/family.py).
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LoginSession(Base):
    """One sign-in (a browser or a phone). Its id is in the session token; logout deletes the row,
    which revokes that token alone. Signing out everywhere bumps `User.session_version` instead,
    which also covers tokens issued before sessions existed."""

    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # When its token expires; expired rows are cleared at the next sign-in.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
