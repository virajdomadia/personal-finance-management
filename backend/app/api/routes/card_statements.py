"""A credit card's statements: list them with where the current bill stands, and enter, correct or
remove one by hand. See `app.models.card_statement` and `app.api.card_statements`."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.card_statements import Status, latest_statement, standing, unbilled
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.routes.accounts import MAX_ID, Money, field_error, fmt
from app.api.routes.transactions import Day
from app.db.session import DbSession
from app.models.account import Account
from app.models.card_statement import CardStatement

router = APIRouter(tags=["card statements"], dependencies=[Depends(get_current_user)])

MINIMUM_RULE = "The minimum can't be more than the total."


class StatementCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required fields are optional here so that they are reported like any other rule.
    statement_date: Day = None
    total_due: Money = None
    minimum_due: Money = None  # optional
    due_date: Day = None


class StatementUpdate(StatementCreate):
    """The same fields, any of them."""


class StatementResponse(BaseModel):
    id: int
    account_id: int
    statement_date: str
    total_due: str
    minimum_due: str | None
    due_date: str
    source: str


class CurrentBill(BaseModel):
    statement: StatementResponse
    paid: str
    left: str
    extra: str
    minimum_left: str | None
    status: Status
    overdue: bool


class StatementList(BaseModel):
    statements: list[StatementResponse]  # newest first
    current: CurrentBill | None  # the latest statement's bill
    unbilled: str  # charged since the latest statement


def _response(s: CardStatement) -> StatementResponse:
    return StatementResponse(
        id=s.id,
        account_id=s.account_id,
        statement_date=s.statement_date.isoformat(),
        total_due=fmt(s.total_due),
        minimum_due=None if s.minimum_due is None else fmt(s.minimum_due),
        due_date=s.due_date.isoformat(),
        source=s.source,
    )


def _card(db: DbSession, user_id: int, id: int, writing: bool = False) -> Account:
    account = None
    if 1 <= id <= MAX_ID:
        account = db.scalar(select(Account).where(Account.id == id, Account.user_id == user_id))
    if account is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    if account.type != "credit_card":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a credit card has statements.")
    if writing and account.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Restore this card before changing it.")
    return account


def _statement(db: DbSession, user_id: int, id: int) -> CardStatement:
    found = None
    if 1 <= id <= MAX_ID:
        found = db.scalar(
            select(CardStatement).where(CardStatement.id == id, CardStatement.user_id == user_id)
        )
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Statement not found.")
    return found


def _check(values: dict[str, Any]) -> None:
    errors: list[dict[str, Any]] = []
    on, due = values["statement_date"], values["due_date"]
    if on is None:
        errors.append(field_error("statement_date", "Choose the statement date."))
    elif on > today_india():
        errors.append(field_error("statement_date", "The date can't be in the future."))
    if due is None:
        errors.append(field_error("due_date", "Choose the due date."))
    elif on is not None and due < on:
        errors.append(field_error("due_date", "The due date can't be before the statement."))
    total, minimum = values["total_due"], values["minimum_due"]
    if total is None:
        errors.append(field_error("total_due", "Enter the total due."))
    elif total < 0:
        errors.append(field_error("total_due", "The total can't be negative."))
    if minimum is not None and minimum < 0:
        errors.append(field_error("minimum_due", "The minimum can't be negative."))
    elif minimum is not None and total is not None and total >= 0 and minimum > total:
        errors.append(field_error("minimum_due", MINIMUM_RULE))
    if errors:
        raise RequestValidationError(errors)


def _save(db: DbSession, card: Account, row: CardStatement) -> None:
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        when = row.statement_date.isoformat()
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"{card.name} already has a statement dated {when}."
        ) from None


@router.get("/accounts/{id}/statements")
def list_statements(id: int, user: CurrentUser, db: DbSession) -> StatementList:
    card = _card(db, user.id, id)
    rows = list(
        db.scalars(
            select(CardStatement)
            .where(CardStatement.user_id == user.id, CardStatement.account_id == card.id)
            .order_by(CardStatement.statement_date.desc(), CardStatement.id.desc())
        )
    )
    latest = latest_statement(db, user.id, card.id)
    current = None
    if latest is not None:
        s = standing(db, user.id, latest, today_india())
        current = CurrentBill(
            statement=_response(latest),
            paid=fmt(s.paid),
            left=fmt(s.left),
            extra=fmt(s.extra),
            minimum_left=None if s.minimum_left is None else fmt(s.minimum_left),
            status=s.status,
            overdue=s.overdue,
        )
    since = None if latest is None else latest.statement_date
    return StatementList(
        statements=[_response(r) for r in rows],
        current=current,
        unbilled=fmt(unbilled(db, user.id, card.id, since)),
    )


@router.post("/accounts/{id}/statements", status_code=status.HTTP_201_CREATED)
def create_statement(
    id: int, body: StatementCreate, user: CurrentUser, db: DbSession
) -> StatementResponse:
    card = _card(db, user.id, id, writing=True)
    values = body.model_dump()
    _check(values)
    row = CardStatement(user_id=user.id, account_id=card.id, source="manual", **values)
    db.add(row)
    _save(db, card, row)
    return _response(row)


@router.patch("/card-statements/{id}")
def update_statement(
    id: int, body: StatementUpdate, user: CurrentUser, db: DbSession
) -> StatementResponse:
    row = _statement(db, user.id, id)
    card = _card(db, user.id, row.account_id, writing=True)
    values: dict[str, Any] = {
        "statement_date": row.statement_date,
        "total_due": row.total_due,
        "minimum_due": row.minimum_due,
        "due_date": row.due_date,
        **body.model_dump(exclude_unset=True),
    }
    _check(values)
    for field, value in values.items():
        setattr(row, field, value)
    # Corrected by the owner, so a later SMS for it no longer changes it.
    row.source = "manual"
    _save(db, card, row)
    return _response(row)


@router.delete("/card-statements/{id}")
def delete_statement(id: int, user: CurrentUser, db: DbSession) -> dict[str, int]:
    row = _statement(db, user.id, id)
    _card(db, user.id, row.account_id, writing=True)
    db.delete(row)
    db.commit()
    return {"id": id}
