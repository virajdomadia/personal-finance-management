"""Goals: a named target funded by earmarked money and whole holdings.

An earmark sets aside part of an account's balance for a goal (signed: negative releases it).
A holding assigns a whole instrument or account to a goal, in full.
"""

import datetime as dt
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    func,
    text,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Goal(Base):
    __tablename__ = "goals"
    __table_args__ = (
        Index(
            "uq_goals_one_emergency",
            "user_id",
            unique=True,
            postgresql_where=text("kind = 'emergency' AND archived_at IS NULL"),
            sqlite_where=text("kind = 'emergency' AND archived_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(60))
    kind: Mapped[str] = mapped_column(String(20))  # "custom" or "emergency"
    target_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    target_date: Mapped[dt.date | None] = mapped_column(Date)
    ef_months: Mapped[int | None] = mapped_column(Integer)
    ef_monthly_override: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    monthly_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    reminder_day: Mapped[int | None] = mapped_column(Integer)
    reminder_start: Mapped[dt.date | None] = mapped_column(Date)  # 1st of the month turned on
    note: Mapped[str | None] = mapped_column(String(200))
    archived_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class GoalEarmark(Base):
    __tablename__ = "goal_earmarks"
    __table_args__ = (CheckConstraint("amount <> 0", name="amount_nonzero"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    goal_id: Mapped[int] = mapped_column(ForeignKey("goals.id"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))  # signed
    date: Mapped[dt.date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class GoalHolding(Base):
    __tablename__ = "goal_holdings"
    __table_args__ = (
        CheckConstraint(
            "(instrument_id IS NULL) <> (account_id IS NULL)", name="exactly_one_target"
        ),
        Index(
            "uq_goal_holdings_active_instrument",
            "instrument_id",
            unique=True,
            postgresql_where=text("active"),
            sqlite_where=text("active"),
        ),
        Index(
            "uq_goal_holdings_active_account",
            "account_id",
            unique=True,
            postgresql_where=text("active"),
            sqlite_where=text("active"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    goal_id: Mapped[int] = mapped_column(ForeignKey("goals.id"), index=True)
    instrument_id: Mapped[int | None] = mapped_column(ForeignKey("instruments.id"))
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    active: Mapped[bool] = mapped_column(Boolean, server_default=true())
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
