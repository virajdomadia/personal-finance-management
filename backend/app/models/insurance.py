"""Insurance policies. A policy's premium is paid through a recurring template; each paid
period is kept as a `PolicyPeriod`, linked to the transaction that paid it.
"""

import datetime as dt
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Numeric, String, func, true
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class InsurancePolicy(Base):
    __tablename__ = "insurance_policies"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))  # "health"
    insurer: Mapped[str] = mapped_column(String(60))
    plan: Mapped[str] = mapped_column(String(100))
    policy_number: Mapped[str] = mapped_column(String(40))
    insured: Mapped[str] = mapped_column(String(100))
    sum_insured: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    period_start: Mapped[dt.date] = mapped_column(Date)
    period_end: Mapped[dt.date] = mapped_column(Date)
    premium: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    template_id: Mapped[int] = mapped_column(ForeignKey("recurring_templates.id"), unique=True)
    funded_by_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    details: Mapped[str | None] = mapped_column(String(2000))
    active: Mapped[bool] = mapped_column(Boolean, server_default=true())
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PolicyPeriod(Base):
    """One paid cover period of a policy."""

    __tablename__ = "policy_periods"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    policy_id: Mapped[int] = mapped_column(ForeignKey("insurance_policies.id"), index=True)
    period_start: Mapped[dt.date] = mapped_column(Date)
    period_end: Mapped[dt.date] = mapped_column(Date)
    premium: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    sum_insured: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    paid_on: Mapped[dt.date] = mapped_column(Date)
    transaction_id: Mapped[int | None] = mapped_column(ForeignKey("transactions.id"), unique=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
