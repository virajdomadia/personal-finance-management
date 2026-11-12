from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.investment import Instrument, InvestmentTrade
from app.models.sms import AccountIdentifier, SmsEntry
from app.models.transaction import Transaction
from app.models.user import User


def make_user(db: Session, email: str) -> User:
    user = User(email=email)
    db.add(user)
    db.flush()
    return user


def make_account(db: Session, user: User) -> Account:
    account = Account(user_id=user.id, type="bank", name="SBI", opening_balance=Decimal("0"))
    db.add(account)
    db.flush()
    return account


def entry(user_id: int, hash_: str) -> SmsEntry:
    return SmsEntry(
        user_id=user_id,
        hash=hash_,
        sender="HDFCBK",
        bank="hdfc",
        kind="debit",
        occurred_on=date(2026, 11, 12),
        status="recorded",
    )


def test_sms_hash_unique_per_user(db_session: Session) -> None:
    one = make_user(db_session, "one@example.com")
    two = make_user(db_session, "two@example.com")
    db_session.add(entry(one.id, "abc"))
    db_session.add(entry(two.id, "abc"))
    db_session.commit()

    db_session.add(entry(one.id, "abc"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_transaction_source_defaults_manual(db_session: Session) -> None:
    user = make_user(db_session, "src@example.com")
    account = make_account(db_session, user)
    txn = Transaction(
        user_id=user.id,
        type="expense",
        amount=Decimal("10"),
        date=date(2026, 11, 12),
        account_id=account.id,
    )
    db_session.add(txn)
    db_session.commit()
    db_session.refresh(txn)
    assert txn.source == "manual"


def test_trade_estimated_defaults_false(db_session: Session) -> None:
    user = make_user(db_session, "est@example.com")
    account = make_account(db_session, user)
    instrument = Instrument(user_id=user.id, kind="stock", symbol="INFY", name="Infosys")
    db_session.add(instrument)
    db_session.flush()
    trade = InvestmentTrade(
        user_id=user.id,
        instrument_id=instrument.id,
        account_id=account.id,
        side="buy",
        date=date(2026, 11, 12),
        quantity=Decimal("1"),
        price=Decimal("10"),
        charges=Decimal("0"),
        amount=Decimal("10"),
    )
    db_session.add(trade)
    db_session.commit()
    db_session.refresh(trade)
    assert trade.estimated is False


def test_identifier_unique_per_account(db_session: Session) -> None:
    user = make_user(db_session, "ident@example.com")
    account = make_account(db_session, user)
    other = make_account(db_session, user)
    db_session.add(AccountIdentifier(user_id=user.id, account_id=account.id, last4="1234"))
    db_session.add(AccountIdentifier(user_id=user.id, account_id=other.id, last4="1234"))
    db_session.commit()

    db_session.add(AccountIdentifier(user_id=user.id, account_id=account.id, last4="1234"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
