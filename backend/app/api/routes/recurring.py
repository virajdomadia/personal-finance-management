"""Recurring reminders: a standing instruction that comes due on a schedule and never posts.

What is due is worked out from the transactions recorded against a template and the occurrences
skipped (`app.api.recurring`). Recording an occurrence is an ordinary transaction that carries the
template's id; the client pre-fills it from the template.
"""

from collections import defaultdict
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic_core import PydanticCustomError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from app.api.deps import CurrentUser, get_current_user
from app.api.recurring import TemplateRow
from app.api.recurring import status as occurrence_status
from app.api.routes.accounts import MAX_ID, Flag, Money, clean_text, field_error, fmt
from app.api.routes.dashboard import today_india
from app.api.routes.stocks import Deleted
from app.api.routes.transactions import (
    AccountRef,
    Category,
    Day,
    Note,
    lock_accounts,
    validate_transaction_values,
)
from app.db.session import DbSession
from app.models.account import Account
from app.models.insurance import InsurancePolicy
from app.models.recurring import RecurringSkip, RecurringTemplate
from app.models.transaction import Transaction

router = APIRouter(
    prefix="/recurring", tags=["recurring"], dependencies=[Depends(get_current_user)]
)

TYPES = ("expense", "income", "transfer")
_BAD_TYPE = "Choose expense, income or transfer."
_BAD_FREQUENCY = "Choose monthly or yearly."
_BAD_DAY = "Choose a day from 1 to 31."
_BAD_MONTH = "Choose a month."
_BAD_REMIND = "Enter a number of days from 0 to 60."
_ARCHIVED = " is archived. Restore it to use it."
_NOT_DUE = "That isn't a due date for this reminder."
DEFAULT_REMIND = {"monthly": 3, "yearly": 30}


def _int_in(low: int, high: int, kind: str, message: str) -> Any:
    def check(value: Any) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise PydanticCustomError(kind, message)
        return value

    return check


def _choice(options: tuple[str, ...], message: str) -> Any:
    def check(value: Any) -> Any:
        if value is not None and value not in options:
            raise PydanticCustomError("choice", message)
        return value

    return check


Name = Annotated[str | None, BeforeValidator(lambda v: clean_text(v, "Enter a name."))]
Kind = Annotated[str | None, BeforeValidator(_choice(TYPES, _BAD_TYPE))]
Frequency = Annotated[str | None, BeforeValidator(_choice(("monthly", "yearly"), _BAD_FREQUENCY))]
DayOfMonth = Annotated[int | None, BeforeValidator(_int_in(1, 31, "day", _BAD_DAY))]
MonthNumber = Annotated[int | None, BeforeValidator(_int_in(1, 12, "month", _BAD_MONTH))]
RemindDays = Annotated[int | None, BeforeValidator(_int_in(0, 60, "remind", _BAD_REMIND))]


class TemplateCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that missing ones are reported like any other rule.
    name: Name = None
    type: Kind = None
    amount: Money = None
    account_id: AccountRef = None
    to_account_id: AccountRef = None
    category: Category = None
    note: Note = None
    frequency: Frequency = None
    day: DayOfMonth = None
    month: MonthNumber = None
    start_date: Day = None
    end_date: Day = None
    remind_days: RemindDays = None


class TemplateUpdate(BaseModel):
    """Create's fields, all optional, minus `type`; the type is what its transactions share."""

    model_config = ConfigDict(extra="forbid")

    name: Name = None
    amount: Money = None
    account_id: AccountRef = None
    to_account_id: AccountRef = None
    category: Category = None
    note: Note = None
    frequency: Frequency = None
    day: DayOfMonth = None
    month: MonthNumber = None
    start_date: Day = None
    end_date: Day = None
    remind_days: RemindDays = None
    active: Flag = True


class SkipBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurrence: Day = None


class TemplateResponse(BaseModel):
    id: int
    name: str
    type: str
    amount: str
    account_id: int
    account_name: str
    to_account_id: int | None
    to_account_name: str | None
    category: str | None
    note: str | None
    frequency: str
    day: int
    month: int | None
    start_date: str
    end_date: str | None
    remind_days: int
    active: bool
    policy_id: int | None
    due: list[str]
    coming_up: str | None
    recorded: int


class TemplateList(BaseModel):
    templates: list[TemplateResponse]


class DueItem(BaseModel):
    template: TemplateResponse
    occurrence: str
    state: Literal["due", "coming_up"]


class DueList(BaseModel):
    items: list[DueItem]


def _row(t: RecurringTemplate) -> TemplateRow:
    return TemplateRow(
        t.id, t.frequency, t.day, t.month, t.start_date, t.end_date, t.remind_days, t.active
    )


def template_responses(
    db: Session, user_id: int, today: date, ids: list[int] | None = None
) -> list[TemplateResponse]:
    """The user's templates (or just `ids`), by name then id."""
    target = aliased(Account)
    query = (
        select(RecurringTemplate, Account, target)
        .join(
            Account,
            (Account.id == RecurringTemplate.account_id) & (Account.user_id == user_id),
        )
        .outerjoin(
            target,
            (target.id == RecurringTemplate.to_account_id) & (target.user_id == user_id),
        )
        .where(RecurringTemplate.user_id == user_id)
    )
    if ids is not None:
        query = query.where(RecurringTemplate.id.in_(ids))
    rows = sorted(db.execute(query).all(), key=lambda r: (r[0].name.casefold(), r[0].id))

    paid: dict[int, list[date]] = defaultdict(list)
    for template_id, day in db.execute(
        select(Transaction.recurring_template_id, Transaction.date).where(
            Transaction.user_id == user_id, Transaction.recurring_template_id.is_not(None)
        )
    ):
        paid[template_id].append(day)
    skips: dict[int, set[date]] = defaultdict(set)
    for template_id, occurrence in db.execute(
        select(RecurringSkip.template_id, RecurringSkip.occurrence).where(
            RecurringSkip.user_id == user_id
        )
    ):
        skips[template_id].add(occurrence)
    policies = dict(
        db.execute(
            select(InsurancePolicy.template_id, InsurancePolicy.id).where(
                InsurancePolicy.user_id == user_id
            )
        ).all()
    )

    out = []
    for t, account, to_account in rows:
        found = occurrence_status(_row(t), paid[t.id], skips[t.id], today)
        out.append(
            TemplateResponse(
                id=t.id,
                name=t.name,
                type=t.type,
                amount=fmt(t.amount),
                account_id=account.id,
                account_name=account.name,
                to_account_id=t.to_account_id,
                to_account_name=None if to_account is None else to_account.name,
                category=t.category,
                note=t.note,
                frequency=t.frequency,
                day=t.day,
                month=t.month,
                start_date=t.start_date.isoformat(),
                end_date=None if t.end_date is None else t.end_date.isoformat(),
                remind_days=t.remind_days,
                active=t.active,
                policy_id=policies.get(t.id),
                due=[d.isoformat() for d in found.due],
                coming_up=None if found.coming_up is None else found.coming_up.isoformat(),
                recorded=len(paid[t.id]),
            )
        )
    return out


def due_items(db: Session, user_id: int, today: date) -> list[DueItem]:
    """Every due or coming-up occurrence: due first, oldest first, then coming up, soonest first."""
    items = []
    for template in template_responses(db, user_id, today):
        items.extend(DueItem(template=template, occurrence=d, state="due") for d in template.due)
        if template.coming_up is not None:
            items.append(
                DueItem(template=template, occurrence=template.coming_up, state="coming_up")
            )
    return sorted(items, key=lambda i: (i.state != "due", i.occurrence, i.template.id))


def _owned(db: Session, user_id: int, id: int, lock: bool = False) -> RecurringTemplate:
    """The user's template; `lock` re-reads it under its own row lock (it may be gone by then)."""
    template = None
    if 1 <= id <= MAX_ID:
        query = select(RecurringTemplate).where(
            RecurringTemplate.id == id, RecurringTemplate.user_id == user_id
        )
        if lock:
            query = query.execution_options(populate_existing=True).with_for_update()
        template = db.scalar(query)
    if template is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reminder not found.")
    return template


def check_template_values(
    values: dict[str, Any], accounts: dict[int, Account], today: date, money: bool = True
) -> None:
    """Every rule, reported together. The money rules are a transaction's own."""
    errors: list[dict[str, Any]] = []
    if values["name"] is None:
        errors.append(field_error("name", "Enter a name."))
    type_ok = values["type"] in TYPES
    if not type_ok:
        errors.append(field_error("type", _BAD_TYPE))
    if values["frequency"] is None:
        errors.append(field_error("frequency", _BAD_FREQUENCY))
    if values["day"] is None:
        errors.append(field_error("day", _BAD_DAY))
    if values["frequency"] == "yearly" and values["month"] is None:
        errors.append(field_error("month", _BAD_MONTH))
    start, end = values["start_date"], values["end_date"]
    if start is not None and end is not None and end < start:
        errors.append(field_error("end_date", "The end date can't be before the start."))
    # A transaction can't be dated ahead, but a reminder may start ahead, so the check is
    # shown a date that never is.
    probe = {
        "type": values["type"] if type_ok else None,
        "amount": values["amount"],
        "account_id": values["account_id"],
        "to_account_id": values["to_account_id"],
        "category": values["category"],
        "interest": None,
        "date": None if start is None else min(start, today),
    }
    try:
        validate_transaction_values(probe, accounts)
    except RequestValidationError as error:
        for e in error.errors():
            field = e["loc"][1]
            if field == "type" and not type_ok:
                continue  # already reported, in this form's words
            if not money and e["msg"].endswith(_ARCHIVED):
                continue  # stopping works whatever has happened to its accounts
            errors.append(field_error("start_date" if field == "date" else field, e["msg"]))
    if errors:
        raise RequestValidationError(errors)


def _columns(values: dict[str, Any]) -> dict[str, Any]:
    """Only a yearly reminder has a month."""
    return {**values, "month": values["month"] if values["frequency"] == "yearly" else None}


@router.get("")
def list_templates(user: CurrentUser, db: DbSession) -> TemplateList:
    return TemplateList(templates=template_responses(db, user.id, today_india()))


@router.get("/due")
def list_due(user: CurrentUser, db: DbSession) -> DueList:
    return DueList(items=due_items(db, user.id, today_india()))


@router.post("", status_code=status.HTTP_201_CREATED)
def create_template(body: TemplateCreate, user: CurrentUser, db: DbSession) -> TemplateResponse:
    values = body.model_dump()
    if values["remind_days"] is None:
        values["remind_days"] = DEFAULT_REMIND.get(values["frequency"] or "", 3)
    today = today_india()
    accounts = lock_accounts(db, user.id, [values["account_id"], values["to_account_id"]])
    check_template_values(values, accounts, today)
    template = RecurringTemplate(user_id=user.id, **_columns(values))
    db.add(template)
    db.commit()
    return template_responses(db, user.id, today, [template.id])[0]


@router.patch("/{id}")
def update_template(
    id: int, body: TemplateUpdate, user: CurrentUser, db: DbSession
) -> TemplateResponse:
    changes = body.model_dump(exclude_unset=True)
    template = _owned(db, user.id, id)
    # Its own accounts are locked too, so they can't be archived while it is being saved.
    seen = (template.account_id, template.to_account_id)
    accounts = lock_accounts(
        db, user.id, [*seen, changes.get("account_id"), changes.get("to_account_id")]
    )
    template = _owned(db, user.id, id, lock=True)
    if (template.account_id, template.to_account_id) != seen:  # moved meanwhile
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This reminder changed while saving. Try again."
        )
    values = {
        "name": template.name,
        "type": template.type,
        "amount": template.amount,
        "account_id": template.account_id,
        "to_account_id": template.to_account_id,
        "category": template.category,
        "note": template.note,
        "frequency": template.frequency,
        "day": template.day,
        "month": template.month,
        "start_date": template.start_date,
        "end_date": template.end_date,
        "remind_days": template.remind_days,
        "active": template.active,
        **changes,
    }
    if values["remind_days"] is None:
        values["remind_days"] = DEFAULT_REMIND.get(values["frequency"] or "", 3)
    today = today_india()
    # A reminder that will be active must still be recordable; stopping one always works.
    check_template_values(values, accounts, today, money=bool(values["active"]))
    for field, value in _columns(values).items():
        setattr(template, field, value)
    db.commit()
    return template_responses(db, user.id, today, [template.id])[0]


@router.delete("/{id}")
def delete_template(id: int, user: CurrentUser, db: DbSession) -> Deleted:
    _owned(db, user.id, id)
    # Locking the row makes a transaction linking to it wait, so the check below stays true.
    template = _owned(db, user.id, id, lock=True)
    stopped = HTTPException(
        status.HTTP_409_CONFLICT, "This reminder has recorded transactions. Stop it instead."
    )
    linked = db.scalar(
        select(Transaction.id)
        .where(Transaction.user_id == user.id, Transaction.recurring_template_id == template.id)
        .limit(1)
    )
    if linked is not None:
        raise stopped
    if db.scalar(select(InsurancePolicy.id).where(InsurancePolicy.template_id == template.id)):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This reminder belongs to an insurance policy."
        )
    try:
        for skip in db.scalars(
            select(RecurringSkip).where(
                RecurringSkip.user_id == user.id, RecurringSkip.template_id == template.id
            )
        ):
            db.delete(skip)
        db.delete(template)
        db.commit()
    except IntegrityError:  # a transaction or a policy was linked after all
        db.rollback()
        raise stopped from None
    return Deleted(id=id)


@router.post("/{id}/skip")
def skip_occurrence(id: int, body: SkipBody, user: CurrentUser, db: DbSession) -> TemplateResponse:
    _owned(db, user.id, id)
    template = _owned(db, user.id, id, lock=True)
    today = today_india()
    paid = list(
        db.scalars(
            select(Transaction.date).where(
                Transaction.user_id == user.id, Transaction.recurring_template_id == id
            )
        )
    )
    skipped = set(
        db.scalars(
            select(RecurringSkip.occurrence).where(
                RecurringSkip.user_id == user.id, RecurringSkip.template_id == id
            )
        )
    )
    found = occurrence_status(_row(template), paid, skipped, today)
    # What is shown can be skipped; an already skipped date stays accepted (idempotent).
    open_ = {*found.due, *([found.coming_up] if found.coming_up else []), *skipped}
    if body.occurrence is None or body.occurrence not in open_:
        raise RequestValidationError([field_error("occurrence", _NOT_DUE)])
    if body.occurrence not in skipped:  # skipping twice is the same as once
        db.add(RecurringSkip(user_id=user.id, template_id=id, occurrence=body.occurrence))
        db.commit()
    return template_responses(db, user.id, today, [id])[0]


@router.delete("/{id}/skip/{occurrence}")
def unskip_occurrence(
    id: int, occurrence: date, user: CurrentUser, db: DbSession
) -> TemplateResponse:
    _owned(db, user.id, id)
    _owned(db, user.id, id, lock=True)
    skip = db.scalar(
        select(RecurringSkip).where(
            RecurringSkip.user_id == user.id,
            RecurringSkip.template_id == id,
            RecurringSkip.occurrence == occurrence,
        )
    )
    if skip is not None:
        db.delete(skip)
        db.commit()
    return template_responses(db, user.id, today_india(), [id])[0]
