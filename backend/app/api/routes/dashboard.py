import calendar
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import fmt, list_sort_key, totals
from app.db.session import DbSession
from app.models.account import Account

router = APIRouter(
    prefix="/dashboard", tags=["dashboard"], dependencies=[Depends(get_current_user)]
)

INDIA = timezone(timedelta(hours=5, minutes=30))


def today_india() -> date:
    return datetime.now(UTC).astimezone(INDIA).date()


def _clamped(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def next_due_date(due_day: int, today: date) -> date:
    """This month's due date (clamped to the month's length), or next month's if already past."""
    this_month = _clamped(today.year, today.month, due_day)
    if this_month >= today:
        return this_month
    year, month = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
    return _clamped(year, month, due_day)


class NextCardDue(BaseModel):
    account_id: int
    name: str
    due_date: str


class CreditUsed(BaseModel):
    percent: int


class DashboardResponse(BaseModel):
    has_accounts: bool
    net_worth: str
    total_have: str
    total_owe: str
    next_card_due: NextCardDue | None
    credit_used: CreditUsed | None


@router.get("")
def get_dashboard(user: CurrentUser, db: DbSession) -> DashboardResponse:
    active = list(
        db.scalars(
            select(Account).where(Account.user_id == user.id, Account.archived_at.is_(None))
        ).all()
    )
    have, owe = totals(active)
    cards = sorted(
        (a for a in active if a.type == "credit_card"),
        key=list_sort_key,
    )

    today = today_india()
    dated = [(next_due_date(a.due_day, today), a) for a in cards if a.due_day is not None]
    due = min(dated, key=lambda pair: pair[0], default=None)  # min keeps the first of equal dates

    limited = [a for a in cards if a.credit_limit is not None]
    credit_used = None
    if limited:
        used = sum((a.opening_balance for a in limited), Decimal(0))
        limit = sum((a.credit_limit for a in limited if a.credit_limit is not None), Decimal(0))
        percent = (used * 100 / limit).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        credit_used = CreditUsed(percent=int(max(percent, Decimal(0))))

    return DashboardResponse(
        has_accounts=bool(active),
        net_worth=fmt(have - owe),
        total_have=fmt(have),
        total_owe=fmt(owe),
        next_card_due=None
        if due is None
        else NextCardDue(account_id=due[1].id, name=due[1].name, due_date=due[0].isoformat()),
        credit_used=credit_used,
    )
