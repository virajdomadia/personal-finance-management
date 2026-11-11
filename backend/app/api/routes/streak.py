from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dates import INDIA, today_india
from app.api.deps import CurrentUser, get_current_user
from app.db.session import DbSession
from app.models.transaction import Transaction

router = APIRouter(prefix="/streak", tags=["streak"], dependencies=[Depends(get_current_user)])


class StreakResponse(BaseModel):
    days: int


def streak_days(logged_on: set[date], today: date) -> int:
    """Consecutive days with a logged transaction, ending today (or yesterday if today has none)."""
    day = today if today in logged_on else today - timedelta(days=1)
    count = 0
    while day in logged_on:
        count += 1
        day -= timedelta(days=1)
    return count


def _india_day(stamp: datetime) -> date:
    # SQLite hands back naive datetimes; they are stored as UTC.
    return stamp.replace(tzinfo=stamp.tzinfo or UTC).astimezone(INDIA).date()


@router.get("")
def get_streak(user: CurrentUser, db: DbSession) -> StreakResponse:
    stamps = db.scalars(select(Transaction.created_at).where(Transaction.user_id == user.id))
    days = {_india_day(s) for s in stamps}
    return StreakResponse(days=streak_days(days, today_india()))
