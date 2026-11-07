from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(60))
    # Today this is the balance; once transactions exist, balance = this + their sum.
    opening_balance: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    institution: Mapped[str | None] = mapped_column(String(60))
    bank_kind: Mapped[str | None] = mapped_column(String(20))
    last4: Mapped[str | None] = mapped_column(String(4))
    credit_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    statement_day: Mapped[int | None]
    due_day: Mapped[int | None]
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
