import datetime as dt
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String(20))
    # Always positive; `type` and the account decide which way a balance moves.
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    date: Mapped[dt.date] = mapped_column(Date)
    # The account money leaves for an expense or transfer, and enters for income.
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    # Transfers: the account money enters. EMIs: the loan being repaid.
    to_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"), index=True)
    # Income and expense only; an EMI's is always "Loan interest".
    category: Mapped[str | None] = mapped_column(String(40))
    # EMIs only: the part of `amount` that is interest and charges. The rest repays the loan.
    interest: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    note: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
