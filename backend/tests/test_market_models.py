from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.investment import Instrument, InstrumentPrice
from app.models.market import MarketCode
from app.models.user import User


def test_market_code_unique_per_kind(db_session: Session) -> None:
    db_session.add(MarketCode(kind="stock", code="INFY", name="Infosys"))
    db_session.commit()

    # The same code under another kind is a different row.
    db_session.add(MarketCode(kind="mutual_fund", code="INFY", name="Not Infosys"))
    db_session.commit()

    db_session.add(MarketCode(kind="stock", code="INFY", name="Infosys again"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_price_source_defaults_manual(db_session: Session) -> None:
    user = User(email="prices@example.com")
    db_session.add(user)
    db_session.flush()
    instrument = Instrument(user_id=user.id, kind="stock", symbol="INFY", name="Infosys")
    db_session.add(instrument)
    db_session.flush()
    price = InstrumentPrice(
        user_id=user.id, instrument_id=instrument.id, date=date(2026, 11, 12), price=Decimal("10")
    )
    db_session.add(price)
    db_session.commit()
    db_session.refresh(price)

    assert price.source == "manual"
    assert instrument.source_code is None
