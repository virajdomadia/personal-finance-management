"""Which months of a SIP still need an instalment recorded. Pure apart from `load_due`."""

from collections import defaultdict
from collections.abc import Iterable
from datetime import date
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dates import clamped_date
from app.models.investment import InvestmentTrade, Sip

# A bank may debit an instalment this many days either side of its debit day (holidays).
DEBIT_SLACK = 3


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


def _debit_month(sip: SipRow, paid: date, settled: set[tuple[int, int]]) -> tuple[int, int]:
    """The month a linked buy on `paid` settles: that of the nearest unsettled debit date within
    `DEBIT_SLACK` days (the earlier on a tie), else its own."""
    near = []
    for shift in (-1, 0, 1):
        index = paid.year * 12 + paid.month - 1 + shift
        year, month = index // 12, index % 12 + 1
        debit = clamped_date(year, month, sip.day)
        gap = abs((debit - paid).days)
        if debit >= sip.start_date and gap <= DEBIT_SLACK and (year, month) not in settled:
            near.append((gap, debit, (year, month)))
    return min(near)[2] if near else (paid.year, paid.month)


def due_dates(
    sip: SipRow, buys: Iterable[BuyRow], today: date, others: Iterable[SipRow] = ()
) -> list[date]:
    """Debit dates from the start up to today with no instalment recorded, oldest first.

    A buy linked to the SIP settles the month of the SIP's debit date nearest to it within
    `DEBIT_SLACK` days, either way, unless another linked buy already settled that month: a debit
    moved past a holiday still settles the month it was for. Otherwise it settles its own month.
    An unlinked, non-opening buy of the same fund from any account settles its own month, so a
    SIP moved to another bank isn't asked for its old months again. The exception is a buy from
    the account of another active SIP of the same fund, whose own months it belongs to.
    """
    if not sip.active:
        return []
    claimed = {
        o.account_id
        for o in others
        if o.id != sip.id and o.active and o.instrument_id == sip.instrument_id
    }
    settled: set[tuple[int, int]] = set()
    for b in sorted((b for b in buys if b.sip_id == sip.id), key=lambda b: b.date):
        settled.add(_debit_month(sip, b.date, settled))
    for b in buys:
        matches = (
            b.sip_id is None
            and b.instrument_id == sip.instrument_id
            and (b.account_id == sip.account_id or b.account_id not in claimed)
            and not b.opening
        )
        if matches:
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
    sips = [
        SipRow(*row)
        for row in db.execute(
            select(
                Sip.id, Sip.instrument_id, Sip.account_id, Sip.day, Sip.start_date, Sip.active
            ).where(Sip.user_id == user_id)
        )
    ]
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
    for s in sips:
        # Linked buys always share the SIP's fund, so grouping by fund loses nothing.
        result[s.id] = due_dates(s, buys_by_fund[s.instrument_id], today, sips)
    return result
