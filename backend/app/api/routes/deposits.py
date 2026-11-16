"""Closing an RD or FD, and renewing an FD, each in one all-or-nothing request."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, NamedTuple

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.balances import Movement, balance_of, load_movements
from app.api.categories import ensure_seeded
from app.api.dates import today_india
from app.api.deps import CurrentUser, get_current_user
from app.api.loans import load_book
from app.api.routes.accounts import (
    AccountResponse,
    Money,
    Name,
    Opened,
    Payout,
    Rate,
    account_response,
    field_error,
)
from app.api.routes.transactions import AccountRef, Day, balance_problem, lock_accounts
from app.db.session import DbSession
from app.models.account import Account
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


class RenewFd(CloseRd):
    """Close at `amount`, then put `reinvest` of it (all of it when left out) into a new FD.
    The money goes through the bank `account_id`, which keeps whatever is not reinvested."""

    reinvest: Money = None
    name: Name = None  # the old FD's name when left out
    interest_rate: Rate = None
    matures_on: Opened = None
    fd_payout: Payout = None


class Closing(NamedTuple):
    deposit: Account
    bank: Account
    amount: Decimal
    date: date
    rows: list[Transaction]


@router.post("/{id}/close-rd")
def close_rd(id: int, body: CloseRd, user: CurrentUser, db: DbSession) -> AccountResponse:
    """Pays an RD out to a bank at its real maturity amount and archives it, in one commit."""
    closing = _closing(db, user.id, id, "rd", body)
    return _commit_close(db, user.id, closing)


@router.post("/{id}/close-fd")
def close_fd(id: int, body: CloseRd, user: CurrentUser, db: DbSession) -> AccountResponse:
    """Pays an FD out to a bank at the amount received and archives it, in one commit."""
    closing = _closing(db, user.id, id, "fd", body)
    return _commit_close(db, user.id, closing)


@router.post("/{id}/renew-fd", status_code=status.HTTP_201_CREATED)
def renew_fd(id: int, body: RenewFd, user: CurrentUser, db: DbSession) -> AccountResponse:
    """Closes an FD at the amount received and opens a new FD with some or all of it, through the
    bank, in one commit. Returns the new FD."""
    renew_errors: list[dict[str, Any]] = []
    if body.interest_rate is None:
        renew_errors.append(field_error("interest_rate", "Enter the yearly interest rate."))
    if body.fd_payout is None:
        renew_errors.append(field_error("fd_payout", "Choose how the interest is paid."))
    if body.matures_on is None:
        renew_errors.append(field_error("matures_on", "Choose the maturity date."))
    elif body.date is not None and body.matures_on <= body.date:
        renew_errors.append(
            field_error("matures_on", "Choose a maturity date after the renewal date.")
        )
    if body.reinvest is not None and body.reinvest <= 0:
        renew_errors.append(field_error("reinvest", "Amount must be greater than 0."))
    elif body.reinvest is not None and body.amount is not None and body.reinvest > body.amount:
        renew_errors.append(
            field_error("reinvest", "You can't renew more than the amount received.")
        )

    closing = _closing(db, user.id, id, "fd", body, renew_errors)
    old = closing.deposit
    reinvest = closing.amount if body.reinvest is None else body.reinvest
    assert body.interest_rate is not None and body.matures_on is not None  # checked above
    new = Account(
        user_id=user.id,
        type="fd",
        name=body.name or old.name,
        opening_balance=Decimal(0),  # the principal arrives by the transfer below
        institution=old.institution,
        interest_rate=body.interest_rate,
        opened_on=closing.date,
        matures_on=body.matures_on,
        fd_payout=body.fd_payout,
        pay_from_id=closing.bank.id,
    )
    db.add(new)
    db.flush()
    closing.rows.append(
        Transaction(
            user_id=user.id,
            type="transfer",
            account_id=closing.bank.id,
            to_account_id=new.id,
            amount=reinvest,
            date=closing.date,
            note=f"Renewed from {old.name}",
        )
    )
    _commit_close(db, user.id, closing)
    return account_response(db, user.id, new)


def _closing(
    db: Session,
    user_id: int,
    id: int,
    kind: str,
    body: CloseRd,
    errors: list[dict[str, Any]] | None = None,
) -> Closing:
    """Checks a close and builds its rows: interest (or a penalty) to bring the deposit to the
    amount received, then the payout to the bank. Locks the deposit and the bank."""
    what = kind.upper()
    accounts = lock_accounts(db, user_id, [id, body.account_id])
    deposit = accounts.get(id)
    if deposit is None or deposit.type != kind:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found.")
    if deposit.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"This {what} is already closed.")

    errors = list(errors or [])
    if body.amount is None:
        errors.append(field_error("amount", "Enter the amount received."))
    elif body.amount <= 0:
        errors.append(field_error("amount", "Amount must be greater than 0."))
    if body.date is None:
        errors.append(field_error("date", "Choose a date."))
    elif body.date > today_india():
        errors.append(field_error("date", "The date can't be in the future."))
    elif deposit.opened_on is not None and body.date < deposit.opened_on:
        errors.append(field_error("date", f"The date can't be before the {what} was opened."))
    else:
        latest = db.scalar(
            select(func.max(Transaction.date)).where(
                Transaction.user_id == user_id,
                or_(Transaction.account_id == deposit.id, Transaction.to_account_id == deposit.id),
            )
        )
        if latest is not None and body.date < latest:
            errors.append(
                field_error(
                    "date",
                    f"The {what} has transactions after this date. "
                    f"Choose {latest.isoformat()} or later.",
                )
            )
    bank = None if body.account_id is None else accounts.get(body.account_id)
    if bank is None or bank.type != "bank" or bank.archived_at is not None:
        errors.append(field_error("account_id", "Choose the bank the money goes to."))
    # The checks above already report each of these, so `errors` is never empty when one is None.
    if errors or body.amount is None or body.date is None or bank is None:
        raise RequestValidationError(errors)

    book = load_book(db, user_id)
    difference = body.amount - balance_of(deposit, book.flows)
    rows = [
        _row(
            user_id,
            "income",
            difference,
            deposit.id,
            body.date,
            INTEREST_CATEGORY,
            "Interest on closing",
        )
        if difference > 0
        else _row(
            user_id, "expense", -difference, deposit.id, body.date, FEE_CATEGORY, "Closed early"
        )
        if difference < 0
        else None,
        Transaction(
            user_id=user_id,
            type="transfer",
            account_id=deposit.id,
            to_account_id=bank.id,
            amount=body.amount,
            date=body.date,
            note=f"{what} closed",
        ),
    ]
    added = [r for r in rows if r is not None]
    before = load_movements(db, user_id)
    after = [
        *before,
        *(Movement(0, r.type, r.amount, r.account_id, r.to_account_id) for r in added),
    ]
    problem = balance_problem(accounts, before, after)
    if problem:
        raise RequestValidationError([field_error("amount", problem)])
    return Closing(deposit, bank, body.amount, body.date, added)


def _commit_close(db: Session, user_id: int, closing: Closing) -> AccountResponse:
    ensure_seeded(db, user_id)  # its categories are fixed ones, so the defaults have them
    db.add_all(closing.rows)
    closing.deposit.archived_at = datetime.now(UTC)
    db.commit()
    return account_response(db, user_id, closing.deposit)


def _row(
    user_id: int,
    type_: str,
    amount: Decimal,
    account_id: int,
    day: date,
    category: str,
    note: str,
) -> Transaction:
    return Transaction(
        user_id=user_id,
        type=type_,
        account_id=account_id,
        amount=amount,
        date=day,
        category=category,
        note=note,
    )
