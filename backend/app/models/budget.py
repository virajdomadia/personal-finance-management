"""Monthly budgets per expense category.

One row per change: the budget for a month is the row with the latest `effective_from` on or
before it, so changing this month's budget never rewrites last month's. A row with no amount
means "no budget from this month". See app/api/budgets.py.
"""

import datetime as dt
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Budget(Base):
    __tablename__ = "budgets"
    __table_args__ = (
        UniqueConstraint("user_id", "category_id", "effective_from"),
        # The category is the same user's and an expense one, checked by the database too.
        ForeignKeyConstraint(
            ["category_id", "user_id", "kind"],
            ["categories.id", "categories.user_id", "categories.kind"],
        ),
        CheckConstraint("kind = 'expense'", name="kind"),
        CheckConstraint("amount IS NULL OR amount > 0", name="amount_positive"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    category_id: Mapped[int] = mapped_column()
    kind: Mapped[str] = mapped_column(String(10), server_default=text("'expense'"))
    # The 1st of the month this row applies from.
    effective_from: Mapped[dt.date] = mapped_column(Date)
    # None: no budget from this month on.
    amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
