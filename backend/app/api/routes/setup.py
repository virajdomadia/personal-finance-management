"""The first-run checklist: which setup steps the user's own data already covers.

Nothing is stored here. Skipping a step or hiding the checklist is kept on the device, and the
app adds its own "Bank SMS" step from the phone's settings.
"""

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.deps import CurrentUser, get_current_user
from app.db.session import DbSession
from app.models.account import Account
from app.models.investment import Instrument, Sip
from app.models.recurring import RecurringTemplate

router = APIRouter(prefix="/setup", tags=["setup"], dependencies=[Depends(get_current_user)])

StepKey = Literal["bank", "cards", "loans", "recurring", "investments"]


class SetupStep(BaseModel):
    key: StepKey
    done: bool
    count: int


class SetupResponse(BaseModel):
    # The website keys its on-device skip/hide state by this, since a shared browser may be used
    # by more than one family member.
    user_id: int
    steps: list[SetupStep]


@router.get("")
def get_setup(user: CurrentUser, db: DbSession) -> SetupResponse:
    def count(model: Any, *where: Any) -> int:
        query = select(func.count()).select_from(model).where(model.user_id == user.id, *where)
        return db.scalar(query) or 0

    def accounts(*types: str) -> int:
        return count(Account, Account.type.in_(types), Account.archived_at.is_(None))

    counts: dict[StepKey, int] = {
        "bank": accounts("bank"),
        "cards": accounts("credit_card"),
        "loans": accounts("loan"),
        "recurring": count(RecurringTemplate, RecurringTemplate.active.is_(True))
        + count(Sip, Sip.active.is_(True)),
        "investments": count(Instrument) + accounts("ppf", "rd"),
    }
    return SetupResponse(
        user_id=user.id,
        steps=[SetupStep(key=key, done=n > 0, count=n) for key, n in counts.items()],
    )
