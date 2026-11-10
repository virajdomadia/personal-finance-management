"""Goals: a named target funded by earmarked money and whole holdings.

A goal never moves money. The emergency fund's target is worked out from recent spending.
The figures live in `app.api.goals`; this module is the routes: goals, their baskets (earmarked
money and whole holdings), archive and restore.
"""

from datetime import date
from decimal import Decimal
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
from app.api.portfolio import load_trade_rows, replay
from app.api.routes.accounts import MAX_ID, Money, Ref, clean_text, field_error, fmt, rupees
from app.api.routes.stocks import Deleted
from app.api.routes.transactions import lock_accounts
from app.db.session import DbSession
from app.models.account import Account
from app.models.goal import Goal, GoalEarmark, GoalHolding
from app.models.investment import Instrument

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
_ACTIONS = ("set_aside", "release")
_ACTION = "Choose set aside or release."
_AMOUNT = "Enter an amount greater than 0."
_FUTURE = "Choose today or an earlier date."
_SOURCE = "Set money aside from a bank, cash or wallet account."
_SOURCE_TYPES = ("bank", "cash", "wallet")
_ARCHIVED = "Restore this goal first."
_LATER_RELEASE = "Delete the later release first."
_ENTRY_NOT_FOUND = "Entry not found."
_HOLDING_NOT_FOUND = "Holding not found."
_CHOOSE_HOLDING = "Choose a fund, stock, coin, PPF or RD."
_DEPOSIT = "Choose a PPF or RD account."
_DEPOSIT_TYPES = ("ppf", "rd")
_CHANGED = "This goal changed while saving. Try again."


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


def _action(value: Any) -> Any:
    if value is not None and value not in _ACTIONS:
        raise PydanticCustomError("action", _ACTION)
    return value


Name = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, _NAME, limit=1000))]
Note = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, "Enter a note.", limit=200))]
Kind = Annotated[str | None, BeforeValidator(_kind)]
Months = Annotated[int | None, BeforeValidator(_int_in(1, 24, _MONTHS))]
ReminderDay = Annotated[int | None, BeforeValidator(_int_in(1, 31, _DAY))]
Day = Annotated[date | None, BeforeValidator(iso_date)]
Action = Annotated[str | None, BeforeValidator(_action)]


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
    """Create's fields, all optional, minus `kind`. Archive and restore have their own routes."""

    model_config = ConfigDict(extra="forbid")

    name: Name = None
    target_amount: Money = None
    target_date: Day = None
    ef_months: Months = None
    ef_monthly_override: Money = None
    monthly_amount: Money = None
    reminder_day: ReminderDay = None
    note: Note = None


class EarmarkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: Ref = None
    action: Action = None
    amount: Money = None
    date: Day = None  # defaults to today
    note: Note = None


class HoldingCreate(BaseModel):
    """Exactly one of the two: an instrument with units held, or a PPF or RD account."""

    model_config = ConfigDict(extra="forbid")

    instrument_id: Ref = None
    account_id: Ref = None


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
    for field, value in values.items():
        if field != "kind":
            setattr(goal, field, value)
    _apply_reminder(goal, was_on, today)
    db.commit()
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


# Baskets. Every change locks the goal row, so two changes to one goal take turns.


def _locked_active(db: DbSession, user_id: int, id: int) -> Goal:
    goal = _owned(db, user_id, id, lock=True)
    if goal.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, _ARCHIVED)
    return goal


def _earmarked(db: DbSession, goal_id: int, account_id: int) -> Decimal:
    """The goal's earmark in one account: the sum of its entries there."""
    amounts = db.scalars(
        select(GoalEarmark.amount).where(
            GoalEarmark.goal_id == goal_id, GoalEarmark.account_id == account_id
        )
    )
    return sum(amounts, Decimal("0.00"))


@router.post("/{id}/earmarks", status_code=status.HTTP_201_CREATED)
def add_earmark(id: int, body: EarmarkCreate, user: CurrentUser, db: DbSession) -> GoalResponse:
    """Set money aside in an account for the goal, or release some. No money moves."""
    _owned(db, user.id, id)
    today = today_india()
    errors: list[dict[str, Any]] = []
    if body.account_id is None:
        errors.append(field_error("account_id", _SOURCE))
    if body.action is None:
        errors.append(field_error("action", _ACTION))
    if body.amount is None or body.amount <= 0:
        errors.append(field_error("amount", _AMOUNT))
    if body.date is not None and body.date > today:
        errors.append(field_error("date", _FUTURE))
    if errors:
        raise RequestValidationError(errors)
    assert body.account_id is not None and body.amount is not None

    # Accounts first, then the goal: the same order as everything else that locks accounts.
    account = lock_accounts(db, user.id, [body.account_id]).get(body.account_id)
    goal = _locked_active(db, user.id, id)
    if account is None or account.archived_at is not None or account.type not in _SOURCE_TYPES:
        raise RequestValidationError([field_error("account_id", _SOURCE)])
    amount = body.amount
    if body.action == "release":
        held = _earmarked(db, goal.id, account.id)
        if amount > held:
            message = f"Only {rupees(held)} of {account.name} is set aside for this goal."
            raise RequestValidationError([field_error("amount", message)])
        amount = -amount
    db.add(
        GoalEarmark(
            user_id=user.id,
            goal_id=goal.id,
            account_id=account.id,
            amount=amount,
            date=body.date or today,
            note=body.note,
        )
    )
    db.commit()
    return load_goal_book(db, user.id, today).responses[goal.id]


def _entry(db: DbSession, user_id: int, goal_id: int, entry_id: int) -> GoalEarmark:
    entry = None
    if 1 <= entry_id <= MAX_ID:
        entry = db.scalar(
            select(GoalEarmark)
            .where(
                GoalEarmark.id == entry_id,
                GoalEarmark.goal_id == goal_id,
                GoalEarmark.user_id == user_id,
            )
            .execution_options(populate_existing=True)
        )
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _ENTRY_NOT_FOUND)
    return entry


@router.delete("/{id}/earmarks/{entry_id}")
def delete_earmark(id: int, entry_id: int, user: CurrentUser, db: DbSession) -> Deleted:
    _owned(db, user.id, id)
    entry = _entry(db, user.id, id, entry_id)
    lock_accounts(db, user.id, [entry.account_id])
    goal = _locked_active(db, user.id, id)
    entry = _entry(db, user.id, goal.id, entry_id)  # read again now that the goal is locked
    if _earmarked(db, goal.id, entry.account_id) - entry.amount < 0:
        raise HTTPException(status.HTTP_409_CONFLICT, _LATER_RELEASE)
    db.delete(entry)
    db.commit()
    return Deleted(id=entry_id)


def _active_holder(db: DbSession, user_id: int, target: tuple[str, int]) -> str | None:
    """The name of the active goal that has this instrument or account, if any."""
    column = GoalHolding.instrument_id if target[0] == "instrument" else GoalHolding.account_id
    return db.scalar(
        select(Goal.name)
        .join(GoalHolding, GoalHolding.goal_id == Goal.id)
        .where(GoalHolding.user_id == user_id, column == target[1], GoalHolding.active.is_(True))
        .limit(1)
    )


def _holding_name(db: DbSession, user_id: int, holding: GoalHolding) -> str:
    if holding.instrument_id is not None:
        instrument = db.get(Instrument, holding.instrument_id)
        assert instrument is not None and instrument.user_id == user_id
        return instrument.name
    account = db.get(Account, holding.account_id)
    assert account is not None and account.user_id == user_id
    return account.name


@router.post("/{id}/holdings", status_code=status.HTTP_201_CREATED)
def add_holding(id: int, body: HoldingCreate, user: CurrentUser, db: DbSession) -> GoalResponse:
    """Put a whole instrument or a PPF or RD in the goal. It can be in one active goal at most."""
    _owned(db, user.id, id)
    if (body.instrument_id is None) == (body.account_id is None):
        raise RequestValidationError([field_error("instrument_id", _CHOOSE_HOLDING)])
    goal = _locked_active(db, user.id, id)

    name: str
    account: Account | None = None
    if body.instrument_id is not None:
        target = ("instrument", body.instrument_id)
        instrument = None
        if 1 <= body.instrument_id <= MAX_ID:
            instrument = db.scalar(
                select(Instrument).where(
                    Instrument.id == body.instrument_id, Instrument.user_id == user.id
                )
            )
        if instrument is None:
            raise RequestValidationError([field_error("instrument_id", _CHOOSE_HOLDING)])
        name = instrument.name
    else:
        assert body.account_id is not None
        target = ("account", body.account_id)
        if 1 <= body.account_id <= MAX_ID:
            account = db.scalar(
                select(Account).where(Account.id == body.account_id, Account.user_id == user.id)
            )
        if account is None:
            raise RequestValidationError([field_error("account_id", _DEPOSIT)])
        name = account.name

    holder = _active_holder(db, user.id, target)
    if holder is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"{name} is already in {holder}.")
    if body.instrument_id is not None:
        result = replay(load_trade_rows(db, user.id))
        held = any(
            pos.instrument_id == body.instrument_id and pos.quantity > 0
            for pos in result.positions.values()
        )
        if not held:
            message = f"You don't hold any {name}."
            raise RequestValidationError([field_error("instrument_id", message)])
    elif account is None or account.archived_at is not None or account.type not in _DEPOSIT_TYPES:
        raise RequestValidationError([field_error("account_id", _DEPOSIT)])

    db.add(
        GoalHolding(
            user_id=user.id,
            goal_id=goal.id,
            instrument_id=body.instrument_id,
            account_id=body.account_id,
        )
    )
    try:
        db.commit()
    except IntegrityError:  # another goal took it at the same moment
        db.rollback()
        holder = _active_holder(db, user.id, target)
        detail = _CHANGED if holder is None else f"{name} is already in {holder}."
        raise HTTPException(status.HTTP_409_CONFLICT, detail) from None
    return load_goal_book(db, user.id, today_india()).responses[goal.id]


@router.delete("/{id}/holdings/{holding_id}")
def delete_holding(id: int, holding_id: int, user: CurrentUser, db: DbSession) -> Deleted:
    """Take a holding out of the goal. Allowed on an archived goal, so it can be restored."""
    _owned(db, user.id, id)
    goal = _owned(db, user.id, id, lock=True)
    holding = None
    if 1 <= holding_id <= MAX_ID:
        holding = db.scalar(
            select(GoalHolding).where(
                GoalHolding.id == holding_id,
                GoalHolding.goal_id == goal.id,
                GoalHolding.user_id == user.id,
            )
        )
    if holding is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _HOLDING_NOT_FOUND)
    db.delete(holding)
    db.commit()
    return Deleted(id=holding_id)


def _holdings_of(db: DbSession, goal: Goal) -> list[GoalHolding]:
    return list(
        db.scalars(
            select(GoalHolding).where(GoalHolding.goal_id == goal.id).order_by(GoalHolding.id)
        )
    )


@router.post("/{id}/archive")
def archive_goal(id: int, user: CurrentUser, db: DbSession) -> GoalResponse:
    """Its earmarks stop counting and its holdings are free to join another goal."""
    _owned(db, user.id, id)
    goal = _owned(db, user.id, id, lock=True)
    if goal.archived_at is None:
        goal.archived_at = func.now()
        for holding in _holdings_of(db, goal):
            holding.active = False
        db.commit()
    return load_goal_book(db, user.id, today_india()).responses[goal.id]


def _restore_problem(db: DbSession, user_id: int, goal: Goal) -> str | None:
    if goal.kind == "emergency" and _emergency_taken(db, user_id, goal.id):
        return _HAVE_EF
    for holding in _holdings_of(db, goal):
        if holding.instrument_id is not None:
            target = ("instrument", holding.instrument_id)
        else:
            assert holding.account_id is not None
            target = ("account", holding.account_id)
        holder = _active_holder(db, user_id, target)
        if holder is not None:
            return f"{_holding_name(db, user_id, holding)} is in {holder} now."
    return None


@router.post("/{id}/restore")
def restore_goal(id: int, user: CurrentUser, db: DbSession) -> GoalResponse:
    """Counts its earmarks and holdings again, unless that would put something in two goals."""
    _owned(db, user.id, id)
    # Accounts first, then the goal: the same order as add_earmark.
    seen = db.scalars(select(GoalEarmark.account_id).where(GoalEarmark.goal_id == id).distinct())
    accounts = lock_accounts(db, user.id, seen)
    goal = _owned(db, user.id, id, lock=True)
    if goal.archived_at is not None:
        for account_id in sorted(a for a in accounts if _earmarked(db, id, a) != 0):
            if accounts[account_id].archived_at is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"{accounts[account_id].name} is archived. Restore it first.",
                )
        problem = _restore_problem(db, user.id, goal)
        if problem is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, problem)
        goal.archived_at = None
        for holding in _holdings_of(db, goal):
            holding.active = True
        try:
            db.commit()
        except IntegrityError:  # an emergency fund or one of its holdings was taken meanwhile
            db.rollback()
            goal = _owned(db, user.id, id)
            problem = _restore_problem(db, user.id, goal)
            raise HTTPException(status.HTTP_409_CONFLICT, problem or _CHANGED) from None
    return load_goal_book(db, user.id, today_india()).responses[goal.id]
