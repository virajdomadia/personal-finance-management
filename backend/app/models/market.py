"""Shared public market data: the codes a holding can be linked to, with their latest price.

Not per user. `kind` is "mutual_fund", "stock" or "crypto"; `code` is an AMFI scheme code, an
NSE symbol or a CoinGecko id respectively.
"""

import datetime as dt
from decimal import Decimal

from sqlalchemy import Date, DateTime, Index, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class MarketCode(Base):
    __tablename__ = "market_codes"
    __table_args__ = (
        UniqueConstraint("kind", "code"),
        Index("ix_market_codes_kind_name", "kind", "name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(12))
    code: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(160))
    isin: Mapped[str | None] = mapped_column(String(12))
    price: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    price_date: Mapped[dt.date | None] = mapped_column(Date)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
