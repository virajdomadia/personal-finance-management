"""Tables behind SMS transactions: what each message became, how to read the owner's payees,
which card or account numbers belong to which account, and unparsed samples for improving parsers.
"""

import datetime as dt
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AccountIdentifier(Base):
    """An extra last-4 (a card, an old account number) that an account also answers to."""

    __tablename__ = "account_identifiers"
    __table_args__ = (UniqueConstraint("account_id", "last4"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), index=True)
    last4: Mapped[str] = mapped_column(String(4))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class SmsEntry(Base):
    """One received message and what became of it. Card statements are `kind="card_statement"`
    rows: `amount` is the statement total and `due_date` the payment due date."""

    __tablename__ = "sms_entries"
    __table_args__ = (
        UniqueConstraint("user_id", "hash"),
        Index("ix_sms_entries_user_id_status", "user_id", "status"),
        Index("ix_sms_entries_user_id_ref", "user_id", "ref"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    hash: Mapped[str] = mapped_column(String(64))
    sender: Mapped[str] = mapped_column(String(20))
    # The parser key, such as "hdfc".
    bank: Mapped[str] = mapped_column(String(30))
    # "debit", "credit", "card_spend", "card_payment", "card_statement" or "demat".
    kind: Mapped[str] = mapped_column(String(20))
    amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    occurred_on: Mapped[dt.date] = mapped_column(Date)
    last4: Mapped[str | None] = mapped_column(String(4))
    payee: Mapped[str | None] = mapped_column(String(120))
    payee_key: Mapped[str | None] = mapped_column(String(120))
    ref: Mapped[str | None] = mapped_column(String(40))
    balance: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    isin: Mapped[str | None] = mapped_column(String(12))
    quantity: Mapped[Decimal | None] = mapped_column(Numeric(24, 8))
    due_date: Mapped[dt.date | None] = mapped_column(Date)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    # "recorded", "review", "draft", "ignored" or "duplicate".
    status: Mapped[str] = mapped_column(String(12))
    reason: Mapped[str | None] = mapped_column(String(20))
    # A human sentence for the review card.
    message: Mapped[str | None] = mapped_column(String(200))
    # A list of {"kind": str, "id": int, "label": str}.
    candidates: Mapped[list | None] = mapped_column(JSON)
    transaction_id: Mapped[int | None] = mapped_column(ForeignKey("transactions.id"), index=True)
    trade_id: Mapped[int | None] = mapped_column(ForeignKey("investment_trades.id"), index=True)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class PayeeRule(Base):
    """What the owner decided a payee is: a category, a transfer target or a recurring template."""

    __tablename__ = "payee_rules"
    __table_args__ = (UniqueConstraint("user_id", "payee_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    payee_key: Mapped[str] = mapped_column(String(120))
    display: Mapped[str] = mapped_column(String(120))
    category: Mapped[str | None] = mapped_column(String(40))
    to_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"))
    template_id: Mapped[int | None] = mapped_column(ForeignKey("recurring_templates.id"))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class SmsSample(Base):
    """A message no parser understood, kept so a parser can be written for it."""

    __tablename__ = "sms_samples"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    sender: Mapped[str] = mapped_column(String(20))
    text: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
