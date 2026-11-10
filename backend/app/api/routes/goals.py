"""Goals: a named target funded by earmarked money and whole holdings.

A goal never moves money. The emergency fund's target is worked out from recent spending.
The figures live in `app.api.goals`; this module is the create, edit, list and delete routes.
"""

from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.dates import iso_date, today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.goals import GoalResponse, load_goal_book
from app.api.routes.accounts import MAX_ID, Money, clean_text, field_error, fmt
from app.api.routes.stocks import Deleted
from app.db.session import DbSession
from app.models.account import Account
from app.models.goal import Goal, GoalEarmark, GoalHolding

router = APIRouter(prefix="/goals", tags=["goals"], dependencies=[Depends(get_current_user)])

KINDS = ("custom", "emergency")
DEFAULT_EF_MONTHS = 6
_NOT_FOUND = "Goal not found."
_NAME = "Enter a name."
_KIND = "Choose custom or emergency."
_TARGET = "Enter a target amount."
_EF_TARGET = "The emergency fund's target is worked out for you."
_EF_ONLY = "Only the emergency fund has this."
_MONTHS = "Choose 1 to 24 months."
_DAY = "Choose a day from 1 to 31."
_OVERRIDE = "Enter a monthly figure greater than 0."
_MONTHLY = "Enter a monthly amount greater than 0."
_HAVE_EF = "You already have an emergency fund."
_HISTORY = "This goal has set-aside history. Archive it instead."


def _int_in(low: int, high: int, message: str) -> Any:
    def check(value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise PydanticCustomError("range", message)
        return value

    return check


def _kind(value: Any) -> Any:
    if value is not None and value not in KINDS:
        raise PydanticCustomError("kind", _KIND)
    return value


def _flag(value: Any) -> bool:
    if not isinstance(value, bool):
        raise PydanticCustomError("flag", "Choose yes or no.")
    return value


Name = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, _NAME, limit=1000))]
Note = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, "Enter a note.", limit=200))]
Kind = Annotated[str | None, BeforeValidator(_kind)]
Months = Annotated[int | None, BeforeValidator(_int_in(1, 24, _MONTHS))]
ReminderDay = Annotated[int | None, BeforeValidator(_int_in(1, 31, _DAY))]
Day = Annotated[date | None, BeforeValidator(iso_date)]
Flag = Annotated[bool, BeforeValidator(_flag)]


class GoalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    name: Name = None
    kind: Kind = None
    target_amount: Money = None
    target_date: Day = None
    ef_months: Months = None
    ef_monthly_override: Money = None
    monthly_amount: Money = None
    reminder_day: ReminderDay = None
    note: Note = None


class GoalUpdate(BaseModel):
    """Create's fields, all optional, minus `kind`; `archived` archives or restores."""

    model_config = ConfigDict(extra="forbid")

    name: Name = None
    target_amount: Money = None
    target_date: Day = None
    ef_months: Months = None
    ef_monthly_override: Money = None
    monthly_amount: Money = None
    reminder_day: ReminderDay = None
    note: Note = None
    archived: Flag = False


class GoalList(BaseModel):
    goals: list[GoalResponse]


class HistoryLine(BaseModel):
    id: int
    account_id: int
    account_name: str
    amount: str
    date: str
    note: str | None


class GoalDetail(GoalResponse):
    history: list[HistoryLine]


def _owned(db: DbSession, user_id: int, id: int, lock: bool = False) -> Goal:
    goal = None
    if 1 <= id <= MAX_ID:
        query = select(Goal).where(Goal.id == id, Goal.user_id == user_id)
        if lock:
            query = query.execution_options(populate_existing=True).with_for_update()
        goal = db.scalar(query)
    if goal is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)
    return goal


def _check(values: dict[str, Any]) -> None:
    """Every rule, reported together, on a goal's whole set of values."""
    errors: list[dict[str, Any]] = []
    name = values["name"]
    if name is None or not 1 <= len(name) <= 60:
        errors.append(field_error("name", _NAME))
    kind = values["kind"]
    if kind not in KINDS:
        errors.append(field_error("kind", _KIND))
    target = values["target_amount"]
    if kind == "custom":
        if target is None or target <= 0:
            errors.append(field_error("target_amount", _TARGET))
        for field in ("ef_months", "ef_monthly_override"):
            if values[field] is not None:
                errors.append(field_error(field, _EF_ONLY))
    elif kind == "emergency":
        if target is not None:
            errors.append(field_error("target_amount", _EF_TARGET))
        if values["ef_months"] is None:
            errors.append(field_error("ef_months", _MONTHS))
        override = values["ef_monthly_override"]
        if override is not None and override <= 0:
            errors.append(field_error("ef_monthly_override", _OVERRIDE))
    monthly = values["monthly_amount"]
    if monthly is not None:
        if monthly <= 0:
            errors.append(field_error("monthly_amount", _MONTHLY))
        elif values["reminder_day"] is None:
            errors.append(field_error("reminder_day", _DAY))
    if errors:
        raise RequestValidationError(errors)


def _emergency_taken(db: DbSession, user_id: int, except_id: int | None = None) -> bool:
    query = select(Goal.id).where(
        Goal.user_id == user_id, Goal.kind == "emergency", Goal.archived_at.is_(None)
    )
    if except_id is not None:
        query = query.where(Goal.id != except_id)
    return db.scalar(query.limit(1)) is not None


def _conflict() -> HTTPException:
    return HTTPException(status.HTTP_409_CONFLICT, _HAVE_EF)


def _apply_reminder(goal: Goal, was_on: bool, today: date) -> None:
    """The reminder is on while there is a monthly amount; turning it on starts this month."""
    if goal.monthly_amount is None:
        goal.reminder_day = None
        goal.reminder_start = None
    elif not was_on or goal.reminder_start is None:
        goal.reminder_start = today.replace(day=1)


@router.get("")
def list_goals(user: CurrentUser, db: DbSession, archived: bool = False) -> GoalList:
    book = load_goal_book(db, user.id, today_india())
    return GoalList(goals=[r for r in book.responses.values() if r.archived == archived])


@router.get("/{id}")
def get_goal(id: int, user: CurrentUser, db: DbSession) -> GoalDetail:
    goal = _owned(db, user.id, id)
    response = load_goal_book(db, user.id, today_india()).responses[goal.id]
    rows = db.execute(
        select(GoalEarmark, Account.name)
        .join(Account, Account.id == GoalEarmark.account_id)
        .where(GoalEarmark.user_id == user.id, GoalEarmark.goal_id == goal.id)
        .order_by(GoalEarmark.date.desc(), GoalEarmark.id.desc())
    ).all()
    history = [
        HistoryLine(
            id=e.id,
            account_id=e.account_id,
            account_name=name,
            amount=fmt(e.amount),
            date=e.date.isoformat(),
            note=e.note,
        )
        for e, name in rows
    ]
    return GoalDetail(**response.model_dump(), history=history)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_goal(body: GoalCreate, user: CurrentUser, db: DbSession) -> GoalResponse:
    values = body.model_dump()
    if values["kind"] == "emergency" and values["ef_months"] is None:
        values["ef_months"] = DEFAULT_EF_MONTHS
    _check(values)
    today = today_india()
    if values["kind"] == "emergency" and _emergency_taken(db, user.id):
        raise _conflict()
    goal = Goal(user_id=user.id, **values)
    _apply_reminder(goal, False, today)
    db.add(goal)
    try:
        db.commit()
    except IntegrityError:  # a second one was saved at the same moment
        db.rollback()
        raise _conflict() from None
    return load_goal_book(db, user.id, today).responses[goal.id]


@router.patch("/{id}")
def update_goal(id: int, body: GoalUpdate, user: CurrentUser, db: DbSession) -> GoalResponse:
    changes = body.model_dump(exclude_unset=True)
    _owned(db, user.id, id)
    goal = _owned(db, user.id, id, lock=True)
    archive = changes.pop("archived", None)
    values = {
        "name": goal.name,
        "kind": goal.kind,
        "target_amount": goal.target_amount,
        "target_date": goal.target_date,
        "ef_months": goal.ef_months,
        "ef_monthly_override": goal.ef_monthly_override,
        "monthly_amount": goal.monthly_amount,
        "reminder_day": goal.reminder_day,
        "note": goal.note,
        **changes,
    }
    _check(values)
    today = today_india()
    was_on = goal.monthly_amount is not None
    restoring = archive is False and goal.archived_at is not None
    if restoring and goal.kind == "emergency" and _emergency_taken(db, user.id, goal.id):
        raise _conflict()
    for field, value in values.items():
        if field != "kind":
            setattr(goal, field, value)
    _apply_reminder(goal, was_on, today)
    if archive is True and goal.archived_at is None:
        goal.archived_at = func.now()
    elif archive is False:
        goal.archived_at = None
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise _conflict() from None
    return load_goal_book(db, user.id, today).responses[goal.id]


@router.delete("/{id}")
def delete_goal(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    _owned(db, user.id, id)
    goal = _owned(db, user.id, id, lock=True)
    if db.scalar(select(GoalEarmark.id).where(GoalEarmark.goal_id == goal.id).limit(1)):
        raise HTTPException(status.HTTP_409_CONFLICT, _HISTORY)
    for holding in db.scalars(select(GoalHolding).where(GoalHolding.goal_id == goal.id)):
        db.delete(holding)
    db.delete(goal)
    db.commit()
    return Deleted(id=id)
