from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api import dates
from app.models.account import Account
from app.models.corporate_action import CorporateAction, normalise_purpose
from app.models.investment import Instrument, InvestmentTrade
from app.models.user import User


def _freeze(monkeypatch: pytest.MonkeyPatch, day: date) -> None:
    monkeypatch.setattr(dates, "today_india", lambda: day)


def _trade(db: Session) -> InvestmentTrade:
    user = User(email="basis@example.com")
    db.add(user)
    db.flush()
    broker = Account(user_id=user.id, type="broker", name="Zerodha", opening_balance=0)
    stock = Instrument(user_id=user.id, kind="stock", symbol="INFY", name="Infosys")
    db.add_all([broker, stock])
    db.flush()
    trade = InvestmentTrade(
        user_id=user.id,
        instrument_id=stock.id,
        account_id=broker.id,
        side="buy",
        date=date(2020, 1, 1),
        quantity=Decimal("10"),
        price=Decimal("100"),
        charges=Decimal("0"),
        amount=Decimal("1000"),
        opening=True,
    )
    db.add(trade)
    db.flush()
    return trade


def test_basis_date_set_on_create_to_today_india(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _freeze(monkeypatch, date(2026, 11, 19))
    trade = _trade(db_session)
    assert trade.basis_date == date(2026, 11, 19)  # not the trade's own 2020 date


def test_basis_date_moves_when_quantity_or_price_edited(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    _freeze(monkeypatch, date(2026, 11, 19))
    trade = _trade(db_session)
    _freeze(monkeypatch, date(2026, 12, 1))

    trade.note = "just a note"
    db_session.flush()
    assert trade.basis_date == date(2026, 11, 19)

    trade.quantity = Decimal("12")
    db_session.flush()
    assert trade.basis_date == date(2026, 12, 1)

    _freeze(monkeypatch, date(2026, 12, 5))
    trade.price = Decimal("101")
    db_session.flush()
    assert trade.basis_date == date(2026, 12, 5)


def _action(**over: object) -> CorporateAction:
    fields: dict[str, object] = {
        "symbol": "INFY",
        "kind": "dividend",
        "ex_date": date(2026, 6, 1),
        "purpose": "Interim Dividend - Rs 10",
        "purpose_key": normalise_purpose("Interim Dividend - Rs 10"),
        "source": "nse",
    }
    fields.update(over)
    return CorporateAction(**fields)


def test_same_event_twice_is_one_row(db_session: Session) -> None:
    db_session.add(_action())
    db_session.flush()
    db_session.add(_action(purpose="INTERIM DIVIDEND  Rs 10"))  # same key after normalising
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_interim_and_special_dividend_same_day_are_two_rows(db_session: Session) -> None:
    special = "Special Dividend - Rs 5"
    db_session.add_all(
        [_action(), _action(purpose=special, purpose_key=normalise_purpose(special))]
    )
    db_session.flush()


def test_normalise_purpose() -> None:
    assert normalise_purpose("  Interim  Dividend - Rs. 10/- ") == "interim dividend rs 10"
