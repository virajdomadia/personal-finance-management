"""CDSL share movements: matched to the owner's stock, or left as a draft trade."""

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.api.dates import today_india
from app.models.investment import Instrument, InvestmentTrade
from app.models.market import MarketCode
from tests.test_accounts import Headers, auth
from tests.test_sms_expected import user_id
from tests.test_sms_ingest import bank, one, stored


@pytest.fixture
def headers(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> Headers:
    return auth(db_session, monkeypatch)


def stock(db: Session, symbol: str, name: str, uid: int | None = None) -> int:
    row = Instrument(
        user_id=uid or user_id(db), kind="stock", symbol=symbol, name=name, source_code=symbol
    )
    db.add(row)
    db.commit()
    return row.id


def demat(headers: Headers, **fields: object) -> dict:
    body = {
        "bank": "cdsl",
        "sender": "CDSLIN",
        "kind": "demat",
        "amount": None,
        "last4": "9543",
        "ref": "debit",
        "quantity": "221",
        "payee": "HINDUSTAN CO",
        "isin": None,
    }
    body.update(fields)
    return one(headers, **body)


def test_cdsl_shortened_name_matches_stock(headers: Headers, db_session: Session) -> None:
    sid = stock(db_session, "HINDCOPPER", "Hindustan Copper Ltd")
    stock(db_session, "HINDALCO", "Hindalco Industries Ltd")
    result = demat(headers)
    assert result["status"] == "draft" and result["reason"] == "demat"
    row = stored(db_session, result["hash"])
    assert row.candidates == [{"kind": "stock", "id": sid, "label": "HINDCOPPER"}]
    assert row.message == "Sold 221 Hindustan Co"
    assert row.transaction_id is None and row.trade_id is None


def test_cdsl_line_becomes_draft_with_stock(headers: Headers, db_session: Session) -> None:
    sid = stock(db_session, "INFY", "Infosys Ltd")
    result = demat(headers, ref="credit", payee="INFOSYS LIMITED", quantity="5")
    row = stored(db_session, result["hash"])
    assert (row.status, row.reason) == ("draft", "demat")
    assert row.candidates == [{"kind": "stock", "id": sid, "label": "INFY"}]
    assert row.message == "Bought 5 Infosys Limited"


def test_cdsl_line_for_new_stock_has_no_candidate(headers: Headers, db_session: Session) -> None:
    db_session.add(MarketCode(kind="stock", code="HINDCOPPER", name="Hindustan Copper Limited"))
    db_session.commit()
    result = demat(headers)
    row = stored(db_session, result["hash"])
    assert row.status == "draft"
    [choice] = row.candidates
    assert choice["kind"] == "market" and choice["label"] == "HINDCOPPER · Hindustan Copper Limited"


def test_cdsl_line_with_no_match_at_all_has_empty_candidates(
    headers: Headers, db_session: Session
) -> None:
    result = demat(headers, payee="UNKNOWN CORP")
    assert stored(db_session, result["hash"]).candidates == []


def test_cdsl_several_name_matches_are_all_candidates(
    headers: Headers, db_session: Session
) -> None:
    a = stock(db_session, "HINDCOPPER", "Hindustan Copper Ltd")
    b = stock(db_session, "HINDCOAL", "Hindustan Coal Ltd")
    row = stored(db_session, demat(headers)["hash"])
    assert [c["id"] for c in row.candidates] == [a, b]


def test_cdsl_isin_matches_through_market_codes(headers: Headers, db_session: Session) -> None:
    sid = stock(db_session, "HINDCOPPER", "Copper")
    db_session.add(
        MarketCode(kind="stock", code="HINDCOPPER", name="Hindustan Copper", isin="INE531E01026")
    )
    db_session.commit()
    row = stored(db_session, demat(headers, isin="INE531E01026", payee="X Y Z")["hash"])
    assert row.candidates == [{"kind": "stock", "id": sid, "label": "HINDCOPPER"}]


def test_cdsl_line_matching_manual_trade_is_duplicate(
    headers: Headers, db_session: Session
) -> None:
    sid = stock(db_session, "HINDCOPPER", "Hindustan Copper Ltd")
    acct = bank(headers)
    trade = InvestmentTrade(
        user_id=user_id(db_session),
        instrument_id=sid,
        account_id=acct,
        side="sell",
        date=today_india() - timedelta(days=1),
        quantity=Decimal("221"),
        price=Decimal("300"),
        charges=Decimal("0"),
        amount=Decimal("66300"),
    )
    db_session.add(trade)
    db_session.commit()
    result = demat(headers)
    assert result["status"] == "duplicate"
    assert stored(db_session, result["hash"]).trade_id == trade.id


def test_opening_or_other_side_or_old_trades_are_not_duplicates(
    headers: Headers, db_session: Session
) -> None:
    sid = stock(db_session, "HINDCOPPER", "Hindustan Copper Ltd")
    acct = bank(headers)
    day = today_india()
    for side, opening, ago in (("sell", True, 0), ("buy", False, 0), ("sell", False, 3)):
        db_session.add(
            InvestmentTrade(
                user_id=user_id(db_session),
                instrument_id=sid,
                account_id=acct,
                side=side,
                date=day - timedelta(days=ago),
                quantity=Decimal("221"),
                price=Decimal("1"),
                charges=Decimal("0"),
                amount=Decimal("221"),
                opening=opening,
            )
        )
    db_session.commit()
    assert demat(headers)["status"] == "draft"


def test_other_users_stocks_are_not_matched(
    headers: Headers, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    stock(db_session, "HINDCOPPER", "Hindustan Copper Ltd")
    other = auth(db_session, monkeypatch, email="other@example.com")
    assert stored(db_session, demat(other)["hash"]).candidates == []
