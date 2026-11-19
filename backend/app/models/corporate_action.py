"""Corporate actions (splits, bonuses, dividends): the shared feed, and what each user did about it.

`CorporateAction` is public market data, the same for every user, so it stays out of backups.
`StockAction` is one user's view of an action on one holding, and `DividendLink` ties it to the
dividend transactions that paid for it.
"""

import datetime as dt
import re
from collections.abc import Iterable
from decimal import Decimal

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    String,
    UniqueConstraint,
    delete,
    func,
)
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.db.base import Base


def normalise_purpose(text: str) -> str:
    """Lower-case, whitespace collapsed, punctuation dropped: the same event worded two ways
    compares equal."""
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower()).split())


class CorporateAction(Base):
    __tablename__ = "corporate_actions"
    __table_args__ = (UniqueConstraint("symbol", "kind", "ex_date", "purpose_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(20))
    isin: Mapped[str | None] = mapped_column(String(12))
    kind: Mapped[str] = mapped_column(String(14))
    ex_date: Mapped[dt.date] = mapped_column(Date)
    record_date: Mapped[dt.date | None] = mapped_column(Date)
    ratio_new: Mapped[Decimal | None] = mapped_column(Numeric(14, 6))
    ratio_old: Mapped[Decimal | None] = mapped_column(Numeric(14, 6))
    amount_per_share: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    purpose: Mapped[str] = mapped_column(String(300))
    # normalise_purpose() of the part of `purpose` this action came from (one notice can hold
    # several), set by the code that inserts the row; it tells two same-day dividends (interim
    # and special) apart.
    purpose_key: Mapped[str] = mapped_column(String(300))
    source: Mapped[str] = mapped_column(String(4))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class StockAction(Base):
    __tablename__ = "stock_actions"
    __table_args__ = (UniqueConstraint("user_id", "instrument_id", "corporate_action_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    instrument_id: Mapped[int] = mapped_column(ForeignKey("instruments.id"), index=True)
    corporate_action_id: Mapped[int | None] = mapped_column(
        ForeignKey("corporate_actions.id"), index=True
    )
    kind: Mapped[str] = mapped_column(String(14))
    ex_date: Mapped[dt.date] = mapped_column(Date)
    ratio_new: Mapped[Decimal | None] = mapped_column(Numeric(14, 6))
    ratio_old: Mapped[Decimal | None] = mapped_column(Numeric(14, 6))
    amount_per_share: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    status: Mapped[str] = mapped_column(String(10))
    target_instrument_id: Mapped[int | None] = mapped_column(
        ForeignKey("instruments.id"), index=True
    )
    cost_share_pct: Mapped[Decimal | None] = mapped_column(Numeric(7, 4))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DividendLink(Base):
    __tablename__ = "dividend_links"
    __table_args__ = (UniqueConstraint("stock_action_id", "transaction_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    stock_action_id: Mapped[int] = mapped_column(ForeignKey("stock_actions.id"), index=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id"), index=True)


def delete_links_for_transactions(db: Session, user_id: int, tx_ids: Iterable[int]) -> None:
    """Drops the dividend links of transactions about to be deleted (or to stop being income).

    A link is a note, not money, so the dividend just loses it. The foreign key has no ON
    DELETE, so every path that deletes a transaction calls this first.
    """
    ids = list(tx_ids)
    if ids:
        db.execute(
            delete(DividendLink).where(
                DividendLink.user_id == user_id, DividendLink.transaction_id.in_(ids)
            )
        )
