"""Which months of a SIP still need an instalment recorded. Pure apart from `load_due`."""

from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import clamped_date
from app.models.investment import InvestmentTrade, Sip


class SipRow(NamedTuple):
    id: int
    instrument_id: int
    account_id: int
    day: int
    start_date: date
    active: bool


class BuyRow(NamedTuple):
    instrument_id: int
    account_id: int
    date: date
    opening: bool
    sip_id: int | None


def due_dates(sip: SipRow, buys: Iterable[BuyRow], today: date) -> list[date]:
    """Debit dates from the start up to today with no instalment recorded, oldest first.

    A month is settled by a buy in that calendar month linked to the SIP, or by an unlinked,
    non-opening buy of the same fund from the same account.
    """
    if not sip.active:
        return []
    settled: set[tuple[int, int]] = set()
    for b in buys:
        linked = b.sip_id == sip.id
        matches = (
            b.sip_id is None
            and b.instrument_id == sip.instrument_id
            and b.account_id == sip.account_id
            and not b.opening
        )
        if linked or matches:
            settled.add((b.date.year, b.date.month))
    due: list[date] = []
    year, month = sip.start_date.year, sip.start_date.month
    while (year, month) <= (today.year, today.month):
        debit = clamped_date(year, month, sip.day)
        if sip.start_date <= debit <= today and (year, month) not in settled:
            due.append(debit)
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return due


def load_due(db: Session, user_id: int, today: date) -> dict[int, list[date]]:
    """Each of the user's SIPs (by id) with its unrecorded debit dates."""
    sips = db.execute(
        select(
            Sip.id, Sip.instrument_id, Sip.account_id, Sip.day, Sip.start_date, Sip.active
        ).where(Sip.user_id == user_id)
    )
    buys_by_fund: dict[int, list[BuyRow]] = defaultdict(list)
    buys = db.execute(
        select(
            InvestmentTrade.instrument_id,
            InvestmentTrade.account_id,
            InvestmentTrade.date,
            InvestmentTrade.opening,
            InvestmentTrade.sip_id,
        ).where(InvestmentTrade.user_id == user_id, InvestmentTrade.side == "buy")
    )
    for row in buys:
        buys_by_fund[row[0]].append(BuyRow(*row))
    result: dict[int, list[date]] = {}
    for row in sips:
        s = SipRow(*row)
        # Linked buys always share the SIP's fund, so grouping by fund loses nothing.
        result[s.id] = due_dates(s, buys_by_fund[s.instrument_id], today)
    return result
