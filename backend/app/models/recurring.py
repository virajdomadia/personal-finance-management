"""Recurring reminders: a standing instruction that comes due on a schedule.

A template never posts on its own. Each due occurrence is recorded by the owner (creating a
transaction that points back at the template) or skipped (a `RecurringSkip`).
"""

import datetime as dt
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class RecurringTemplate(Base):
    __tablename__ = "recurring_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    type: Mapped[str] = mapped_column(String(20))  # the transaction type it records
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    to_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    category: Mapped[str | None] = mapped_column(String(40))
    note: Mapped[str | None] = mapped_column(String(200))
    frequency: Mapped[str] = mapped_column(String(10))  # "monthly" or "yearly"
    day: Mapped[int] = mapped_column(Integer)  # day of month, 1-31, clamped to the month
    month: Mapped[int | None] = mapped_column(Integer)  # yearly only, 1-12
    start_date: Mapped[dt.date] = mapped_column(Date)
    end_date: Mapped[dt.date | None] = mapped_column(Date)
    remind_days: Mapped[int] = mapped_column(Integer)  # how many days ahead it shows as upcoming
    active: Mapped[bool] = mapped_column(Boolean, server_default=true())
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class RecurringSkip(Base):
    """An occurrence the owner chose not to record."""

    __tablename__ = "recurring_skips"
    __table_args__ = (UniqueConstraint("template_id", "occurrence"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    template_id: Mapped[int] = mapped_column(ForeignKey("recurring_templates.id"), index=True)
    occurrence: Mapped[dt.date] = mapped_column(Date)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
