"""Investments of every kind: stocks and mutual funds share these tables.

`Instrument.kind` is "stock" or "mutual_fund". A trade's `amount` is the money it moved: a buy's
cost and a sell's proceeds, charges included. For stocks the server computes it from quantity,
price and charges; for funds the owner enters it.
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
    false,
    func,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Instrument(Base):
    __tablename__ = "instruments"
    __table_args__ = (UniqueConstraint("user_id", "kind", "symbol"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(12))  # "stock" or "mutual_fund"
    symbol: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(60))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Sip(Base):
    """A standing monthly instruction to buy a fund. It never posts on its own."""

    __tablename__ = "sips"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    # The bank account it's debited from.
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    day: Mapped[int] = mapped_column(Integer)  # debit day, 1-31, clamped to the month
    start_date: Mapped[dt.date] = mapped_column(Date)
    active: Mapped[bool] = mapped_column(Boolean, server_default=true())
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class InvestmentTrade(Base):
    __tablename__ = "investment_trades"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    # The account the cash moves through: a broker for stocks, a bank for funds.
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    side: Mapped[str] = mapped_column(String(4))  # "buy" or "sell"
    date: Mapped[dt.date] = mapped_column(Date)
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3))  # shares or units
    price: Mapped[Decimal] = mapped_column(Numeric(14, 4))  # price or NAV
    charges: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    # A buy's cost or a sell's proceeds, charges included.
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    # Bought before the app was used, so no cash moves.
    opening: Mapped[bool] = mapped_column(Boolean, server_default=false())
    note: Mapped[str | None] = mapped_column(String(200))
    sip_id: Mapped[int | None] = mapped_column(ForeignKey("sips.id"), index=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class InstrumentPrice(Base):
    __tablename__ = "instrument_prices"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    date: Mapped[dt.date] = mapped_column(Date)
    price: Mapped[Decimal] = mapped_column(Numeric(14, 4))
    # Set when a fund trade recorded this NAV; it follows that trade.
    trade_id: Mapped[int | None] = mapped_column(ForeignKey("investment_trades.id"), index=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
