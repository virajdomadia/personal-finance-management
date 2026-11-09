import datetime as dt
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(60))
    # The balance is this plus the account's transactions; see app/api/balances.py.
    opening_balance: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    institution: Mapped[str | None] = mapped_column(String(60))
    bank_kind: Mapped[str | None] = mapped_column(String(20))
    last4: Mapped[str | None] = mapped_column(String(4))
    credit_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    statement_day: Mapped[int | None]
    due_day: Mapped[int | None]
    # Loans only. EMIs left = emis_at_opening minus the EMIs recorded; see app/api/loans.py.
    interest_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    emi_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    emis_at_opening: Mapped[int | None]
    # The account a loan's EMIs are paid from. A card's available credit excludes these loans.
    pay_from_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    # PPF and RD only. `deposits_at_opening` is the RD instalments paid before the app's own
    # transfers; instalments paid = it plus the months with a transfer in (app/api/deposits.py).
    opened_on: Mapped[dt.date | None] = mapped_column(Date)
    deposit_amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    tenure_months: Mapped[int | None]
    deposits_at_opening: Mapped[int | None]
    archived_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
