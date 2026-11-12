from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select

from app.api.balances import Movement, balance_of, load_movements
from app.api.categories import ensure_seeded
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.loans import load_book
from app.api.routes.accounts import AccountResponse, Money, account_response, field_error
from app.api.routes.transactions import AccountRef, Day, balance_problem, lock_accounts
from app.db.session import DbSession
from app.models.transaction import Transaction

router = APIRouter(prefix="/accounts", tags=["deposits"], dependencies=[Depends(get_current_user)])

INTEREST_CATEGORY = "Interest"
FEE_CATEGORY = "Fees and charges"


class CloseRd(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Optional here so that the rules below report a missing value like any other problem.
    amount: Money = None
    date: Day = None
    account_id: AccountRef = None


@router.post("/{id}/close-rd")
def close_rd(id: int, body: CloseRd, user: CurrentUser, db: DbSession) -> AccountResponse:
    """Pays an RD out to a bank at its real maturity amount and archives it, in one commit."""
    accounts = lock_accounts(db, user.id, [id, body.account_id])
    rd = accounts.get(id)
    if rd is None or rd.type != "rd":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    if rd.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This RD is already closed.")

    errors: list[dict[str, Any]] = []
    if body.amount is None:
        errors.append(field_error("amount", "Enter the amount received."))
    elif body.amount <= 0:
        errors.append(field_error("amount", "Amount must be greater than 0."))
    if body.date is None:
        errors.append(field_error("date", "Choose a date."))
    elif body.date > today_india():
        errors.append(field_error("date", "The date can't be in the future."))
    elif rd.opened_on is not None and body.date < rd.opened_on:
        errors.append(field_error("date", "The date can't be before the RD was opened."))
    else:
        latest = db.scalar(
            select(func.max(Transaction.date)).where(
                Transaction.user_id == user.id,
                or_(Transaction.account_id == rd.id, Transaction.to_account_id == rd.id),
            )
        )
        if latest is not None and body.date < latest:
            errors.append(
                field_error(
                    "date",
                    "The RD has transactions after this date. "
                    f"Choose {latest.isoformat()} or later.",
                )
            )
    bank = None if body.account_id is None else accounts.get(body.account_id)
    if bank is None or bank.type != "bank" or bank.archived_at is not None:
        errors.append(field_error("account_id", "Choose the bank the money goes to."))
    # The checks above already report each of these, so `errors` is never empty when one is None.
    if errors or body.amount is None or body.date is None or bank is None:
        raise RequestValidationError(errors)

    book = load_book(db, user.id)
    difference = body.amount - balance_of(rd, book.flows)
    rows = [
        _row(user.id, "income", difference, rd.id, body, INTEREST_CATEGORY, "Interest on closing")
        if difference > 0
        else _row(user.id, "expense", -difference, rd.id, body, FEE_CATEGORY, "Closed early")
        if difference < 0
        else None,
        Transaction(
            user_id=user.id,
            type="transfer",
            account_id=rd.id,
            to_account_id=bank.id,
            amount=body.amount,
            date=body.date,
            note="RD closed",
        ),
    ]
    added = [r for r in rows if r is not None]
    before = load_movements(db, user.id)
    after = [
        *before,
        *(Movement(0, r.type, r.amount, r.account_id, r.to_account_id) for r in added),
    ]
    problem = balance_problem(accounts, before, after)
    if problem:
        raise RequestValidationError([field_error("amount", problem)])

    ensure_seeded(db, user.id)  # its categories are fixed ones, so the defaults have them
    db.add_all(added)
    rd.archived_at = datetime.now(UTC)
    db.commit()
    return account_response(db, user.id, rd)


def _row(
    user_id: int,
    type_: str,
    amount: Decimal,
    account_id: int,
    body: CloseRd,
    category: str,
    note: str,
) -> Transaction:
    return Transaction(
        user_id=user_id,
        type=type_,
        account_id=account_id,
        amount=amount,
        date=body.date,
        category=category,
        note=note,
    )
