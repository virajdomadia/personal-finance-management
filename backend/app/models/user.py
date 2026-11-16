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
