"""A credit card's statement: what it asked for, by when.

One per card per statement date. A statement SMS fills one in; the owner can enter or correct one
by hand, and a statement they entered or corrected (`source = "manual"`) is never overwritten by an
SMS. A statement holds no money: the card's balance comes from its transactions. It only says
what the bill is, so where the bill stands (paid, partly paid, overdue) is worked out from the
payments made since (`app.api.card_statements`).
"""

import datetime as dt
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class CardStatement(Base):
    __tablename__ = "card_statements"
    __table_args__ = (UniqueConstraint("account_id", "statement_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    statement_date: Mapped[dt.date] = mapped_column(Date)
    total_due: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    minimum_due: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    due_date: Mapped[dt.date] = mapped_column(Date)
    source: Mapped[str] = mapped_column(String(10))  # "sms" or "manual"
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
