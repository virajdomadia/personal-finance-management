"""Net worth snapshots: the dashboard's figures for one user on one India date.

Written by the nightly job, by the first history request of a day, and (estimated) by the backfill
command. See docs/architecture/financial-calculations.md, "Net worth over time".
"""

import datetime as dt
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    UniqueConstraint,
    false,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# Sums over many accounts, so two more digits than a single amount's NUMERIC(14, 2).
TOTAL = Numeric(16, 2)


class NetWorthSnapshot(Base):
    __tablename__ = "net_worth_snapshots"
    __table_args__ = (UniqueConstraint("user_id", "date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    date: Mapped[dt.date] = mapped_column(Date)
    net_worth: Mapped[Decimal] = mapped_column(TOTAL)
    total_have: Mapped[Decimal] = mapped_column(TOTAL)
    total_owe: Mapped[Decimal] = mapped_column(TOTAL)
    # The dashboard's asset split, every group stored (zero and negative included).
    bank_cash: Mapped[Decimal] = mapped_column(TOTAL)
    deposits: Mapped[Decimal] = mapped_column(TOTAL)
    stocks: Mapped[Decimal] = mapped_column(TOTAL)
    funds: Mapped[Decimal] = mapped_column(TOTAL)
    crypto: Mapped[Decimal] = mapped_column(TOTAL)
    # True for a backfilled month-end worked out from transactions, without investments.
    estimated: Mapped[bool] = mapped_column(Boolean, server_default=false())
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
